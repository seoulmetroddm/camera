"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import AppVersion from "@/components/AppVersion";
import EditCanvas, { type EditCanvasHandle } from "@/components/EditCanvas";
import { imageToScreen, normalizeRect, type Point, type ViewTransform } from "@/lib/canvas/coords";
import {
  type BrushMode,
  cloneMask,
  paintMaskCircle,
  paintMaskStroke,
} from "@/lib/canvas/maskBrush";
import { computeSubjectCrop } from "@/lib/canvas/maskBounds";
import {
  createBackgroundMask,
  type SegmentationProgress,
} from "@/lib/segmentation/client";
import { isModelCached } from "@/lib/modelCache";
import { MODELS, type ModelId } from "@/lib/segmentation/models";
import { commitSlot, rotateSlot, suggestItemNameFromSlot } from "@/lib/slotActions";
import { useAppStore } from "@/lib/store";
import { uid } from "@/lib/uid";
import type { BlurRegion, CropRect, Slot } from "@/types";

/** 원본 기준 이 정도보다 작으면 실수로 톡 친 것으로 보고 무시한다. */
const MIN_REGION_SIZE = 12;

/** 보정 브러시 실행취소 스택 최대 깊이 */
const MAX_BRUSH_UNDO = 20;

type Tab = "background" | "privacy" | "crop";

