import { create } from "zustand";
import { DEFAULT_MODEL, type ModelId } from "./segmentation/models";
import {
  type BackgroundMode,
  type ExportFormat,
  type LayoutId,
  MAX_SLOTS,
  type Slot,
} from "@/types";

function emptySlot(index: number): Slot {
  return {
    id: `slot-${index}`,
    image: null,
    width: 0,
    height: 0,
    rotation: 0,
    blurRegions: [],
    mask: null,
    maskRect: null,
    crop: null,
    preview: null,
  };
}

// 배치를 바꿔도 이미 찍은 사진이 사라지지 않도록 슬롯은 항상 최대 개수를 유지하고,
// 화면에서는 현재 배치에 필요한 만큼만 보여준다.
const initialSlots = () => Array.from({ length: MAX_SLOTS }, (_, i) => emptySlot(i));

interface AppState {
  itemName: string;
  /**
   * itemName이 자동 인식으로 채워진 값인지, 사용자가 직접 입력한 값인지.
   * true인 동안에는 재촬영할 때마다 자동 인식이 값을 다시 덮어쓸 수 있고,
   * 사용자가 한 글자라도 직접 입력하면 false로 굳어져 더는 자동으로 안 바뀐다.
   */
  itemNameIsAuto: boolean;
  /** 마지막으로 인식한 사진의 품목 후보(점수 높은 순). 품목명 칸 아래 버튼으로 보여준다. */
  itemNameCandidates: string[];
  layout: LayoutId;
  slots: Slot[];
  background: BackgroundMode;
  format: ExportFormat;
  modelId: ModelId;
  /** 칸 사이 여백(px). 구분선 표시 여부와 함께 합성에 쓰인다. */
  gap: number;
  divider: boolean;
  setMeta: (patch: { itemName?: string }) => void;
  setAutoItemName: (itemName: string) => void;
  setItemNameCandidates: (candidates: string[]) => void;
  setLayout: (layout: LayoutId) => void;
  replaceSlot: (index: number, slot: Slot) => void;
  swapSlots: (a: number, b: number) => void;
  setBackground: (background: BackgroundMode) => void;
  setFormat: (format: ExportFormat) => void;
  setModelId: (modelId: ModelId) => void;
  setGap: (gap: number) => void;
  setDivider: (divider: boolean) => void;
  resetAll: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  itemName: "",
  itemNameIsAuto: true,
  itemNameCandidates: [],
  layout: "1x1",
  slots: initialSlots(),
  background: "white",
  format: "jpeg",
  modelId: DEFAULT_MODEL,
  gap: 24,
  divider: false,

  // 사용자가 직접 입력한 값이므로 이후로는 자동 인식이 덮어쓰지 않게 잠근다.
  setMeta: (patch) => set("itemName" in patch ? { ...patch, itemNameIsAuto: false } : patch),
  setAutoItemName: (itemName) => set({ itemName, itemNameIsAuto: true }),
  setItemNameCandidates: (itemNameCandidates) => set({ itemNameCandidates }),
  setLayout: (layout) => set({ layout }),

  replaceSlot: (index, slot) =>
    set((state) => {
      const slots = state.slots.slice();
      slots[index] = slot;
      return { slots };
    }),

  swapSlots: (a, b) =>
    set((state) => {
      if (a === b) return state;
      const slots = state.slots.slice();
      [slots[a], slots[b]] = [slots[b], slots[a]];
      return { slots };
    }),

  setBackground: (background) => set({ background }),
  setFormat: (format) => set({ format }),
  setModelId: (modelId) => set({ modelId }),
  setGap: (gap) => set({ gap }),
  setDivider: (divider) => set({ divider }),

  resetAll: () =>
    set((state) => {
      for (const slot of state.slots) {
        slot.image?.close();
        if (slot.preview) URL.revokeObjectURL(slot.preview);
      }
      return { itemName: "", itemNameIsAuto: true, itemNameCandidates: [], slots: initialSlots() };
    }),
}));
