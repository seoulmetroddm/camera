// 배경 제거 추론 워커.
//
// 번들러를 거치지 않는 순수 ES 모듈 워커다. Next의 번들러가 워커를 어떻게 다루든
// 영향을 받지 않도록, onnxruntime 런타임을 우리 서버 경로에서 직접 불러온다.
// 모델 파일 다운로드와 캐싱은 메인 스레드가 맡고, 여기서는 세션 생성과 추론, 마스크 후처리를 한다.
//
// 절대경로("/ort/...")를 그대로 쓰면 GitHub Pages처럼 서브경로(/camera/)에 배포했을 때
// 어긋난다. 이 워커 스크립트 자신의 URL(self.location) 기준 상대경로로 계산하면
// 루트든 서브경로든 커스텀 도메인이든 다시 손댈 필요가 없다.
//
// 다만 이걸 위해 정적 import를 동적 import로 바꾸면 메시지 유실 위험이 생긴다.
// 정적 import였을 때는 브라우저가 모듈 그래프를 전부 불러온 뒤에야 이 스크립트를 실행하므로
// 그 사이 도착하는 메시지가 없었지만, 동적 import는 워커 스크립트가 즉시 실행을 시작하고
// import가 끝나기 전까지 self.onmessage가 비어있는 틈이 생긴다. 메인 스레드는 워커를 만들자마자
// postMessage를 보내므로, 리스너가 없는 채로 메시지가 도착하면 그냥 버려진다(재전달 안 됨).
// 그래서 무엇보다 먼저 리스너부터 등록해 메시지를 큐에 담아두고, 준비되면 순서대로 처리한다.
const pendingEvents = [];
self.onmessage = (event) => {
  pendingEvents.push(event);
};

const ortBaseUrl = new URL("../ort/", self.location.href).href;
const ort = await import(`${ortBaseUrl}ort.wasm.bundle.min.mjs`);

// wasm 바이너리도 같은 경로에서 받는다. (외부 CDN 사용 안 함)
ort.env.wasm.wasmPaths = ortBaseUrl;
// wasm 멀티스레드는 cross-origin isolation(COOP/COEP)이 있어야 쓸 수 있다.
// 헤더가 없는 일반 정적 호스팅에서는 1로 떨어지고, 헤더를 켜두면 그만큼 빨라진다.
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

/** @type {Map<string, import("onnxruntime-web").InferenceSession>} */
const sessions = new Map();

// ── 후처리 파라미터 ──────────────────────────────────────────────
/** 이 값보다 확률이 높으면 피사체 덩어리의 일부로 본다. (떨어진 조각 판정용) */
const ISLAND_THRESHOLD = 0.1;
/** 가장 큰 덩어리 대비 이 비율보다 작은 덩어리는 잡티로 보고 지운다. */
const KEEP_ISLAND_RATIO = 0.15;
/** 이 값보다 확률이 낮으면 배경(구멍 후보)으로 본다. */
const HOLE_THRESHOLD = 0.5;
/** 전체 면적 대비 이 비율보다 작은 구멍만 메운다. 컵 손잡이 안쪽 같은 진짜 구멍은 남긴다. */
const HOLE_MAX_RATIO = 0.002;
/** 가이드 필터 정규화 값. 작을수록 원본 사진의 윤곽을 더 강하게 따른다. */
const GUIDED_EPS = 1e-3;

/**
 * 이미지를 모델 입력 텐서로 바꾼다.
 * 정사각형으로 찌그러뜨리지 않고 비율을 유지한 채 가운데 놓고, 남는 곳은 평균색으로 채운다(정규화하면 0).
 * 결과 마스크에서 사진이 놓였던 영역(content)만 다시 잘라 쓴다.
 */
function preprocess(bitmap, size, mean, std) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("작업용 캔버스를 만들지 못했습니다.");

  const scale = Math.min(size / bitmap.width, size / bitmap.height);
  const w = Math.max(1, Math.min(size, Math.round(bitmap.width * scale)));
  const h = Math.max(1, Math.min(size, Math.round(bitmap.height * scale)));
  const x = Math.floor((size - w) / 2);
  const y = Math.floor((size - h) / 2);

  context.fillStyle = `rgb(${mean.map((m) => Math.round(m * 255)).join(",")})`;
  context.fillRect(0, 0, size, size);
  context.drawImage(bitmap, x, y, w, h);
  const { data } = context.getImageData(0, 0, size, size);

  const pixels = size * size;
  const input = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    input[i] = (data[offset] / 255 - mean[0]) / std[0];
    input[pixels + i] = (data[offset + 1] / 255 - mean[1]) / std[1];
    input[pixels * 2 + i] = (data[offset + 2] / 255 - mean[2]) / std[2];
  }

  return {
    tensor: new ort.Tensor("float32", input, [1, 3, size, size]),
    content: { x, y, w, h },
  };
}

