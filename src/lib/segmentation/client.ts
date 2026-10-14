import type { CropRect } from "@/types";
import { context2d, createCanvas } from "../canvas/util";
import { loadModelBytes } from "../modelCache";
import { MODELS, type ModelId } from "./models";

/**
 * 마스크 해상도. 원본만큼 크게 잡으면 보정용 스냅샷까지 겹쳐 모바일 메모리가 감당되지 않는다.
 * 최종 합성 때 원본 크기로 늘려 쓰므로 이 정도면 충분하다.
 */
const MASK_MAX_SIZE = 1024;

const WORKER_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/workers/segmentation.worker.js`;

export interface SegmentationProgress {
  phase: "download" | "prepare" | "infer";
  ratio: number;
}

interface WorkerRequest {
  id: number;
  modelKey: ModelId;
  size: number;
  mean: [number, number, number];
  std: [number, number, number];
  /** 워커에 세션이 없을 때만 함께 보낸다. */
  bytes?: ArrayBuffer;
  /** 모델 입력용. 비율을 유지한 채 긴 변을 모델 입력 크기에 맞춘다. */
  bitmap: ImageBitmap;
  /** 경계 다듬기(가이드 필터)용 원본. 마스크 해상도와 같은 크기다. */
  guide: ImageBitmap;
}

type WorkerResponse =
  | { id: number; type: "progress"; phase: "prepare" | "infer"; ratio: number }
  | { id: number; type: "done"; mask: ImageBitmap }
  | { id: number; type: "error"; message: string };

let worker: Worker | null = null;
let nextRequestId = 1;
/** 워커에 이미 넘겨서 세션이 만들어진 모델들 */
const loadedModels = new Set<ModelId>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(WORKER_URL, { type: "module" });
  }
  return worker;
}

/**
 * 배경 제거 마스크를 만든다. 원본 픽셀은 건드리지 않고 알파 마스크만 돌려준다.
 * region을 주면 그 영역(자른 영역)만 모델에 넣는다. 피사체가 모델 입력에서 크게 잡혀 경계가 더 정확해지고,
 * 돌려주는 마스크도 그 영역만 덮는다.
 */
export async function createBackgroundMask(
  image: ImageBitmap,
  modelId: ModelId,
  onProgress: (progress: SegmentationProgress) => void,
  region: CropRect = { x: 0, y: 0, w: image.width, h: image.height },
): Promise<HTMLCanvasElement> {
  const spec = MODELS[modelId];

  // 모델 파일은 메인 스레드에서 받아 캐시에 넣는다. 워커에는 한 번만 넘긴다.
  let bytes: ArrayBuffer | undefined;
  if (!loadedModels.has(modelId)) {
    onProgress({ phase: "download", ratio: 0 });
    const data = await loadModelBytes(spec.url, (ratio) => {
      onProgress({ phase: "download", ratio });
    });
    bytes = data.buffer as ArrayBuffer;
  }

  // 모델 입력 크기로 미리 줄여서 보낸다. 원본을 통째로 넘기면 전송·메모리가 낭비된다.
  // 정사각형으로 찌그러뜨리지 않고 비율을 유지한다. 남는 칸은 워커가 여백으로 채운다.
  const bitmap = await cropToBitmap(image, region, spec.size / Math.max(region.w, region.h));
  // 마스크 해상도의 원본. 워커가 이 사진의 윤곽선을 따라 마스크 경계를 다듬는다.
  const guide = await cropToBitmap(image, region, Math.min(1, MASK_MAX_SIZE / Math.max(region.w, region.h)));

  const id = nextRequestId;
  nextRequestId += 1;
  const instance = getWorker();

  const mask = await new Promise<ImageBitmap>((resolve, reject) => {
    function cleanup() {
      instance.removeEventListener("message", handleMessage);
      instance.removeEventListener("error", handleError);
    }

    function handleMessage(event: MessageEvent<WorkerResponse>) {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === "progress") {
        onProgress({ phase: message.phase, ratio: message.ratio });
        return;
      }
      cleanup();
      if (message.type === "done") {
        loadedModels.add(modelId);
        resolve(message.mask);
      } else {
        reject(new Error(message.message));
      }
    }

    function handleError() {
      cleanup();
      reject(new Error("배경 제거 모듈을 불러오지 못했습니다."));
    }

    instance.addEventListener("message", handleMessage);
    instance.addEventListener("error", handleError);

    const request: WorkerRequest = {
      id,
      modelKey: modelId,
      size: spec.size,
      mean: spec.mean,
      std: spec.std,
      bytes,
      bitmap,
      guide,
    };
    // 큰 데이터는 복사하지 않고 소유권째 넘긴다.
    instance.postMessage(request, bytes ? [bitmap, guide, bytes] : [bitmap, guide]);
  });

  return toMaskCanvas(mask);
}

/** 원본에서 region을 잘라 scale배로 줄인 비트맵을 만든다. */
async function cropToBitmap(image: ImageBitmap, region: CropRect, scale: number): Promise<ImageBitmap> {
  const canvas = createCanvas(region.w * scale, region.h * scale);
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  return createImageBitmap(canvas);
}

/** 워커가 돌려준 마스크(이미 guide와 같은 크기)를 브러시로 고칠 수 있는 캔버스로 옮긴다. */
function toMaskCanvas(mask: ImageBitmap): HTMLCanvasElement {
  const canvas = createCanvas(mask.width, mask.height);
  context2d(canvas).drawImage(mask, 0, 0);
  mask.close();
  return canvas;
}
