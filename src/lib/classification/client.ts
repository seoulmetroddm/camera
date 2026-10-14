import { loadModelBytes } from "../modelCache";
import { pickCategory, rankCategories } from "./categorize";
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
  | { id: number; type: "done"; embedding: Float32Array }
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

/**
 * 1등 확률이 이 아래면 확신이 없다고 보고 품목명을 자동으로 채우지 않는다.
 * 시험 사진 42장 기준으로 0.4에서 자동 채움 36장 정답 / 3장 오답이었다.
 */
const MIN_SCORE = 0.4;
/** 1등이 2등보다 이 배수 이상 높아야 자동으로 채운다. 박빙이면 후보로만 보여준다. */
const MIN_LEAD = 1.3;
/** 후보 버튼으로 보여줄 최소 확률과 개수 */
const CANDIDATE_MIN_SCORE = 0.05;
const MAX_CANDIDATES = 3;
/** 가로세로 비율이 이보다 길쭉할 때만 '사진 전체' 시점을 따로 본다. (거의 정사각형이면 가운데 보기와 같다) */
const FULL_VIEW_MIN_ASPECT = 1.15;

/**
 * 사진을 보는 시점.
 * - center: 가운데 정사각형. CLIP이 학습한 전처리(짧은 변 기준 가운데 자르기)와 같다.
 * - full: 비율을 유지해 사진 전체를 넣고 남는 칸은 여백으로 채운다. 물건이 한쪽에 치우쳐도 잘리지 않는다.
 * 두 시점의 벡터를 평균낸다. (시험에서 좌우 반전까지 더해도 정확도가 같아 뺐다. 휴대폰에서 시간이 두 배로 든다)
 */
type View = "center" | "full";

function viewsFor(image: ImageBitmap): View[] {
  const aspect = Math.max(image.width, image.height) / Math.min(image.width, image.height);
  return aspect >= FULL_VIEW_MIN_ASPECT ? ["full", "center"] : ["center"];
}

/**
 * 원본을 시점에 맞춰 모델 입력 크기의 정사각형으로 만든다.
 * (원본 비트맵은 슬롯이 계속 쓰므로 넘기지 않고 사본을 만든다.)
 */
async function toViewBitmap(image: ImageBitmap, size: number, view: View): Promise<ImageBitmap | null> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";

  if (view === "full") {
    // 여백은 정규화 평균색으로 채워 모델 입력에서 0이 되게 한다(물건으로 오인하지 않게).
    const [r, g, b] = CLASSIFIER_MODEL.mean.map((m) => Math.round(m * 255));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);
    const scale = size / Math.max(image.width, image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
  } else {
    const side = Math.min(image.width, image.height);
    const sx = (image.width - side) / 2;
    const sy = (image.height - side) / 2;
    ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size);
  }
  return createImageBitmap(canvas);
}

/** 정사각형 한 장을 워커에 넘겨 사진 벡터(길이 1)를 받는다. 실패하면 null. */
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
        resolve(message.embedding);
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

/** 시점별 벡터를 평균내 하나의 사진 벡터로 만든다. 한 장이라도 실패하면 null. */
async function embedImage(
  image: ImageBitmap,
  onDownload: (ratio: number) => void,
): Promise<Float32Array | null> {
  // 모델 파일은 첫 요청에만 함께 보낸다. 그 뒤로는 워커가 세션을 들고 있다.
  let bytes: ArrayBuffer | undefined;
  if (!modelLoaded) {
    const data = await loadModelBytes(CLASSIFIER_MODEL.url, onDownload);
    bytes = data.buffer as ArrayBuffer;
  }

  let sum: Float32Array | null = null;
  for (const view of viewsFor(image)) {
    const bitmap = await toViewBitmap(image, CLASSIFIER_MODEL.size, view);
    if (!bitmap) return null;
    const embedding = await infer(bitmap, bytes);
    bytes = undefined;
    if (!embedding) return null;
    if (!sum) sum = new Float32Array(embedding.length);
    for (let i = 0; i < embedding.length; i += 1) sum[i] += embedding[i];
  }
  if (!sum) return null;

  const norm = Math.hypot(...sum) || 1;
  return sum.map((v) => v / norm);
}

export interface ClassifyResult {
  /** 자동으로 채울 품목명. 애매하면 null */
  best: string | null;
  /** 사용자가 골라 쓸 수 있는 후보 (확률 높은 순, 최대 3개) */
  candidates: string[];
}

/** 모델이 크기 때문에 인식은 한 번에 하나씩만 한다. 연달아 찍어도 모델을 여러 번 내려받지 않는다. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * 사진 속 물건의 품목(가방/지갑/이어폰 등)을 추정한다.
 * onDownload는 모델을 처음 내려받는 동안 진행률(0~1)을 알려준다. 실패하면 null.
 */
export function classifySubject(
  image: ImageBitmap,
  onDownload: (ratio: number) => void = () => undefined,
): Promise<ClassifyResult | null> {
  const task = queue.then(async () => {
    const embedding = await embedImage(image, onDownload);
    if (!embedding) return null;
    const ranked = await rankCategories(embedding);
    return {
      best: pickCategory(ranked, MIN_SCORE, MIN_LEAD),
      candidates: ranked
        .filter((item) => item.score >= CANDIDATE_MIN_SCORE)
        .slice(0, MAX_CANDIDATES)
        .map((item) => item.category),
    };
  });
  queue = task.catch(() => undefined);
  return task;
}
