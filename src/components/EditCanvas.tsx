"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { clamp, type Point, screenToImage, type ViewTransform } from "@/lib/canvas/coords";
import { renderSlot } from "@/lib/canvas/render";
import { context2d } from "@/lib/canvas/util";
import type { Slot } from "@/types";

/** 화면에 꽉 맞춘 크기 대비 최대 확대 배율 */
const MAX_ZOOM = 8;
/** 확대 상태에서 이미지 가장자리를 손가락으로 다듬을 수 있도록 남겨두는 여백(px) */
const PAN_MARGIN = 48;
/** 확대/축소 버튼 한 번에 바뀌는 배율 */
const ZOOM_STEP = 1.5;

interface Props {
  slot: Slot;
  /** true면 자른 영역만 보여준다. 자르기 탭에서는 영역을 다시 고를 수 있게 false로 사진 전체를 보여준다. */
  applyCrop?: boolean;
  cursor?: string;
  /** 포인터 좌표는 회전 전 원본 이미지 좌표로 변환되어 전달된다. */
  onPointerDown?: (point: Point) => void;
  onPointerMove?: (point: Point) => void;
  onPointerUp?: (point: Point) => void;
  /** 한 손가락으로 그리던 중 두 번째 손가락이 닿아 확대/이동 제스처로 바뀔 때 호출된다. 그리던 내용을 취소하는 데 쓴다. */
  onGestureStart?: () => void;
  /** true면 한 손가락(마우스) 드래그로 화면을 이동한다. 그릴 것이 없는 상태에서 쓴다. */
  panWithSinglePointer?: boolean;
  /** 캔버스 위에 겹칠 요소. 컨테이너 기준 절대 위치를 쓴다. */
  renderOverlay?: (transform: ViewTransform) => React.ReactNode;
}

export interface EditCanvasHandle {
  /** slot.mask 캔버스를 직접 mutate한 뒤(브러시 보정) 화면을 즉시 다시 그릴 때 쓴다. */
  redraw: () => void;
  /** 현재 화면 변환. 브러시 크기를 화면 px → 원본 px로 바꿀 때 쓴다. */
  getTransform: () => ViewTransform | null;
}

interface View {
  zoom: number;
  /** 화면 중앙 정렬 위치에서 얼마나 옮겼는지(px) */
  panX: number;
  panY: number;
}

interface Pinch {
  startDistance: number;
  startZoom: number;
  /** 제스처 시작 시 두 손가락 중점 아래에 있던 (회전된) 이미지 좌표 */
  anchor: Point;
}

const INITIAL_VIEW: View = { zoom: 1, panX: 0, panY: 0 };

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** 이미지가 화면보다 크면 가장자리 밖으로 너무 밀려나지 않게, 작으면 중앙에 고정한다. */
function clampPan(pan: number, viewSize: number, drawSize: number) {
  if (drawSize <= viewSize) return 0;
  const limit = (drawSize - viewSize) / 2 + PAN_MARGIN;
  return clamp(pan, -limit, limit);
}

/**
 * 편집용 캔버스. 슬롯의 현재 상태(블러·마스크·회전 반영)를 화면에 맞춰 그리고,
 * 포인터 입력을 원본 이미지 좌표로 바꿔서 넘겨준다.
 * 두 손가락 핀치·휠·버튼으로 확대하고 이동할 수 있다.
 */