function screenRect(transform: ViewTransform, x: number, y: number, w: number, h: number) {
  const a = imageToScreen(transform, x, y);
  const b = imageToScreen(transform, x + w, y + h);
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** 두 영역이 (반올림 오차를 빼고) 같은지 */
function sameRect(a: CropRect, b: CropRect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}

/**
 * 배경 제거가 지금 자른 영역 기준이 아닌지.
 * 배경을 지운 뒤에 자르기 영역을 바꾸거나 초기화하면, 마스크는 예전 영역으로 만든 그대로 남는다.
 */
function isMaskStale(slot: Slot | undefined): boolean {
  if (!slot?.image || !slot.mask) return false;
  const full = { x: 0, y: 0, w: slot.width, h: slot.height };
  return !sameRect(slot.maskRect ?? full, slot.crop ?? full);
}

function progressLabel(progress: SegmentationProgress): string {
  if (progress.phase === "download") {
    return `모델 내려받는 중 ${Math.round(progress.ratio * 100)}%`;
  }
  if (progress.phase === "prepare") return "모델 준비 중…";
  return "배경을 분리하는 중…";
}

export default function EditClient({ index }: { index: number }) {
  const router = useRouter();
  const slot = useAppStore((state) => state.slots[index]);
  const modelId = useAppStore((state) => state.modelId);
  const setModelId = useAppStore((state) => state.setModelId);

  // 편집 화면에 들어오면 가장 많이 쓰는 배경 제거 탭부터 보여준다.
  const [tab, setTab] = useState<Tab>("background");
  const [tool, setTool] = useState<BlurRegion["type"]>("blur");
  const [strength, setStrength] = useState(6);
  const [draft, setDraft] = useState<{ start: Point; current: Point } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SegmentationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState<Record<ModelId, boolean>>({
    silueta: false,
    isnet: false,
  });

  const [brushMode, setBrushMode] = useState<BrushMode>("erase");
  /** 화면 px 기준 반지름. 확대할수록 원본 기준으로는 가늘어져 세밀한 보정이 쉬워진다. */
  const [brushSize, setBrushSize] = useState(24);
  const [brushCursor, setBrushCursor] = useState<Point | null>(null);
  const [brushUndoCount, setBrushUndoCount] = useState(0);
  const canvasHandleRef = useRef<EditCanvasHandle>(null);
  const paintingRef = useRef(false);
  const lastPaintPointRef = useRef<Point | null>(null);
  const brushUndoStackRef = useRef<HTMLCanvasElement[]>([]);

  const refreshCached = useCallback(async () => {
    setCached({
      silueta: await isModelCached(MODELS.silueta.url),
      isnet: await isModelCached(MODELS.isnet.url),
    });
  }, []);

  useEffect(() => {
    void refreshCached();
  }, [refreshCached]);

  // 배경 제거 탭에 들어왔는데 자르기 영역이 바뀌어 있으면, 잘린 사진 기준으로 자동으로 다시 처리한다.
  // 같은 상태에서 실패했을 때 무한히 반복하지 않도록 한 번 시도한 상태는 기억해 둔다.
  const staleKey = isMaskStale(slot) ? JSON.stringify([slot?.crop, slot?.maskRect]) : null;
  const triedStaleKeyRef = useRef<string | null>(null);
  const removeBackgroundRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    removeBackgroundRef.current = handleRemoveBackground;
  });
  useEffect(() => {
    if (tab !== "background" || !staleKey || progress) return;
    if (triedStaleKeyRef.current === staleKey) return;
    triedStaleKeyRef.current = staleKey;
    void removeBackgroundRef.current?.();
  }, [tab, staleKey, progress]);

  if (!slot?.image) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center gap-4 px-5">
        <p className="text-sm text-slate-600">이 칸에는 아직 사진이 없습니다.</p>
        <Link
          href="/board"
          className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white"
        >
          촬영 화면으로
        </Link>
      </main>
    );
  }

  const regions = slot.blurRegions;
  const busy = progress !== null;
  const fullBounds = { x: 0, y: 0, w: slot.width, h: slot.height };
  /** 배경 제거·개인정보 가리기는 자른 영역 안에서만 작업한다. */
  const editBounds = slot.crop ?? fullBounds;

  async function updateRegions(next: BlurRegion[]) {
    await commitSlot(index, { blurRegions: next });
  }

  async function handlePointerUp() {
    const current = draft;
    setDraft(null);
    if (!current || !slot) return;

    const rect = normalizeRect(current.start, current.current, editBounds);
    if (rect.w < MIN_REGION_SIZE || rect.h < MIN_REGION_SIZE) return;

    const region: BlurRegion = { id: uid("blur"), ...rect, type: tool, strength };
    setSelectedId(region.id);
    await updateRegions([...regions, region]);
  }

  /** 슬라이더·도구 변경은 마지막에 그린 영역에 바로 반영한다. */
  async function applyToSelected(patch: Partial<BlurRegion>) {
    if (!selectedId) return;
    await updateRegions(regions.map((r) => (r.id === selectedId ? { ...r, ...patch } : r)));
  }

  async function undoLast() {
    if (regions.length === 0) return;
    setSelectedId(null);
    await updateRegions(regions.slice(0, -1));
  }

  async function handleCropPointerUp() {
    const current = draft;
    setDraft(null);
    if (!current || !slot) return;

    const rect = normalizeRect(current.start, current.current, fullBounds);
    if (rect.w < MIN_REGION_SIZE || rect.h < MIN_REGION_SIZE) return;
    await commitSlot(index, { crop: rect });
  }

  async function handleRemoveBackground() {
    if (!slot?.image || busy) return;
    setError(null);
    setProgress({ phase: "download", ratio: 0 });
    try {
      // 잘라둔 영역이 있으면 그 영역만 모델에 넣는다.
      let region = slot.crop ?? fullBounds;
      let mask = await createBackgroundMask(slot.image, modelId, setProgress, region);
      let crop = slot.crop;
      // 처음 지울 때 자르지 않았으면 피사체에 맞춰 자동으로 자르고, 잘린 사진으로 한 번 더 처리한다.
      // 피사체가 모델 입력에서 크게 잡혀 경계가 더 정확해지고, 마스크도 지금 자른 영역 기준이 된다.
      // (이미 지운 뒤 자르기를 초기화했다면 사용자가 전체 사진을 원한 것이므로 다시 자르지 않는다)
      if (!crop && !slot.mask) {
        const subject = computeSubjectCrop(mask, region);
        if (subject) {
          crop = subject;
          region = subject;
          mask = await createBackgroundMask(slot.image, modelId, setProgress, region);
        }
      }
      await commitSlot(index, { mask, maskRect: region, crop });
      resetBrushUndo();
      // 배경이 빠진 그림으로 품목명을 다시 추정한다 (비어 있을 때만 채운다).
      void suggestItemNameFromSlot(index);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "배경 제거에 실패했습니다.");
    } finally {
      setProgress(null);
      void refreshCached();
    }
  }

  function resetBrushUndo() {
    brushUndoStackRef.current = [];
    setBrushUndoCount(0);
  }

  /** 마스크가 덮는 원본 영역 */
  const maskArea = slot.maskRect ?? fullBounds;

  /** 원본 이미지 좌표를 마스크 캔버스 좌표로 바꾼다 (마스크는 maskArea만 덮고 최대 1024px로 축소돼 있다). */
  function toMaskPoint(point: Point): Point | null {
    if (!slot.mask) return null;
    const scale = slot.mask.width / maskArea.w;
    return { x: (point.x - maskArea.x) * scale, y: (point.y - maskArea.y) * scale };
  }

  /** 화면 px 브러시 반지름 → 원본 px → 마스크 px */
  function maskRadius(): number {
    const scale = canvasHandleRef.current?.getTransform()?.scale ?? 1;
    const imageRadius = brushSize / scale;
    if (!slot.mask) return imageRadius;
    return imageRadius * (slot.mask.width / maskArea.w);
  }

  function handleBrushDown(point: Point) {
    if (!slot.mask || busy) return;
    const stack = brushUndoStackRef.current;
    stack.push(cloneMask(slot.mask));
    if (stack.length > MAX_BRUSH_UNDO) stack.shift();
    setBrushUndoCount(stack.length);

    paintingRef.current = true;
    lastPaintPointRef.current = point;
    const mp = toMaskPoint(point);
    if (mp) paintMaskCircle(slot.mask, mp.x, mp.y, maskRadius(), brushMode);
    canvasHandleRef.current?.redraw();
  }

  function handleBrushMove(point: Point) {
    setBrushCursor(point);
    if (!paintingRef.current || !slot.mask) return;
    const from = lastPaintPointRef.current ?? point;
    const mpFrom = toMaskPoint(from);
    const mpTo = toMaskPoint(point);
    if (mpFrom && mpTo) paintMaskStroke(slot.mask, mpFrom, mpTo, maskRadius(), brushMode);
    lastPaintPointRef.current = point;
    canvasHandleRef.current?.redraw();
  }

  async function handleBrushUp() {
    if (!paintingRef.current) return;
    paintingRef.current = false;
    lastPaintPointRef.current = null;
    if (!slot.mask) return;
    // 캔버스는 이미 직접 그려져 있다. 스토어에 반영해 미리보기를 갱신하고 화면 재구성을 트리거한다.
    await commitSlot(index, { mask: slot.mask });
  }

  /** 그리던 중 두 손가락 확대로 바뀌면 방금 찍힌 획과 그리던 사각형을 취소한다. */
  async function cancelInteraction() {
    setDraft(null);
    if (!paintingRef.current) return;
    paintingRef.current = false;
    lastPaintPointRef.current = null;
    await undoBrush();
  }

  async function undoBrush() {
    const snapshot = brushUndoStackRef.current.pop();
    setBrushUndoCount(brushUndoStackRef.current.length);
    if (!snapshot) return;
    await commitSlot(index, { mask: snapshot });
  }

  /** 모델 선택 + 배경 지우기 버튼. 배경을 지운 뒤에는 접어 두어 캔버스 공간을 확보한다. */
  function renderBackgroundControls() {
    return (
      <>
        <p className="mt-2 text-xs text-slate-500">
          피사체만 남기고 배경을 지웁니다. 모델은 처음 한 번만 내려받고 이후에는 저장돼 있어
          오프라인에서도 동작합니다.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {(Object.values(MODELS) as (typeof MODELS)[ModelId][]).map((spec) => (
            <button
              key={spec.id}
              type="button"
              disabled={busy}
              onClick={() => setModelId(spec.id)}
              className={`rounded-lg border-2 px-3 py-2 text-left transition disabled:opacity-50 ${
                modelId === spec.id
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 text-slate-600"
              }`}
            >
              <span className="block text-sm font-semibold">{spec.label}</span>
              <span
                className={`block text-[11px] ${
                  modelId === spec.id ? "text-white/70" : "text-slate-500"
                }`}
              >
                {cached[spec.id] ? "받아둠 · 바로 실행" : spec.description}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void handleRemoveBackground()}
            disabled={busy}
            className="flex-1 rounded-xl bg-slate-900 py-3 text-sm font-semibold text-white disabled:bg-slate-300"
          >
            {progress ? progressLabel(progress) : slot.mask ? "다시 처리" : "배경 지우기"}
          </button>
          {slot.mask && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void commitSlot(index, { mask: null, maskRect: null })}
              className="rounded-xl border border-slate-200 px-4 text-sm font-medium text-slate-600 disabled:opacity-40"
            >
              되돌리기
            </button>
          )}
        </div>

        {progress?.phase === "download" && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-slate-900 transition-all"
              style={{ width: `${Math.round(progress.ratio * 100)}%` }}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <Link href="/board" className="text-sm text-slate-500 hover:text-slate-900">
          ← 촬영
        </Link>
        <div className="flex flex-col items-center leading-tight">
          <span className="text-sm font-semibold">{index + 1}번 칸 편집</span>
          <AppVersion />
        </div>
        <button
          type="button"
          onClick={() => router.push("/board")}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white"
        >
          완료
        </button>
      </header>

      <div className="min-h-0 flex-1 bg-slate-200 p-1">
        <EditCanvas
          ref={canvasHandleRef}
          slot={slot}
          applyCrop={tab !== "crop"}
          cursor={tab === "privacy" || tab === "crop" ? "crosshair" : slot.mask ? "none" : "default"}
          panWithSinglePointer={tab === "background" && !slot.mask}
          onGestureStart={() => void cancelInteraction()}
          onPointerDown={(point) => {
            if (tab === "privacy" || tab === "crop") setDraft({ start: point, current: point });
            else if (tab === "background") handleBrushDown(point);
          }}
          onPointerMove={(point) => {
            if (tab === "privacy" || tab === "crop") setDraft((d) => (d ? { ...d, current: point } : null));
            else if (tab === "background") handleBrushMove(point);
          }}
          onPointerUp={() => {
            if (tab === "privacy") void handlePointerUp();
            else if (tab === "crop") void handleCropPointerUp();
            else if (tab === "background") void handleBrushUp();
          }}
          renderOverlay={(transform) => (
            <>
              {tab === "privacy" && (
                <>
                  {regions.map((region) => (
                    <div
                      key={region.id}
                      style={screenRect(transform, region.x, region.y, region.w, region.h)}
                      className={`pointer-events-none absolute rounded-sm border-2 ${
                        region.id === selectedId ? "border-amber-400" : "border-amber-400/50"
                      }`}
                    />
                  ))}
                  {draft && (
                    <div
                      style={(() => {
                        const rect = normalizeRect(draft.start, draft.current, editBounds);
                        return screenRect(transform, rect.x, rect.y, rect.w, rect.h);
                      })()}
                      className="pointer-events-none absolute rounded-sm border-2 border-dashed border-amber-500 bg-amber-300/25"
                    />
                  )}
                </>
              )}
              {tab === "crop" &&
                (() => {
                  const activeRect = draft
                    ? normalizeRect(draft.start, draft.current, fullBounds)
                    : slot.crop;
                  if (!activeRect) return null;
                  return (
                    <div
                      style={{
                        ...screenRect(transform, activeRect.x, activeRect.y, activeRect.w, activeRect.h),
                        boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.55)",
                      }}
                      className="pointer-events-none absolute border-2 border-sky-400"
                    />
                  );
                })()}
              {tab === "background" && slot.mask && brushCursor && (
                <div
                  style={(() => {
                    const center = imageToScreen(transform, brushCursor.x, brushCursor.y);
                    const r = brushSize;
                    return { left: center.x - r, top: center.y - r, width: r * 2, height: r * 2 };
                  })()}
                  className={`pointer-events-none absolute rounded-full border-2 ${
                    brushMode === "erase" ? "border-red-500/70" : "border-sky-500/70"
                  }`}
                />
              )}
            </>
          )}
        />
      </div>

      <section className="max-h-[45dvh] overflow-y-auto border-t border-slate-200 bg-white">
        <div className="sticky top-0 z-10 flex border-b border-slate-200 bg-white">
          {(
            [
              { id: "crop", label: "자르기" },
              { id: "background", label: "배경 제거" },
              { id: "privacy", label: "개인정보 가리기" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex-1 py-3 text-sm font-semibold transition ${
                tab === item.id
                  ? "border-b-2 border-slate-900 text-slate-900"
                  : "text-slate-400 hover:text-slate-600"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "background" ? (
          <div className="px-4 py-3">
            {/* 배경을 지운 뒤에는 처리 버튼이 접혀 있으므로, 자동 재처리 진행 상황은 여기서 보여준다. */}
            {slot.mask && progress && (
              <p className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800">
                잘린 사진 기준으로 다시 처리하는 중 · {progressLabel(progress)}
              </p>
            )}
            {slot.mask && (
              <div>
                <div className="flex gap-2">
                  {(
                    [
                      { id: "erase", label: "지우개" },
                      { id: "restore", label: "복원" },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setBrushMode(option.id)}
                      className={`flex-1 rounded-lg border-2 py-2 text-sm font-semibold transition ${
                        brushMode === option.id
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 text-slate-600"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => void undoBrush()}
                    disabled={brushUndoCount === 0}
                    className="rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 disabled:opacity-40"
                  >
                    보정 취소
                  </button>
                </div>

                <label className="mt-2 flex items-center gap-3">
                  <span className="shrink-0 text-xs font-medium text-slate-600">브러시 {brushSize}</span>
                  <input
                    type="range"
                    min={4}
                    max={80}
                    value={brushSize}
                    onChange={(event) => setBrushSize(Number(event.target.value))}
                    className="w-full accent-slate-900"
                  />
                </label>

                <p className="mt-1 text-[11px] text-slate-500">
                  두 손가락으로 벌려 확대하고 움직여 이동하세요. 확대할수록 브러시가 세밀해집니다.
                </p>
              </div>
            )}

            {slot.mask ? (
              <details className="mt-3 border-t border-slate-100 pt-2">
                <summary className="cursor-pointer py-1 text-xs font-medium text-slate-600">
                  다시 처리 · 모델 변경
                </summary>
                {renderBackgroundControls()}
              </details>
            ) : (
              renderBackgroundControls()
            )}

            {error && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
            )}
          </div>
        ) : tab === "privacy" ? (
          <div className="px-4 py-4">
            <p className="text-xs text-slate-500">
              가릴 부분을 손가락이나 마우스로 드래그하세요. 지정한 영역은 픽셀 자체가 지워집니다.
            </p>

            <div className="mt-3 flex gap-2">
              {(
                [
                  { id: "blur", label: "블러" },
                  { id: "mosaic", label: "모자이크" },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setTool(option.id);
                    void applyToSelected({ type: option.id });
                  }}
                  className={`flex-1 rounded-lg border-2 py-2 text-sm font-semibold transition ${
                    tool === option.id
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 text-slate-600"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <label className="mt-4 block">
              <span className="text-xs font-medium text-slate-600">강도 {strength}</span>
              <input
                type="range"
                min={1}
                max={10}
                value={strength}
                onChange={(event) => setStrength(Number(event.target.value))}
                onPointerUp={() => void applyToSelected({ strength })}
                onKeyUp={() => void applyToSelected({ strength })}
                className="mt-1 w-full accent-slate-900"
              />
            </label>

            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">가린 영역 {regions.length}개</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void rotateSlot(index)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600"
                >
                  회전
                </button>
                <button
                  type="button"
                  onClick={() => void undoLast()}
                  disabled={regions.length === 0}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 disabled:opacity-40"
                >
                  마지막 취소
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(null);
                    void updateRegions([]);
                  }}
                  disabled={regions.length === 0}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 disabled:opacity-40"
                >
                  전체 지우기
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-4 py-4">
            <p className="text-xs text-slate-500">
              결과물에 남길 영역을 드래그로 지정하세요. 지정하지 않으면 사진 전체가 그대로 쓰입니다.
              배경 제거와 개인정보 가리기는 자른 사진을 기준으로 진행됩니다.
            </p>

            {slot.mask && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                배경을 지운 뒤 자르기 영역을 바꾸면, 배경 제거 탭으로 갈 때 잘린 사진 기준으로 자동으로 다시
                처리합니다. 손으로 보정한 내용은 다시 해야 합니다.
              </p>
            )}

            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">
                {slot.crop
                  ? `자른 영역 ${Math.round(slot.crop.w)} × ${Math.round(slot.crop.h)}px`
                  : "전체 사용"}
              </span>
              <button
                type="button"
                onClick={() => void commitSlot(index, { crop: null })}
                disabled={!slot.crop}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 disabled:opacity-40"
              >
                초기화
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
