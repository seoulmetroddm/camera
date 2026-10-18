import type { MetadataRoute } from "next";

// 정적 export(output:'export')에서는 명시적으로 정적 라우트임을 선언해야 한다.
export const dynamic = "force-static";

// GitHub Pages 서브경로(/camera) 배포 시 start_url·scope·아이콘 경로가 어긋나지 않도록
// 빌드 타임에 basePath를 반영한다. public/manifest.json이던 것을 코드 생성 방식으로 옮겼다.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "유실물 촬영 도우미",
    short_name: "유실물촬영",
    description: "유실물 사진 촬영·배경 제거·개인정보 가림·합성 도구",
    start_url: `${basePath}/`,
    scope: `${basePath}/`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#f1f5f9",
    theme_color: "#0f172a",
    icons: [
      // 로고가 가장자리까지 차 있어 maskable로 쓰면 잘리므로 any로만 등록한다.
      { src: `${basePath}/icon.png`, sizes: "256x256", type: "image/png", purpose: "any" },
    ],
  };
}
