/** 빌드 버전 표시. 휴대폰에 옛 화면이 남아 있는지 확인하는 용도다. (값은 next.config.ts에서 빌드 때 넣는다) */
export default function AppVersion({ className = "" }: { className?: string }) {
  return (
    <span className={`text-[10px] tabular-nums text-slate-400 ${className}`}>
      {process.env.NEXT_PUBLIC_APP_VERSION}
    </span>
  );
}
