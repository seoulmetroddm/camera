"use client";

import { useAppStore } from "@/lib/store";

/**
 * 품목명 입력 칸 + 자동 인식 후보 버튼.
 * 인식 1등이 틀려도 2·3등에 정답이 있는 경우가 많아, 후보를 눌러 바로 고칠 수 있게 한다.
 * 후보를 누르면 직접 고른 값으로 보고 이후 자동 인식이 덮어쓰지 않는다.
 */
export default function ItemNameField() {
  const itemName = useAppStore((s) => s.itemName);
  const candidates = useAppStore((s) => s.itemNameCandidates);
  const setMeta = useAppStore((s) => s.setMeta);

  return (
    <div>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">품목명</span>
        <input
          value={itemName}
          onChange={(e) => setMeta({ itemName: e.target.value })}
          placeholder="예: 검정 지갑"
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-slate-900"
        />
      </label>

      {candidates.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500">인식 후보</span>
          {candidates.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setMeta({ itemName: candidate })}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                itemName === candidate
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {candidate}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
