/** 그리드 배치 종류. 이름은 "행x열" 기준이다. */
export type LayoutId = "1x1" | "1x2" | "2x1" | "2x2";

export interface LayoutSpec {
  id: LayoutId;
  label: string;
  description: string;
  rows: number;
  cols: number;
}

export const LAYOUTS: LayoutSpec[] = [
  { id: "1x1", label: "1 x 1", description: "한 장", rows: 1, cols: 1 },
  { id: "1x2", label: "1 x 2", description: "가로로 두 장", rows: 1, cols: 2 },
  { id: "2x1", label: "2 x 1", description: "세로로 두 장", rows: 2, cols: 1 },
  { id: "2x2", label: "2 x 2", description: "네 장", rows: 2, cols: 2 },
];

/** 배치별로 필요한 칸 수. 슬롯 배열은 항상 최대치(4칸)를 유지한다. */
export const MAX_SLOTS = 4;

export function layoutSpec(id: LayoutId): LayoutSpec {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[3];
}

export function slotCount(id: LayoutId): number {
  const spec = layoutSpec(id);
  return spec.rows * spec.cols;
}

/** 가릴 영역. 좌표는 화면이 아니라 원본 이미지 픽셀 기준으로 저장한다. */
export interface BlurRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  type: "blur" | "mosaic";
  /** 1~10. 클수록 강하게 뭉갠다. */
  strength: number;
}

export interface Slot {
  id: string;
  /** 긴 변 2048px로 줄인 작업용 원본 */
  image: ImageBitmap | null;
  width: number;
  height: number;
  /** 0 / 90 / 180 / 270 */
  rotation: number;
  blurRegions: BlurRegion[];
  /** 배경 제거 알파 마스크. 알파값이 곧 피사체 확률이다. */
  mask: HTMLCanvasElement | null;
  /**
   * 마스크가 덮는 영역(원본 좌표, 회전 전). null이면 사진 전체.
   * 자른 뒤 배경을 지우면 잘린 영역만 처리하므로 마스크도 그 영역만 덮는다. 바깥은 투명으로 본다.
   */
  maskRect: CropRect | null;
  /** 잘라낼 영역(원본 좌표, 회전 전). null이면 자르지 않는다. */
  crop: CropRect | null;
  /** 목록에 표시할 미리보기 object URL */
  preview: string | null;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BackgroundMode = "white" | "transparent";
export type ExportFormat = "jpeg" | "png";