/**
 * 모델 출력에서 사진이 놓였던 영역만 잘라 0~1 확률로 정규화한다.
 * 출력은 0~1로 딱 떨어지지 않으므로 최솟값~최댓값으로 늘린다. 여백 부분은 계산에서 뺀다.
 */
function extractAlpha(output, size, content) {
  const values = output.data;
  const dims = output.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  const sx = width / size;
  const sy = height / size;

  const x0 = Math.floor(content.x * sx);
  const y0 = Math.floor(content.y * sy);
  const w = Math.max(1, Math.min(width - x0, Math.round(content.w * sx)));
  const h = Math.max(1, Math.min(height - y0, Math.round(content.h * sy)));

  const alpha = new Float32Array(w * h);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = values[(y0 + y) * width + x0 + x];
      alpha[y * w + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const range = max - min || 1;
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = (alpha[i] - min) / range;

  return { alpha, w, h };
}

/** inside(i)가 참인 픽셀들을 4방향으로 이어진 덩어리로 나눈다. */
function labelRegions(w, h, inside) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const areas = [];
  const touchesBorder = [];

  for (let start = 0; start < w * h; start += 1) {
    if (labels[start] !== -1 || !inside(start)) continue;
    const label = areas.length;
    let area = 0;
    let border = false;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;

    while (top > 0) {
      const i = stack[--top];
      area += 1;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && labels[i - 1] === -1 && inside(i - 1)) {
        labels[i - 1] = label;
        stack[top++] = i - 1;
      }
      if (x < w - 1 && labels[i + 1] === -1 && inside(i + 1)) {
        labels[i + 1] = label;
        stack[top++] = i + 1;
      }
      if (y > 0 && labels[i - w] === -1 && inside(i - w)) {
        labels[i - w] = label;
        stack[top++] = i - w;
      }
      if (y < h - 1 && labels[i + w] === -1 && inside(i + w)) {
        labels[i + w] = label;
        stack[top++] = i + w;
      }
    }
    areas.push(area);
    touchesBorder.push(border);
  }

  return { labels, areas, touchesBorder };
}

/** 피사체에서 떨어져 나온 작은 얼룩을 지운다. 신발 한 켤레처럼 큰 덩어리가 여럿이면 모두 남긴다. */
function removeSmallIslands(alpha, w, h) {
  const { labels, areas } = labelRegions(w, h, (i) => alpha[i] > ISLAND_THRESHOLD);
  if (areas.length <= 1) return;
  const largest = Math.max(...areas);
  for (let i = 0; i < alpha.length; i += 1) {
    const label = labels[i];
    if (label !== -1 && areas[label] < largest * KEEP_ISLAND_RATIO) alpha[i] = 0;
  }
}

/** 피사체 안쪽에 생긴 작은 구멍(가장자리에 닿지 않는 작은 배경 덩어리)을 메운다. */
function fillSmallHoles(alpha, w, h) {
  const { labels, areas, touchesBorder } = labelRegions(w, h, (i) => alpha[i] < HOLE_THRESHOLD);
  const maxArea = w * h * HOLE_MAX_RATIO;
  for (let i = 0; i < alpha.length; i += 1) {
    const label = labels[i];
    if (label !== -1 && !touchesBorder[label] && areas[label] <= maxArea) alpha[i] = 1;
  }
}

/** 픽셀 중심 기준 양선형 보간 확대 */
function resizeBilinear(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const rx = sw / dw;
  const ry = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * ry - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x += 1) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * rx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const bottom = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 원본 사진을 0~1 밝기 배열로 바꾼다. 가이드 필터의 기준 영상이다. */
function toGray(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("작업용 캔버스를 만들지 못했습니다.");
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const gray = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0; i < gray.length; i += 1) {
    const o = i * 4;
    gray[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  }
  return gray;
}

/** 반지름 r 정사각형 창의 평균. 적분 영상으로 계산해 r에 상관없이 O(픽셀 수)다. 가장자리는 창 안의 픽셀만 센다. */
function boxMean(src, w, h, r) {
  const stride = w + 1;
  const integral = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < w; x += 1) {
      rowSum += src[y * w + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x += 1) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w, x + r + 1);
      const sum =
        integral[yb * stride + xb] -
        integral[ya * stride + xb] -
        integral[yb * stride + xa] +
        integral[ya * stride + xa];
      out[y * w + x] = sum / ((yb - ya) * (xb - xa));
    }
  }
  return out;
}

