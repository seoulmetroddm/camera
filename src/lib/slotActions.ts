import type { Slot } from "@/types";
import { renderSlot } from "./canvas/render";
import { classifySubject } from "./classification/client";
import { toPreviewUrl } from "./image";
import { useAppStore } from "./store";

/**
 * 슬롯을 갱신하고 썸네일을 다시 만든다.
 * 미리보기는 항상 투명 배경으로 렌더해서 배경이 실제로 지워졌는지 눈으로 확인할 수 있게 한다.
 */
export async function commitSlot(index: number, patch: Partial<Slot>) {
  const current = useAppStore.getState().slots[index];
  if (!current) return;

  const next: Slot = { ...current, ...patch };
  const rendered = renderSlot(next, "transparent");
  next.preview = rendered ? await toPreviewUrl(rendered) : null;

  useAppStore.getState().replaceSlot(index, next);
  if (current.preview && current.preview !== next.preview) {
    URL.revokeObjectURL(current.preview);
  }
}

export async function setSlotImage(index: number, image: ImageBitmap) {
  const current = useAppStore.getState().slots[index];
  current?.image?.close();
  await commitSlot(index, {
    image,
    width: image.width,
    height: image.height,
    rotation: 0,
    blurRegions: [],
    mask: null,
    maskRect: null,
    crop: null,
  });
  void suggestItemName(image);
}

/**
 * 배경을 지운 뒤 다시 품목명을 추정한다.
 *
 * 배경이 빠지고 피사체에 딱 맞게 잘린 그림은 모델이 학습한 사진과 가장 비슷해서
 * 촬영 직후 원본보다 훨씬 잘 맞는다. 그때 못 채웠더라도 여기서 한 번 더 기회를 준다.
 */
export async function suggestItemNameFromSlot(index: number) {
  const slot = useAppStore.getState().slots[index];
  if (!slot?.image || !useAppStore.getState().itemNameIsAuto) return;

  const rendered = renderSlot(slot, "white");
  if (!rendered) return;
  await suggestItemName(await createImageBitmap(rendered));
}

/** 인식은 차례대로 처리되므로, 대기 중인 요청이 모두 끝났을 때만 진행 표시를 지운다. */
let pendingSuggestions = 0;

/**
 * 찍힌 물건의 품목을 추정해 품목명을 채우고, 골라 쓸 후보도 갱신한다.
 *
 * 사용자가 직접 입력한 적이 없는 동안(itemNameIsAuto)에는 재촬영할 때마다
 * 새로 추정한 값으로 덮어써도 된다. 후보는 직접 입력했더라도 계속 보여준다.
 * 실패해도 촬영 흐름을 막지 않도록 별도로 떼어냈다.
 */
async function suggestItemName(image: ImageBitmap) {
  const { setItemNameStatus } = useAppStore.getState();
  pendingSuggestions += 1;
  setItemNameStatus({ phase: "infer" });
  try {
    const result = await classifySubject(image, (ratio) => {
      setItemNameStatus(ratio < 1 ? { phase: "download", ratio } : { phase: "infer" });
    });
    if (!result) return;
    const store = useAppStore.getState();
    store.setItemNameCandidates(result.candidates);
    if (result.best && store.itemNameIsAuto) store.setAutoItemName(result.best);
  } catch {
    // 인식 실패는 무시한다. 품목명은 사용자가 직접 입력할 수 있다.
  } finally {
    pendingSuggestions -= 1;
    if (pendingSuggestions === 0) setItemNameStatus(null);
  }
}

export async function clearSlot(index: number) {
  const current = useAppStore.getState().slots[index];
  current?.image?.close();
  await commitSlot(index, {
    image: null,
    width: 0,
    height: 0,
    rotation: 0,
    blurRegions: [],
    mask: null,
    maskRect: null,
    crop: null,
  });
}

export async function rotateSlot(index: number) {
  const current = useAppStore.getState().slots[index];
  if (!current?.image) return;
  await commitSlot(index, { rotation: (current.rotation + 90) % 360 });
}
