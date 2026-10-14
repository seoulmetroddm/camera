// 품목 인식(CLIP 이미지 모델) 추론 워커. segmentation.worker.js와 같은 얼개를 쓴다.
// (정적 import로 등록 순서를 지키는 이유 등은 그쪽 주석 참고)
const pendingEvents = [];
self.onmessage = (event) => {
  pendingEvents.push(event);
};

const ortBaseUrl = new URL("../ort/", self.location.href).href;
const ort = await import(`${ortBaseUrl}ort.wasm.bundle.min.mjs`);

ort.env.wasm.wasmPaths = ortBaseUrl;
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

let session = null;

function preprocess(bitmap, size, mean, std) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("작업용 캔버스를 만들지 못했습니다.");

  // 넘어온 비트맵은 이미 정사각형으로 맞춰져 있다 (client.ts에서 시점별로 잘라 보낸다).
  context.drawImage(bitmap, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);

  const pixels = size * size;
  const input = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    input[i] = (data[offset] / 255 - mean[0]) / std[0];
    input[pixels + i] = (data[offset + 1] / 255 - mean[1]) / std[1];
    input[pixels * 2 + i] = (data[offset + 2] / 255 - mean[2]) / std[2];
  }

  return new ort.Tensor("float32", input, [1, 3, size, size]);
}

/** 길이 1로 정규화한다. 품목 설명 벡터와 내적하면 곧 코사인 유사도가 된다. */
function normalize(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i] * values[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = values[i] / norm;
  return out;
}

async function getSession(bytes) {
  if (session) return session;
  if (!bytes) throw new Error("모델 데이터가 전달되지 않았습니다.");
  session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return session;
}

async function handleMessage(event) {
  const { id, size, mean, std, bytes, bitmap } = event.data;

  try {
    self.postMessage({ id, type: "progress", phase: "prepare", ratio: 1 });
    const activeSession = await getSession(bytes);

    self.postMessage({ id, type: "progress", phase: "infer", ratio: 0 });
    const tensor = preprocess(bitmap, size, mean, std);
    bitmap.close();

    const outputs = await activeSession.run({ [activeSession.inputNames[0]]: tensor });
    // CLIP 이미지 모델의 출력 이름은 image_embeds다. 다른 이름이면 첫 출력을 쓴다.
    const name = activeSession.outputNames.includes("image_embeds")
      ? "image_embeds"
      : activeSession.outputNames[0];
    const embedding = normalize(outputs[name].data);

    self.postMessage({ id, type: "done", embedding }, [embedding.buffer]);
  } catch (error) {
    bitmap.close();
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : "물건 인식에 실패했습니다.",
    });
  }
}

self.onmessage = (event) => {
  void handleMessage(event);
};
for (const event of pendingEvents) {
  void handleMessage(event);
}