/**
 * 가이드 필터(He et al.). 저해상도에서 늘린 흐릿한 마스크 경계를 원본 사진의 실제 윤곽선에 붙인다.
 * 사진이 평평한 곳에서는 마스크를 그대로 두고, 사진에 윤곽이 있는 곳에서만 경계를 그쪽으로 당긴다.
 */
function guidedFilter(guide, p, w, h, r, eps) {
  const n = w * h;
  const ip = new Float32Array(n);
  const ii = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    ip[i] = guide[i] * p[i];
    ii[i] = guide[i] * guide[i];
  }
  const meanI = boxMean(guide, w, h, r);
  const meanP = boxMean(p, w, h, r);
  const corrIp = boxMean(ip, w, h, r);
  const corrIi = boxMean(ii, w, h, r);

  // 메모리를 아끼려고 더 쓰지 않는 배열을 a, b로 재사용한다.
  const a = ip;
  const b = ii;
  for (let i = 0; i < n; i += 1) {
    const varI = corrIi[i] - meanI[i] * meanI[i];
    const covIp = corrIp[i] - meanI[i] * meanP[i];
    a[i] = covIp / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxMean(a, w, h, r);
  const meanB = boxMean(b, w, h, r);

  const q = new Float32Array(n);
  for (let i = 0; i < n; i += 1) q[i] = meanA[i] * guide[i] + meanB[i];
  return q;
}

/**
 * 모델 출력을 최종 알파 마스크로 다듬는다.
 * 1) 모델 해상도에서 잡티 제거·작은 구멍 메우기
 * 2) 원본(guide) 해상도로 확대 — 이때 경계는 흐릿하고 실제 윤곽과 몇 px 어긋나 있다
 * 3) 흐릿한 상태 그대로 가이드 필터를 걸어 원본 윤곽 쪽으로 당긴다
 *    (먼저 날카롭게 만들면 필터 창 안에 실제 윤곽이 안 들어와 위치를 못 고친다)
 * 4) 마지막에 경계 대비를 올려 번짐과 반투명 얼룩을 정리한다
 */
function refineMask(raw, guide) {
  removeSmallIslands(raw.alpha, raw.w, raw.h);
  fillSmallHoles(raw.alpha, raw.w, raw.h);

  const w = guide.width;
  const h = guide.height;
  const alpha = resizeBilinear(raw.alpha, raw.w, raw.h, w, h);

  // 1024px 기준 반지름 약 21px. 저해상도 모델(320px)의 경계 오차를 덮을 만큼 넓게 잡는다.
  const radius = Math.max(4, Math.round(Math.max(w, h) / 48));
  const refined = guidedFilter(toGray(guide), alpha, w, h, radius, GUIDED_EPS);

  for (let i = 0; i < refined.length; i += 1) refined[i] = smoothstep(0.15, 0.85, refined[i]);
  return { alpha: refined, w, h };
}

/** 0~1 알파 배열을 마스크 이미지로 만든다. 알파에 담아야 destination-in 합성으로 바로 오려낼 수 있다. */
function toMaskBitmap({ alpha, w, h }) {
  const image = new ImageData(w, h);
  for (let i = 0; i < w * h; i += 1) {
    const offset = i * 4;
    image.data[offset] = 255;
    image.data[offset + 1] = 255;
    image.data[offset + 2] = 255;
    image.data[offset + 3] = Math.round(alpha[i] * 255);
  }
  return createImageBitmap(image);
}

async function getSession(modelKey, bytes) {
  const existing = sessions.get(modelKey);
  if (existing) return existing;
  if (!bytes) throw new Error("모델 데이터가 전달되지 않았습니다.");

  const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  sessions.set(modelKey, session);
  return session;
}

async function handleMessage(event) {
  const { id, modelKey, size, mean, std, bytes, bitmap, guide } = event.data;

  try {
    self.postMessage({ id, type: "progress", phase: "prepare", ratio: 1 });
    const session = await getSession(modelKey, bytes);

    self.postMessage({ id, type: "progress", phase: "infer", ratio: 0 });
    const { tensor, content } = preprocess(bitmap, size, mean, std);

    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    const raw = extractAlpha(outputs[session.outputNames[0]], size, content);
    const mask = await toMaskBitmap(refineMask(raw, guide));

    self.postMessage({ id, type: "done", mask }, [mask]);
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : "배경 제거에 실패했습니다.",
    });
  } finally {
    bitmap.close();
    guide.close();
  }
}

// 이제부터는 실제 처리 핸들러로 바로 받고, 그동안 큐에 쌓인 메시지도 도착한 순서대로 처리한다.
self.onmessage = (event) => {
  void handleMessage(event);
};
for (const event of pendingEvents) {
  void handleMessage(event);
}
