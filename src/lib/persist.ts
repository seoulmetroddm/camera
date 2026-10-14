import type { BlurRegion, CropRect, Slot } from "@/types";
import { renderSlot } from "./canvas/render";
import { canvasToBlob, context2d, createCanvas } from "./canvas/util";
import { toPreviewUrl } from "./image";
import { useAppStore } from "./store";

/**
 * 작업 중인 접수 건을 기기 안(IndexedDB)에 저장하고, 페이지가 새로 로드되면 되살린다.
 *
 * 사진은 메모리에만 있어서 페이지가 새로 로드되면 전부 사라진다. 그런데 새로 로드되는 경우가 꽤 많다.
 * - 사용 중에 새 버전이 배포되면 Next.js가 화면 이동을 전체 새로고침으로 바꾼다
 * - 휴대폰이 메모리가 부족하면(카메라 앱을 띄울 때 등) 뒤에 있던 탭을 버렸다가 다시 연다
 * - 실수로 새로고침하거나 뒤로 가기를 누른다
 *
 * 저장은 이 기기 브라우저 안에만 하고 밖으로 보내지 않는다. 개인정보가 담긴 사진이 오래 남지 않도록
 * 마지막 작업 후 EXPIRE_MS가 지나면 되살리지 않고 지운다. '새 접수 시작'을 누르면 바로 지운다.
 */

const DB_NAME = "lostfound-session";
const STORE = "kv";
const KEY = "current";
const EXPIRE_MS = 24 * 60 * 60 * 1000;
/** 연달아 바뀔 때 매번 저장하지 않도록 잠깐 모았다가 저장한다. */
const SAVE_DELAY_MS = 300;

interface SavedSlot {
  id: string;
  width: number;
  height: number;
  rotation: number;
  blurRegions: BlurRegion[];
  crop: CropRect | null;
  maskRect: CropRect | null;
  image: Blob | null;
  mask: Blob | null;
}