const EditCanvas = forwardRef<EditCanvasHandle, Props>(function EditCanvas(
  {
    slot,
    applyCrop = false,
    cursor,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onGestureStart,
    panWithSinglePointer,
    renderOverlay,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderedRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ ...INITIAL_VIEW });
  const transformRef = useRef<ViewTransform | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<Pinch | null>(null);
  /** 한 손가락 입력이 그리기로 전달 중인지 */
  const drawingRef = useRef(false);
  /** 한 손가락 드래그로 화면 이동 중일 때 직전 위치 */
  const panLastRef = useRef<Point | null>(null);
  /** 제스처가 끝난 뒤 남은 손가락이 그리기로 이어지지 않도록 모든 손가락이 떨어질 때까지 막는다. */
  const gestureLockRef = useRef(false);
  const [transform, setTransform] = useState<ViewTransform | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);

  /** 캐시해 둔 렌더 결과를 현재 확대/이동 상태로 화면에 그린다. 확대 중에는 이것만 반복 호출된다. */
  const paint = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const rendered = renderedRef.current;
    if (!container || !canvas) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!rendered || width === 0 || height === 0) {
      transformRef.current = null;
      setTransform(null);
      return;
    }

    const view = viewRef.current;
    const fit = Math.min(width / rendered.width, height / rendered.height);
    const scale = fit * view.zoom;
    const drawWidth = rendered.width * scale;
    const drawHeight = rendered.height * scale;
    view.panX = clampPan(view.panX, width, drawWidth);
    view.panY = clampPan(view.panY, height, drawHeight);
    const offsetX = (width - drawWidth) / 2 + view.panX;
    const offsetY = (height - drawHeight) / 2 + view.panY;

    // 고해상도 화면에서 흐려지지 않도록 실제 픽셀 수를 맞춘다. 크기가 같으면 다시 할당하지 않는다.
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const ctx = context2d(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(rendered, offsetX, offsetY, drawWidth, drawHeight);

    // 자른 상태면 화면 좌표 ↔ 원본 좌표 변환에 자른 영역의 위치·크기를 반영한다.
    const area = applyCrop && slot.crop ? slot.crop : { x: 0, y: 0, w: slot.width, h: slot.height };
    const next: ViewTransform = {
      scale,
      offsetX,
      offsetY,
      rotation: slot.rotation,
      imageWidth: area.w,
      imageHeight: area.h,
      originX: area.x,
      originY: area.y,
    };
    transformRef.current = next;
    setTransform(next);
    setZoom(view.zoom);
  }, [slot.rotation, slot.width, slot.height, slot.crop, applyCrop]);

  /** 슬롯 내용(마스크·블러 등)이 바뀌었을 때 다시 합성한 뒤 그린다. */
  const draw = useCallback(() => {
    renderedRef.current = renderSlot(slot, "transparent", { applyCrop });
    paint();
  }, [slot, applyCrop, paint]);

  useImperativeHandle(ref, () => ({ redraw: draw, getTransform: () => transformRef.current }), [draw]);

  // 다른 사진이거나 회전·보이는 영역이 바뀌면 확대 상태를 처음으로 되돌린다. (draw 효과보다 먼저 선언해야 한다)
  const visibleCrop = applyCrop ? slot.crop : null;
  useEffect(() => {
    viewRef.current = { ...INITIAL_VIEW };
  }, [slot.id, slot.rotation, slot.width, slot.height, visibleCrop]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => paint());
    observer.observe(container);
    return () => observer.disconnect();
  }, [paint]);

  /** 화면 좌표 screenPoint 아래에 (회전된) 이미지 좌표 anchor가 오도록 배율 zoom으로 맞춘다. */
  const zoomTo = useCallback(
    (zoom: number, anchor: Point, screenPoint: Point) => {
      const container = containerRef.current;
      const rendered = renderedRef.current;
      if (!container || !rendered) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
      const nextZoom = clamp(zoom, 1, MAX_ZOOM);
      const scale = Math.min(width / rendered.width, height / rendered.height) * nextZoom;
      viewRef.current = {
        zoom: nextZoom,
        panX: screenPoint.x - anchor.x * scale - (width - rendered.width * scale) / 2,
        panY: screenPoint.y - anchor.y * scale - (height - rendered.height * scale) / 2,
      };
      paint();
    },
    [paint],
  );

  /** 화면 좌표 아래의 (회전된) 이미지 좌표. 확대 기준점 계산용이다. */
  const anchorAt = useCallback((screenPoint: Point): Point | null => {
    const t = transformRef.current;
    if (!t) return null;
    return { x: (screenPoint.x - t.offsetX) / t.scale, y: (screenPoint.y - t.offsetY) / t.scale };
  }, []);

  const zoomAround = useCallback(
    (factor: number, screenPoint: Point) => {
      const anchor = anchorAt(screenPoint);
      if (!anchor) return;
      zoomTo(viewRef.current.zoom * factor, anchor, screenPoint);
    },
    [anchorAt, zoomTo],
  );

  // React의 onWheel은 passive라 기본 스크롤을 막을 수 없어 직접 등록한다.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      const rect = canvas!.getBoundingClientRect();
      zoomAround(Math.exp(-event.deltaY * 0.002), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    }
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [zoomAround]);

  function localPoint(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function toImagePoint(screenPoint: Point): Point | null {
    const t = transformRef.current;
    if (!t) return null;
    return screenToImage(t, screenPoint.x, screenPoint.y);
  }

  function startPinch() {
    const [a, b] = [...pointersRef.current.values()];
    const mid = midpoint(a, b);
    const anchor = anchorAt(mid);
    if (!anchor) return;
    pinchRef.current = {
      startDistance: Math.max(1, distance(a, b)),
      startZoom: viewRef.current.zoom,
      anchor,
    };
  }

  function handleDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const screenPoint = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, screenPoint);

    if (pointersRef.current.size === 2) {
      // 두 번째 손가락: 그리던 것을 취소하고 확대/이동으로 전환한다.
      if (drawingRef.current) {
        drawingRef.current = false;
        onGestureStart?.();
      }
      panLastRef.current = null;
      setPanning(false);
      gestureLockRef.current = true;
      startPinch();
      return;
    }
    if (pointersRef.current.size > 2 || gestureLockRef.current) return;

    if (panWithSinglePointer) {
      panLastRef.current = screenPoint;
      setPanning(true);
      return;
    }
    const point = toImagePoint(screenPoint);
    if (!point) return;
    drawingRef.current = true;
    onPointerDown?.(point);
  }

  function handleMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const screenPoint = localPoint(event);
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, screenPoint);
    }

    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      const zoom = (pinch.startZoom * distance(a, b)) / pinch.startDistance;
      zoomTo(zoom, pinch.anchor, midpoint(a, b));
      return;
    }

    const panLast = panLastRef.current;
    if (panLast) {
      viewRef.current.panX += screenPoint.x - panLast.x;
      viewRef.current.panY += screenPoint.y - panLast.y;
      panLastRef.current = screenPoint;
      paint();
      return;
    }

    if (gestureLockRef.current) return;
    // 마우스 호버(누르지 않은 상태)도 브러시 커서 표시를 위해 전달한다.
    const point = toImagePoint(screenPoint);
    if (point) onPointerMove?.(point);
  }

  function handleUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const screenPoint = localPoint(event);
    pointersRef.current.delete(event.pointerId);
    const remaining = pointersRef.current.size;

    if (pinchRef.current && remaining < 2) pinchRef.current = null;
    if (remaining === 0) {
      gestureLockRef.current = false;
      panLastRef.current = null;
      setPanning(false);
    }

    if (drawingRef.current) {
      drawingRef.current = false;
      const point = toImagePoint(screenPoint);
      if (point) onPointerUp?.(point);
    }
  }

  function zoomFromCenter(factor: number) {
    const container = containerRef.current;
    if (!container) return;
    zoomAround(factor, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
  }

  function resetView() {
    viewRef.current = { ...INITIAL_VIEW };
    paint();
  }

  return (
    <div ref={containerRef} className="relative h-full w-full select-none overflow-hidden">
      <canvas
        ref={canvasRef}
        className="checker absolute inset-0 touch-none"
        style={{ cursor: panning ? "grabbing" : panWithSinglePointer ? "grab" : cursor }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      />
      {transform && renderOverlay?.(transform)}

      <div className="absolute right-2 top-2 flex flex-col gap-1.5">
        <button
          type="button"
          aria-label="확대"
          onClick={() => zoomFromCenter(ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-xl font-semibold text-slate-700 shadow disabled:opacity-40"
        >
          +
        </button>
        <button
          type="button"
          aria-label="축소"
          onClick={() => zoomFromCenter(1 / ZOOM_STEP)}
          disabled={zoom <= 1}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-xl font-semibold text-slate-700 shadow disabled:opacity-40"
        >
          −
        </button>
        {zoom > 1 && (
          <button
            type="button"
            aria-label="화면에 맞추기"
            onClick={resetView}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-[11px] font-semibold text-slate-700 shadow"
          >
            맞춤
          </button>
        )}
      </div>

      {zoom > 1 && (
        <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-slate-900/70 px-2 py-0.5 text-[11px] font-semibold text-white">
          {Math.round(zoom * 100)}%
        </span>
      )}
    </div>
  );
});

export default EditCanvas;
