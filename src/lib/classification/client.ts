import { loadModelBytes } from "../modelCache";
import { type CategoryScore, pickCategory, rankCategories } from "./categorize";
import { CLASSIFIER_MODEL } from "./models";

const WORKER_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/workers/classification.worker.js`;

interface WorkerRequest {
  id: number;
  size: number;
  mean: [number, number, number];
  std: [number, number, number];
  /** 워커에 세션이 이미 있으면 생략한다. */
  bytes?: ArrayBuffer;
  bitmap: ImageBitmap;
}

type WorkerResponse =
  | { id: number; type: "progress"; phase: "prepare" | "infer"; ratio: number }
  | { id: number; type: "done"; probabilities: Float32Array }
  | { id: number; type: "error"; message: string };

let worker: Worker | null = null;
let nextRequestId = 1;
let modelLoaded = false;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(WORKER_URL, { type: "module" });
  }
  return worker;
}

/** 1등 합산 확률이 이 아래면 확신이 없다고 보고 품목명을 자동으로 채우지 않는다. */
const MIN_SCORE = 0.2;
/** 1등이 2등보다 이 배수 이상 높아야 자동으로 채운다. 박빙이면 후보로만 보여준다. */
const MIN_LEAD = 1.3;
/** 후보 버튼으로 보여줄 최소 점수와 개수 */
const CANDIDATE_MIN_SCORE = 0.03;
const MAX_CANDIDATES = 3;
/** 가로세로 비율이 이보다 길쭉할 때만 '가운데 정사각형' 시점을 따로 본다. (거의 정사각형이면 전체 보기와 같다) */
const SQUARE_VIEW_MIN_ASPECT = 1.15;

/**
 * 사진을 보는 시점.
 * - full: 비율을 유지해 사진 전체를 넣고 남는 칸은 여백으로 채운다. 물건이 한쪽에 치우쳐도 잘리지 않는다.
 * - center: 가운데 정사각형을 scale 비율만큼 잘라 확대해 본다. 책상 위에 작게 찍힌 물건용이다.
 */
type View = { kind: "full" } | { kind: "center"; scale: number };

function viewsFor(image: ImageBitmap): View[] {
  const aspect = Math.max(image.width, image.height) / Math.min(image.width, image.height);
  const views: View[] = [{ kind: "full" }];
  if (aspect >= SQUARE_VIEW_MIN_ASPECT) views.push({ kind: "center", scale: 1 });
  views.push({ kind: "center", scale: 0.6 });
  return views;
}

/**
 * 원본을 시점에 맞춰 모델 입력 크기의 정사각형으로 만든다. flip이면 좌우를 뒤집는다.
 * 비율을 무시하고 눌러 넣으면 물체가 찌그러져 정확도가 떨어진다.
 * (원본 비트맵은 슬롯이 계속 쓰므로 넘기지 않고 사본을 만든다.)
 */
async function toViewBitmap(
  image: ImageBitmap,
  size: number,
  view: View,
  flip: boolean,
): Promise<ImageBitmap | null> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (flip) {
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
  }

  if (view.kind === "full") {
    // 여백은 정규화 평균색으로 채워 모델 입력에서 0이 되게 한다(물건으로 오인하지 않게).
    const [r, g, b] = CLASSIFIER_MODEL.mean.map((m) => Math.round(m * 255));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);
    const scale = size / Math.max(image.width, image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
  } else {
    const side = Math.min(image.width, image.height) * view.scale;
    const sx = (image.width - side) / 2;
    const sy = (image.height - side) / 2;
    ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size);
  }
  return createImageBitmap(canvas);
}

/** 잘라낸 사각형 한 장을 워커에 넘겨 1000개 클래스 확률을 받는다. 실패하면 null. */
function infer(bitmap: ImageBitmap, bytes?: ArrayBuffer): Promise<Float32Array | null> {
  const id = nextRequestId;
  nextRequestId += 1;
  const instance = getWorker();

  return new Promise((resolve) => {
    function cleanup() {
      instance.removeEventListener("message", handleMessage);
      instance.removeEventListener("error", handleError);
    }

    function handleMessage(event: MessageEvent<WorkerResponse>) {
      const message = event.data;
      if (message.id !== id || message.type === "progress") return;
      cleanup();
      if (message.type === "done") {
        modelLoaded = true;
        resolve(message.probabilities);
      } else {
        resolve(null);
      }
    }

    function handleError() {
      cleanup();
      resolve(null);
    }

    instance.addEventListener("message", handleMessage);
    instance.addEventListener("error", handleError);

    const request: WorkerRequest = {
      id,
      size: CLASSIFIER_MODEL.size,
      mean: CLASSIFIER_MODEL.mean,
      std: CLASSIFIER_MODEL.std,
      bytes,
      bitmap,
    };
    instance.postMessage(request, bytes ? [bitmap, bytes] : [bitmap]);
  });
}

/**
 * 시점별로 추론한다. 각 시점은 원본과 좌우 반전본을 평균낸다.
 * 반전 평균은 한 장만 볼 때 생기는 우연한 오답을 줄여준다. 한 장이라도 실패하면 null.
 */
async function inferViews(image: ImageBitmap): Promise<Float32Array[] | null> {
  // 모델 파일은 첫 요청에만 함께 보낸다. 그 뒤로는 워커가 세션을 들고 있다.
  let bytes: ArrayBuffer | undefined;
  if (!modelLoaded) {
    const data = await loadModelBytes(CLASSIFIER_MODEL.url, () => undefined);
    bytes = data.buffer as ArrayBuffer;
  }

  const results: Float32Array[] = [];
  for (const view of viewsFor(image)) {
    const pair: Float32Array[] = [];
    for (const flip of [false, true]) {
      const bitmap = await toViewBitmap(image, CLASSIFIER_MODEL.size, view, flip);
      if (!bitmap) return null;
      const probabilities = await infer(bitmap, bytes);
      bytes = undefined;
      if (!probabilities) return null;
      pair.push(probabilities);
    }
    const averaged = new Float32Array(pair[0].length);
    for (let i = 0; i < averaged.length; i += 1) averaged[i] = (pair[0][i] + pair[1][i]) / 2;
    results.push(averaged);
  }
  return results;
}

export interface ClassifyResult {
  /** 자동으로 채울 품목명. 애매하면 null */
  best: string | null;
  /** 사용자가 골라 쓸 수 있는 후보 (점수 높은 순, 최대 3개) */
  candidates: string[];
}

/**
 * 사진 속 물건의 큰 분류(가방/지갑/우산 등)를 추정한다.
 * 실패하면 null. 다루는 분류에 안 걸리면 best는 null이고 후보는 비어 있을 수 있다.
 */
export async function classifySubject(image: ImageBitmap): Promise<ClassifyResult | null> {
  const perView = await inferViews(image);
  if (!perView) return null;
  const ranked: CategoryScore[] = rankCategories(perView);
  return {
    best: pickCategory(ranked, MIN_SCORE, MIN_LEAD),
    candidates: ranked
      .filter((item) => item.score >= CANDIDATE_MIN_SCORE)
      .slice(0, MAX_CANDIDATES)
      .map((item) => item.category),
  };
}
