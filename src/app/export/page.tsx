"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ItemNameField from "@/components/ItemNameField";
import { composeGrid, renderSlot } from "@/lib/canvas/render";
import { canvasToBlob } from "@/lib/canvas/util";
import { buildFileName, downloadBlob } from "@/lib/filename";
import { discardSaved } from "@/lib/persist";
import { useAppStore } from "@/lib/store";
import { layoutSpec } from "@/types";

export default function ExportPage() {
  const router = useRouter();
  const layout = useAppStore((s) => s.layout);
  const slots = useAppStore((s) => s.slots);
  const background = useAppStore((s) => s.background);
  const format = useAppStore((s) => s.format);
  const itemName = useAppStore((s) => s.itemName);
  const gap = useAppStore((s) => s.gap);
  const divider = useAppStore((s) => s.divider);
  const setBackground = useAppStore((s) => s.setBackground);
  const setFormat = useAppStore((s) => s.setFormat);
  const setGap = useAppStore((s) => s.setGap);
  const setDivider = useAppStore((s) => s.setDivider);
  const resetAll = useAppStore((s) => s.resetAll);

  const composedRef = useRef<HTMLCanvasElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const spec = layoutSpec(layout);
  // JPG는 투명을 표현할 수 없으므로 투명 배경일 때는 PNG로 고정한다.
  const effectiveFormat = background === "transparent" ? "png" : format;
  const fileName = buildFileName(itemName, effectiveFormat === "png" ? "png" : "jpg");

  useEffect(() => {
    let cancelled = false;

    async function build() {
      const cells = slots
        .slice(0, spec.rows * spec.cols)
        .map((slot) => renderSlot(slot, background));
      const canvas = composeGrid({ layout: spec, cells, background, gap, divider });
      composedRef.current = canvas;
      const blob = await canvasToBlob(canvas, "image/png");
      if (cancelled) return;
      setPreviewUrl(URL.createObjectURL(blob));
      setSize({ width: canvas.width, height: canvas.height });
    }

    void build();
    return () => {
      cancelled = true;
    };
  }, [slots, spec, background, gap, divider]);

  // previewUrl이 바뀌면 이전 URL을 해제한다.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function handleDownload() {
    const canvas = composedRef.current;
    if (!canvas || busy) return;
    setBusy(true);
    try {
      const isPng = effectiveFormat === "png";
      const blob = await canvasToBlob(canvas, isPng ? "image/png" : "image/jpeg", 0.92);
      downloadBlob(blob, fileName);
    } finally {
      setBusy(false);
    }
  }

  function handleNewCase() {
    void discardSaved();
    resetAll();
    router.push("/");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-5 px-5 py-6 pb-28">
      <header className="flex items-center justify-between">
        <Link href="/board" className="text-sm text-slate-500 hover:text-slate-900">
          ← 촬영으로
        </Link>
        <span className="text-sm text-slate-500">
          {size ? `${size.width} × ${size.height}px` : "만드는 중…"}
        </span>
      </header>

      <h1 className="text-lg font-bold">저장하기</h1>

      <div className="overflow-hidden rounded-2xl border border-slate-200">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="합성 결과 미리보기" className="checker w-full" />
        ) : (
          <div className="flex h-64 items-center justify-center text-sm text-slate-400">
            미리보기를 만드는 중입니다…
          </div>
        )}
      </div>

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold">배경</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(
            [
              { id: "white", label: "흰색", hint: "등록사이트 업로드용" },
              { id: "transparent", label: "투명", hint: "문서에 재활용" },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setBackground(option.id)}
              className={`rounded-xl border-2 px-4 py-3 text-left transition ${
                background === option.id
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white hover:border-slate-400"
              }`}
            >
              <span className="block text-sm font-semibold">{option.label}</span>
              <span
                className={`block text-xs ${
                  background === option.id ? "text-white/70" : "text-slate-500"
                }`}
              >
                {option.hint}
              </span>
            </button>
          ))}
        </div>

        <h2 className="mt-6 text-sm font-semibold">파일 형식</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(
            [
              { id: "jpeg", label: "JPG", hint: "용량이 작음" },
              { id: "png", label: "PNG", hint: "투명 지원" },
            ] as const
          ).map((option) => {
            const disabled = option.id === "jpeg" && background === "transparent";
            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                onClick={() => setFormat(option.id)}
                className={`rounded-xl border-2 px-4 py-3 text-left transition disabled:opacity-40 ${
                  effectiveFormat === option.id
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white hover:border-slate-400"
                }`}
              >
                <span className="block text-sm font-semibold">{option.label}</span>
                <span
                  className={`block text-xs ${
                    effectiveFormat === option.id ? "text-white/70" : "text-slate-500"
                  }`}
                >
                  {option.hint}
                </span>
              </button>
            );
          })}
        </div>
        {background === "transparent" && (
          <p className="mt-3 text-xs text-slate-500">
            JPG는 투명을 표현할 수 없어 PNG로 저장됩니다.
          </p>
        )}

        {spec.rows * spec.cols > 1 && (
          <>
            <h2 className="mt-6 text-sm font-semibold">칸 배치</h2>
            <label className="mt-3 block">
              <span className="text-xs font-medium text-slate-600">칸 사이 여백 {gap}px</span>
              <input
                type="range"
                min={0}
                max={80}
                step={4}
                value={gap}
                onChange={(event) => setGap(Number(event.target.value))}
                className="mt-1 w-full accent-slate-900"
              />
            </label>
            <label className="mt-3 flex items-center gap-2">
              <input
                type="checkbox"
                checked={divider}
                onChange={(event) => setDivider(event.target.checked)}
                className="h-4 w-4 accent-slate-900"
              />
              <span className="text-sm text-slate-700">칸 사이에 구분선 표시</span>
            </label>
          </>
        )}

        <div className="mt-6">
          <ItemNameField />
        </div>

        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          저장될 파일명: <span className="font-medium text-slate-900">{fileName}</span>
        </p>
      </section>

      <button
        type="button"
        onClick={handleNewCase}
        className="text-sm text-slate-500 underline underline-offset-4 hover:text-slate-900"
      >
        새 접수 시작 (현재 사진 모두 지우기)
      </button>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
        <div className="mx-auto w-full max-w-2xl">
          <button
            type="button"
            onClick={handleDownload}
            disabled={!previewUrl || busy}
            className="w-full rounded-xl bg-slate-900 px-5 py-3.5 text-base font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-300"
          >
            {busy ? "저장 중…" : "이미지 저장"}
          </button>
        </div>
      </div>
    </main>
  );
}
