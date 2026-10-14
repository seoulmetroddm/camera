/**
 * 화면 좌표와 원본 이미지 좌표를 오가는 변환.
 * 편집 결과(블러 영역·브러시 획)는 항상 "회전 전 원본 픽셀" 좌표로 저장한다.
 * 화면 크기는 기기마다 다르고 회전도 걸리기 때문에, 화면 좌표로 저장하면 나중에 위치가 어긋난다.
 */
export interface ViewTransform {
  /** 회전된 이미지 1px이 화면 몇 px인지 */
  scale: number;
  /** 화면상 이미지 좌상단 위치 */
  offsetX: number;
  offsetY: number;
  /** 0 / 90 / 180 / 270 */
  rotation: number;
  /** 화면에 보이는 영역의 회전 전 크기 (자른 상태면 자른 영역 크기) */
  imageWidth: number;
  imageHeight: number;
  /** 화면에 보이는 영역의 원본 기준 좌상단 (자른 상태면 자른 영역 위치, 아니면 0) */
  originX: number;
  originY: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 화면 좌표 → 회전 전 원본 이미지 좌표 */
export function screenToImage(t: ViewTransform, screenX: number, screenY: number): Point {
  const rx = (screenX - t.offsetX) / t.scale;
  const ry = (screenY - t.offsetY) / t.scale;

  let x: number;
  let y: number;
  switch (((t.rotation % 360) + 360) % 360) {
    case 90:
      x = ry;
      y = t.imageHeight - rx;
      break;
    case 180:
      x = t.imageWidth - rx;
      y = t.imageHeight - ry;
      break;
    case 270:
      x = t.imageWidth - ry;
      y = rx;
      break;
    default:
      x = rx;
      y = ry;
  }
  return { x: x + t.originX, y: y + t.originY };
}

/** 회전 전 원본 이미지 좌표 → 화면 좌표 */
export function imageToScreen(t: ViewTransform, imageX: number, imageY: number): Point {
  const x = imageX - t.originX;
  const y = imageY - t.originY;
  let rx: number;
  let ry: number;

  switch (((t.rotation % 360) + 360) % 360) {
    case 90:
      rx = t.imageHeight - y;
      ry = x;
      break;
    case 180:
      rx = t.imageWidth - x;
      ry = t.imageHeight - y;
      break;
    case 270:
      rx = y;
      ry = t.imageWidth - x;
      break;
    default:
      rx = x;
      ry = y;
  }

  return { x: t.offsetX + rx * t.scale, y: t.offsetY + ry * t.scale };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 두 점을 bounds(원본 좌표) 안의 사각형으로 정규화한다. */
export function normalizeRect(a: Point, b: Point, bounds: Bounds) {
  const x1 = clamp(Math.min(a.x, b.x), bounds.x, bounds.x + bounds.w);
  const y1 = clamp(Math.min(a.y, b.y), bounds.y, bounds.y + bounds.h);
  const x2 = clamp(Math.max(a.x, b.x), bounds.x, bounds.x + bounds.w);
  const y2 = clamp(Math.max(a.y, b.y), bounds.y, bounds.y + bounds.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
