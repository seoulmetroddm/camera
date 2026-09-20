import type { NextConfig } from "next";

// GitHub Pages 프로젝트 페이지(https://<계정>.github.io/camera/)는 루트가 아니라
// /camera 서브경로에서 서빙된다. actions/configure-pages가 계산해 넘겨주는 실제 base path
// (커스텀 도메인이면 "", 서브경로면 "/camera")를 CI에서 NEXT_BASE_PATH로 주입한다.
// (actions/configure-pages는 커스텀 도메인 여부와 무관하게 항상 GITHUB_PAGES=true를 설정하므로
//  그 값으로는 구분할 수 없다 — 반드시 NEXT_BASE_PATH를 사용해야 한다.)
const basePath = process.env.NEXT_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // 서버가 필요 없는 완전 정적 사이트로 빌드한다 (무료 호스팅 배포용)
  output: "export",
  images: { unoptimized: true },
  basePath,
  // GitHub Pages 같은 일반 정적 호스팅은 디렉터리+index.html 방식이 가장 안전하다.
  trailingSlash: true,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