interface Snapshot {
  savedAt: number;
  itemName: string;
  itemNameIsAuto: boolean;
  itemNameCandidates: string[];
  layout: ReturnType<typeof useAppStore.getState>["layout"];
  background: ReturnType<typeof useAppStore.getState>["background"];
  format: ReturnType<typeof useAppStore.getState>["format"];
  modelId: ReturnType<typeof useAppStore.getState>["modelId"];
  gap: number;
  divider: boolean;
  slots: SavedSlot[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ── 인코딩 캐시 ─────────────────────────────────────────────
// 원본 사진은 찍은 뒤로 바뀌지 않으므로 한 번만 인코딩한다.
const imageBlobs = new WeakMap<ImageBitmap, Promise<Blob>>();
// 마스크는 브러시가 캔버스를 직접 고치므로 캔버스 기준으로는 캐시할 수 없다.
// 대신 슬롯 객체가 그대로면(커밋이 없었으면) 이전 결과를 재사용한다.
const maskBlobs = new WeakMap<Slot, Promise<Blob>>();

function encodeImage(image: ImageBitmap): Promise<Blob> {
  let blob = imageBlobs.get(image);
  if (!blob) {
    const canvas = createCanvas(image.width, image.height);
    context2d(canvas).drawImage(image, 0, 0);
    blob = canvasToBlob(canvas, "image/jpeg", 0.95);
    imageBlobs.set(image, blob);
  }
  return blob;
}

function encodeMask(slot: Slot): Promise<Blob> | null {
  if (!slot.mask) return null;
  let blob = maskBlobs.get(slot);
  if (!blob) {
    // 알파가 곧 마스크이므로 PNG로 저장한다.
    blob = canvasToBlob(slot.mask, "image/png");
    maskBlobs.set(slot, blob);
  }
  return blob;
}

async function toSnapshot(): Promise<Snapshot | null> {
  const state = useAppStore.getState();
  if (!state.slots.some((slot) => slot.image) && !state.itemName) return null;

  const slots: SavedSlot[] = [];
  for (const slot of state.slots) {
    slots.push({
      id: slot.id,
      width: slot.width,
      height: slot.height,
      rotation: slot.rotation,
      blurRegions: slot.blurRegions,
      crop: slot.crop,
      maskRect: slot.maskRect,
      image: slot.image ? await encodeImage(slot.image) : null,
      mask: (await encodeMask(slot)) ?? null,
    });
  }

  return {
    savedAt: Date.now(),
    itemName: state.itemName,
    itemNameIsAuto: state.itemNameIsAuto,
    itemNameCandidates: state.itemNameCandidates,
    layout: state.layout,
    background: state.background,
    format: state.format,
    modelId: state.modelId,
    gap: state.gap,
    divider: state.divider,
    slots,
  };
}

async function restoreSlot(saved: SavedSlot): Promise<Slot> {
  const image = saved.image ? await createImageBitmap(saved.image) : null;
  let mask: HTMLCanvasElement | null = null;
  if (saved.mask) {
    const bitmap = await createImageBitmap(saved.mask);
    mask = createCanvas(bitmap.width, bitmap.height);
    context2d(mask).drawImage(bitmap, 0, 0);
    bitmap.close();
  }

  const slot: Slot = {
    id: saved.id,
    image,
    width: saved.width,
    height: saved.height,
    rotation: saved.rotation,
    blurRegions: saved.blurRegions,
    mask,
    maskRect: saved.maskRect,
    crop: saved.crop,
    preview: null,
  };
  if (image) {
    const rendered = renderSlot(slot, "transparent");
    slot.preview = rendered ? await toPreviewUrl(rendered) : null;
  }
  return slot;
}

/** 저장해 둔 접수 건이 있으면 스토어에 되살린다. 오래됐거나 깨졌으면 지운다. */
async function restore() {
  const snapshot = await withStore<Snapshot | undefined>("readonly", (s) => s.get(KEY));
  if (!snapshot) return;
  if (Date.now() - snapshot.savedAt > EXPIRE_MS) {
    await clearSaved();
    return;
  }

  const slots = await Promise.all(snapshot.slots.map(restoreSlot));
  useAppStore.setState({
    itemName: snapshot.itemName,
    itemNameIsAuto: snapshot.itemNameIsAuto,
    itemNameCandidates: snapshot.itemNameCandidates,
    layout: snapshot.layout,
    background: snapshot.background,
    format: snapshot.format,
    modelId: snapshot.modelId,
    gap: snapshot.gap,
    divider: snapshot.divider,
    slots,
  });
}

/**
 * '새 접수 시작' 때 부른다. 대기 중이거나 진행 중인 저장을 무효로 하고 저장된 접수 건을 바로 지운다.
 * (차례를 기다리면 앞선 저장이 끝날 때까지 지난 사진이 남아 있게 된다)
 */
export function discardSaved(): Promise<void> {
  generation += 1;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return clearSaved();
}

export async function clearSaved() {
  try {
    await withStore("readwrite", (s) => s.delete(KEY));
  } catch {
    // 저장소를 못 쓰는 환경이면 지울 것도 없다.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
/** discardSaved() 때마다 올린다. 그 전에 시작된 저장은 쓰지 않고 버린다. */
let generation = 0;

/** 저장은 겹치지 않게 차례대로 한다. 빈 상태면 저장 대신 지운다. */
function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const startedAt = generation;
  saving = saving
    .then(async () => {
      if (startedAt !== generation) return;
      const snapshot = await toSnapshot();
      // 인코딩하는 사이 '새 접수 시작'을 눌렀으면 지난 사진을 다시 써넣지 않는다.
      if (startedAt !== generation) return;
      if (snapshot) await withStore("readwrite", (s) => s.put(snapshot, KEY));
      else await clearSaved();
    })
    .catch(() => {
      // 저장 공간 부족 등으로 실패해도 작업은 계속할 수 있어야 한다.
    });
}

/**
 * 기다리지 않고 바로 저장한다. 사진을 새로 찍었을 때 쓴다.
 * 찍자마자 다른 화면으로 넘어가다 페이지가 새로 로드되면, 모아서 저장하는 사이에 사진을 잃을 수 있다.
 */
export function persistNow() {
  if (started) saveNow();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

let started: Promise<void> | null = null;

/**
 * 앱 시작 시 한 번 호출한다. 저장된 접수 건을 되살린 뒤부터 변경 사항을 저장한다.
 * 되살리기가 끝나기 전에 사용자가 촬영하면 덮어쓸 수 있으므로, 끝날 때까지 화면을 기다리게 해야 한다.
 */
export function startPersistence(): Promise<void> {
  started ??= (async () => {
    try {
      if (typeof indexedDB === "undefined") return;
      await restore();
    } catch {
      // 되살리기에 실패하면 빈 상태로 시작한다.
    }

    useAppStore.subscribe(scheduleSave);
    // 화면이 가려지면(카메라 앱 실행, 다른 앱 전환) 탭이 버려질 수 있으므로 바로 저장한다.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveNow();
    });
    window.addEventListener("pagehide", saveNow);
  })();
  return started;
}
