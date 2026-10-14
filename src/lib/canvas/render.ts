import type { BackgroundMode, LayoutSpec, Slot } from "@/types";
import { applyBlurRegions } from "./blur";
import { context2d, createCanvas, drawContained, rotateCanvas } from "./util";

/**
 * 슬롯 하나를 최종 픽셀로 렌더한다.
 * 순서: 원본 → 개인정보 뭉개기 → 배경 제거 마스크 → 자르기 → 배경 채우기 → 회전
 * 블러 영역·마스크·자르기 영역은 모두 회전 전 원본 좌표계 기준이라 회전은 맨 마지막이다.
 *
 * 편집 화면에서는 applyCrop을 꺼서 사진 전체를 보여준다. 잘린 화면을 보여주면
 * 화면 좌표와 원본 좌표의 대응이 어긋나 편집 위치가 틀어지기 때문이다.
 */
export function renderSlot(
  slot: Slot,
  background: BackgroundMode,
  options: { applyCrop?: boolean } = {},
): HTMLCanvasElement | null {
  if (!slot.image) return null;
  const applyCrop = options.applyCrop ?? true;

  const canvas = createCanvas(slot.width, slot.height);
  const ctx = context2d(canvas);
  ctx.drawImage(slot.image, 0, 0);

  applyBlurRegions(ctx, slot.blurRegions);

  if (slot.mask) {
    // 마스크 영역 바깥은 그려지지 않으므로 destination-in에 의해 투명해진다.
    const area = slot.maskRect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(slot.mask, area.x, area.y, area.w, area.h);
    ctx.globalCompositeOperation = "source-over";
  }

  let result = canvas;
  if (applyCrop && slot.crop) {
    const { x, y, w, h } = slot.crop;
    result = createCanvas(w, h);
    context2d(result).drawImage(canvas, x, y, w, h, 0, 0, result.width, result.height);
  }

  if (background === "white") {
    const target = context2d(result);
    target.globalCompositeOperation = "destination-over";
    target.fillStyle = "#ffffff";
    target.fillRect(0, 0, result.width, result.height);
    target.globalCompositeOperation = "source-over";
  }

  return rotateCanvas(result, slot.rotation);
}

export interface ComposeOptions {
  layout: LayoutSpec;
  /** 슬롯 순서대로 렌더된 캔버스. 빈 칸은 null */
  cells: (HTMLCanvasElement | null)[];
  background: BackgroundMode;
  /** 칸 하나의 한 변 길이(px) */
  cellSize?: number;
  gap?: number;
  padding?: number;
  /** 칸 사이에 구분선을 그릴지 */
  divider?: boolean;
}

/** 여러 장을 선택한 배치대로 한 장에 합성한다. */
export function composeGrid(options: ComposeOptions): HTMLCanvasElement {
  const { layout, cells, background } = options;
  const cellSize = options.cellSize ?? 1200;
  const gap = options.gap ?? 24;
  const padding = options.padding ?? 24;

  // 1x1은 격자에 맞출 이유가 없으므로 원본 비율 그대로 내보낸다.
  if (layout.rows === 1 && layout.cols === 1) {
    const cell = cells[0];
    if (!cell) return fillBackground(createCanvas(cellSize, cellSize), background);
    const canvas = createCanvas(cell.width + padding * 2, cell.height + padding * 2);
    const ctx = context2d(fillBackground(canvas, background));
    ctx.drawImage(cell, padding, padding);
    return canvas;
  }

  const width = padding * 2 + layout.cols * cellSize + (layout.cols - 1) * gap;
  const height = padding * 2 + layout.rows * cellSize + (layout.rows - 1) * gap;
  const canvas = createCanvas(width, height);
  const ctx = context2d(fillBackground(canvas, background));

  if (options.divider) {
    drawDividers(ctx, layout, cellSize, gap, padding, width, height);
  }

  cells.slice(0, layout.rows * layout.cols).forEach((cell, index) => {
    if (!cell) return;
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    const x = padding + col * (cellSize + gap);
    const y = padding + row * (cellSize + gap);
    drawContained(ctx, cell, x, y, cellSize, cellSize);
  });

  return canvas;
}

function drawDividers(
  ctx: CanvasRenderingContext2D,
  layout: LayoutSpec,
  cellSize: number,
  gap: number,
  padding: number,
  width: number,
  height: number,
) {
  ctx.save();
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = Math.max(2, Math.round(gap / 8));

  for (let col = 1; col < layout.cols; col += 1) {
    const x = padding + col * cellSize + (col - 0.5) * gap;
    ctx.beginPath();
    ctx.moveTo(x, padding);
    ctx.lineTo(x, height - padding);
    ctx.stroke();
  }
  for (let row = 1; row < layout.rows; row += 1) {
    const y = padding + row * cellSize + (row - 0.5) * gap;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }
  ctx.restore();
}

function fillBackground(canvas: HTMLCanvasElement, background: BackgroundMode): HTMLCanvasElement {
  if (background === "white") {
    const ctx = context2d(canvas);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}
