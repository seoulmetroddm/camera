"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import CameraCapture from "@/components/CameraCapture";
import ItemNameField from "@/components/ItemNameField";
import LayoutPicker from "@/components/LayoutPicker";
import SlotGrid from "@/components/SlotGrid";
import { clearSlot, rotateSlot, setSlotImage } from "@/lib/slotActions";
import { useAppStore } from "@/lib/store";
import { layoutSpec } from "@/types";

export default function BoardPage() {
  const router = useRouter();
  const layout = useAppStore((s) => s.layout);
  const slots = useAppStore((s) => s.slots);
  const setLayout = useAppStore((s) => s.setLayout);
  const swapSlots = useAppStore((s) => s.swapSlots);

  const [cameraTarget, setCameraTarget] = useState<number | null>(null);
  const [swapFrom, setSwapFrom] = useState<number | null>(null);

  const spec = layoutSpec(layout);
  const count = spec.rows * spec.cols;
  const filled = slots.slice(0, count).filter((slot) => slot.image).length;

  function handleSwapPick(index: number) {
    if (swapFrom === null) {
      setSwapFrom(index);
      return;
    }
    if (swapFrom !== index) swapSlots(swapFrom, index);
    setSwapFrom(null);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-5 px-5 py-6 pb-28">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm text-slate-500 hover:text-slate-900">
          ← 접수 정보
        </Link>
        <span className="text-sm font-medium text-slate-600">
          {filled} / {count} 장
        </span>
      </header>

      <section>
        <h1 className="text-lg font-bold">사진 촬영</h1>
        <p className="mt-1 text-sm text-slate-600">
          빈 칸을 눌러 각도별로 촬영하세요. 찍은 뒤에도 회전·교체·재촬영할 수 있습니다.
        </p>
      </section>

      <SlotGrid
        layout={spec}
        slots={slots}
        swapFrom={swapFrom}
        onCapture={(index) => {
          setSwapFrom(null);
          setCameraTarget(index);
        }}
        onEdit={(index) => router.push(`/edit/${index}`)}
        onSwapPick={handleSwapPick}
        onRotate={(index) => void rotateSlot(index)}
        onClear={(index) => void clearSlot(index)}
      />

      {swapFrom !== null && (
        <p className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-700">
          {swapFrom + 1}번 칸을 옮기는 중입니다. 옮길 자리를 누르세요.
        </p>
      )}

      {/* 촬영 직후 자동 인식 결과를 이 화면에서 바로 확인·수정할 수 있게 한다. */}
      {filled > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <ItemNameField />
        </section>
      )}

      <details className="rounded-2xl bg-white p-4 shadow-sm">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          배치 바꾸기 ({spec.label})
        </summary>
        <div className="mt-4">
          <LayoutPicker value={layout} onChange={setLayout} />
        </div>
      </details>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-2xl">
          <button
            type="button"
            disabled={filled === 0}
            onClick={() => router.push("/export")}
            className="w-full rounded-xl bg-slate-900 px-5 py-3.5 text-base font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-300"
          >
            한 장으로 합치기
          </button>
        </div>
      </div>

      {cameraTarget !== null && (
        <CameraCapture
          title={`${cameraTarget + 1}번 칸 촬영`}
          onClose={() => setCameraTarget(null)}
          onCapture={async (image) => {
            const target = cameraTarget;
            setCameraTarget(null);
            await setSlotImage(target, image);
          }}
        />
      )}
    </main>
  );
}
