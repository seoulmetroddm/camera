import type { BlurRegion } from "@/types";
import { context2d, createCanvas } from "./util";

/**
 * 블러 결과 캐시. 편집 화면은 브러시 획마다 슬롯 전체를 다시 렌더하므로,
 * 영역이 바뀌지 않았으면 이전 결과를 그대로 붙여 넣는다.
 * 원본 이미지별로 최근 몇 개만 들고 있고, 이미지가 사라지면 함께 정리된다.
 */
const blurCache = new WeakMap<object, Map<string, ImageData>>();
const MAX_CACHE_PER_IMAGE = 8;

/** 이보다 강한 블러는 이미지를 줄여서 계산한다. */
const MAX_DIRECT_SIGMA = 8;

/**
 * 지정된 영역들을 픽셀 단위로 뭉갠다. 화면 오버레이가 아니라 실제 파괴적 처리다.
 * cacheKey에는 ctx에 그려진 원본(슬롯 이미지)을 넘긴다. 같은 원본·같은 영역이면 블러를 다시 계산하지 않는다.
 */
export function applyBlurRegions(
  ctx: CanvasRenderingContext2D,
  regions: BlurRegion[],
  cacheKey?: object,
) {
  regions.forEach((region, index) => {
    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));
    const w = Math.min(ctx.canvas.width - x, Math.ceil(region.w));
    const h = Math.min(ctx.canvas.height - y, Math.ceil(region.h));
    if (w <= 1 || h <= 1) return;

    const strength = Math.min(10, Math.max(1, region.strength));
    if (region.type === "mosaic") {
      applyMosaic(ctx, x, y, w, h, strength);
      return;
    }

    // 겹친 영역은 앞서 처리된 결과 위에 다시 뭉개지므로, 이 영역까지의 목록 전체를 키로 쓴다.
    const key = cacheKey ? JSON.stringify(regions.slice(0, index + 1)) : null;
    const cache = cacheKey ? (blurCache.get(cacheKey) ?? new Map<string, ImageData>()) : null;
    const cached = key ? cache?.get(key) : undefined;
    if (cached) {
      ctx.putImageData(cached, x, y);
      return;
    }

    const result = applyBlur(ctx, x, y, w, h, strength);
    if (cacheKey && cache && key) {
      cache.set(key, result);
      if (cache.size > MAX_CACHE_PER_IMAGE) cache.delete(cache.keys().next().value!);
      blurCache.set(cacheKey, cache);
    }
  });
}

function applyMosaic(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  strength: number,
) {
  const block = Math.max(2, Math.round((Math.min(w, h) * strength) / 40));
  const sw = Math.max(1, Math.round(w / block));
  const sh = Math.max(1, Math.round(h / block));

  // 축소했다가 보간 없이 확대하면 원래 픽셀을 되살릴 수 없다.
  const small = createCanvas(sw, sh);
  const sctx = context2d(small);
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, sw, sh);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, sw, sh, x, y, w, h);
  ctx.restore();
}

/**
 * 가우시안 블러를 자바스크립트로 직접 계산한다.
 * 캔버스 filter는 기기·브라우저마다 지원이 달라(구형 iOS 사파리, 일부 앱 내 브라우저)
 * 블러가 아예 안 걸리고 원본이 그대로 남을 수 있다. 픽셀을 직접 계산하면 어디서나 같은 결과가 나온다.
 * 처리한 영역의 픽셀(ImageData)을 돌려준다. 캐시용이다.
 */
function applyBlur(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  strength: number,
): ImageData {
  const sigma = Math.max(3, Math.round((Math.min(w, h) * strength) / 40));
  // 경계에서 바깥 픽셀을 끌어와야 테두리가 밝아지지 않는다. 가우시안은 3σ 밖이 거의 0이다.
  const pad = sigma * 3;
  const sx = Math.max(0, x - pad);
  const sy = Math.max(0, y - pad);
  const ex = Math.min(ctx.canvas.width, x + w + pad);
  const ey = Math.min(ctx.canvas.height, y + h + pad);
  const sw = ex - sx;
  const sh = ey - sy;

  if (sigma <= MAX_DIRECT_SIGMA) {
    const patch = ctx.getImageData(sx, sy, sw, sh);
    gaussianBlurRGBA(patch.data, sw, sh, sigma);
    // 여백까지 뭉갠 패치 중 실제 영역만 되돌려 쓴다.
    ctx.putImageData(patch, sx, sy, x - sx, y - sy, w, h);
    return ctx.getImageData(x, y, w, h);
  }

  // 강한 블러는 세밀한 부분이 어차피 다 사라지므로 줄인 뒤 블러하고 다시 늘려도 결과가 같다.
  // 사진 전체를 가장 세게 뭉갤 때 수 초 걸리던 것이 수십 ms로 줄어든다.
  const factor = sigma / MAX_DIRECT_SIGMA;
  const small = createCanvas(sw / factor, sh / factor);
  const sctx = context2d(small);
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, small.width, small.height);
  const data = sctx.getImageData(0, 0, small.width, small.height);
  gaussianBlurRGBA(data.data, small.width, small.height, MAX_DIRECT_SIGMA);
  sctx.putImageData(data, 0, 0);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, sx, sy, sw, sh);
  ctx.restore();
  return ctx.getImageData(x, y, w, h);
}

/**
 * 상자 블러 3번으로 가우시안을 근사한다(중심극한정리). 반지름에 상관없이 픽셀 수에 비례하는 시간이 든다.
 * 참고: Ivan Kutskir, "Fastest Gaussian Blur (in linear time)"
 */
function gaussianBlurRGBA(data: Uint8ClampedArray, w: number, h: number, sigma: number) {
  const temp = new Uint8ClampedArray(data.length);
  for (const size of boxSizesForGauss(sigma, 3)) {
    const r = (size - 1) / 2;
    boxBlurH(data, temp, w, h, r);
    boxBlurV(temp, data, w, h, r);
  }
}

/** 가우시안 σ에 가장 가까운 상자 크기 n개 (모두 홀수) */
function boxSizesForGauss(sigma: number, n: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) / (-4 * lower - 4),
  );
  return Array.from({ length: n }, (_, i) => (i < m ? lower : upper));
}

/** 가로 방향 상자 블러. 가장자리 밖은 가장자리 픽셀이 이어진다고 본다. */
function boxBlurH(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number) {
  const div = 2 * r + 1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w * 4;
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) sum += src[row + Math.min(w - 1, Math.max(0, k)) * 4 + c];
      for (let x = 0; x < w; x += 1) {
        dst[row + x * 4 + c] = sum / div;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        sum += src[row + add * 4 + c] - src[row + sub * 4 + c];
      }
    }
  }
}

/** 세로 방향 상자 블러 */
function boxBlurV(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number) {
  const div = 2 * r + 1;
  const stride = w * 4;
  for (let x = 0; x < w; x += 1) {
    for (let c = 0; c < 4; c += 1) {
      const col = x * 4 + c;
      let sum = 0;
      for (let k = -r; k <= r; k += 1) sum += src[Math.min(h - 1, Math.max(0, k)) * stride + col];
      for (let y = 0; y < h; y += 1) {
        dst[y * stride + col] = sum / div;
        const add = Math.min(h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        sum += src[add * stride + col] - src[sub * stride + col];
      }
    }
  }
}
