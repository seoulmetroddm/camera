"use client";

import { useRouter } from "next/navigation";
import ItemNameField from "@/components/ItemNameField";
import LayoutPicker from "@/components/LayoutPicker";
import { useAppStore } from "@/lib/store";

export default function HomePage() {
  const router = useRouter();
  const layout = useAppStore((s) => s.layout);
  const setLayout = useAppStore((s) => s.setLayout);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 pb-28 pt-8">
      <header>
        <div className="flex justify-end">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/images/logo.png`}
            alt="서울교통공사"
            className="h-10 w-auto"
          />
        </div>
        <h1 className="mt-4 text-2xl font-bold tracking-tight">유실물 촬영 도우미</h1>
        <p className="mt-2 text-sm text-slate-600">
          사진을 찍고 배경 제거·개인정보 가림·여러 장 합치기를 한 번에 끝냅니다. 모든 처리는 이
          기기 안에서만 이뤄지고, 사진은 어디로도 전송되지 않습니다.
        </p>
      </header>

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">접수 정보</h2>
        <p className="mt-1 text-xs text-slate-500">
          저장할 파일 이름에 사용됩니다. 비워두면 사진을 찍은 뒤 물건 종류를 자동으로 인식해 채워드립니다.
        </p>
        <div className="mt-4">
          <ItemNameField />
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">사진 배치</h2>
        <p className="mt-1 text-xs text-slate-500">
          몇 장을 한 파일로 합칠지 고릅니다. 나중에 바꿔도 찍은 사진은 그대로 남습니다.
        </p>
        <div className="mt-4">
          <LayoutPicker value={layout} onChange={setLayout} />
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-100 bg-white/95 backdrop-blur">
        <div className="mx-auto w-full max-w-2xl px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            onClick={() => router.push("/board")}
            className="w-full rounded-xl bg-slate-900 px-5 py-4 text-base font-semibold text-white transition hover:bg-slate-800"
          >
            촬영 시작
          </button>
        </div>
      </div>
    </main>
  );
}
