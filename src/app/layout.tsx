import type { Metadata, Viewport } from "next";
import PersistGate from "@/components/PersistGate";
import "./globals.css";

// GitHub Pages 서브경로(/camera) 배포 시에도 아이콘이 제대로 뜨도록 basePath를 붙인다.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "유실물 촬영 도우미",
  description:
    "유실물 사진 촬영부터 배경 제거, 개인정보 가림, 여러 장 합치기까지 브라우저 안에서 처리합니다. 사진은 기기 밖으로 나가지 않습니다.",
  // favicon.ico는 app/favicon.ico 파일 규칙으로 자동 연결된다. 홈 화면 추가용으로 PNG를 함께 둔다.
  icons: { icon: `${basePath}/icon.png`, apple: `${basePath}/icon.png` },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f172a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <PersistGate>{children}</PersistGate>
      </body>
    </html>
  );
}
