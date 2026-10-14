"use client";

import { useEffect, useState } from "react";
import { startPersistence } from "@/lib/persist";

/**
 * 저장해 둔 접수 건을 되살린 뒤에 화면을 보여준다.
 * 되살리기 전에 화면을 보여주면 "사진이 없습니다"가 잠깐 뜨거나, 그 사이 찍은 사진이 덮어써질 수 있다.
 */
export default function PersistGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void startPersistence().then(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-slate-400">
        불러오는 중…
      </div>
    );
  }
  return <>{children}</>;
}
