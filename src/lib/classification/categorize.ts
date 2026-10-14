import { CLASSIFIER_MODEL } from "./models";

/**
 * 미리 계산해 둔 품목 설명 벡터 (scripts/build-clip-embeddings.mjs가 만든다).
 * label이 null인 항목은 "물건 아님(빈 탁자·바닥·손 등)"이다. 확률을 나눠 가져가
 * 애매한 사진에서 엉뚱한 품목이 높게 나오는 걸 막고, 후보에는 보여주지 않는다.
 */
interface CategoryTable {
  labels: (string | null)[];
  dim: number;
  vectors: Float32Array;
}

let tablePromise: Promise<CategoryTable> | null = null;

/** 약 100KB라 처음 인식할 때만 따로 불러온다. */
function loadTable(): Promise<CategoryTable> {
  tablePromise ??= import("./clipEmbeddings.json").then(({ default: data }) => {
    const bytes = Uint8Array.from(atob(data.embeddings), (c) => c.charCodeAt(0));
    return {
      labels: data.labels,
      dim: data.dim,
      vectors: new Float32Array(bytes.buffer),
    };
  });
  return tablePromise;
}

export interface CategoryScore {
  category: string;
  score: number;
}

/**
 * 사진 벡터(길이 1로 정규화됨)와 품목 설명 벡터의 유사도로 품목별 확률을 구해 높은 순으로 돌려준다.
 * CLIP 학습 방식대로 코사인 유사도에 logitScale을 곱해 softmax한다. "물건 아님"은 결과에서 뺀다.
 */
export async function rankCategories(embedding: Float32Array): Promise<CategoryScore[]> {
  const { labels, dim, vectors } = await loadTable();

  const logits = labels.map((_, k) => {
    let dot = 0;
    for (let i = 0; i < dim; i += 1) dot += embedding[i] * vectors[k * dim + i];
    return dot * CLASSIFIER_MODEL.logitScale;
  });
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);

  return labels
    .map((category, k) => ({ category, score: exps[k] / sum }))
    .filter((item): item is CategoryScore => item.category !== null)
    .sort((a, b) => b.score - a.score);
}

/**
 * 순위에서 품목명으로 자동으로 채울 품목 하나를 고른다.
 * 1등 확률이 minScore에 못 미치거나, 2등과 차이가 minLead배가 안 되면 확신이 없다고 보고 null.
 * (가방 0.31 / 지갑 0.29처럼 박빙이면 틀릴 확률이 높아, 자동으로 채우기보다 후보로만 보여준다.)
 */
export function pickCategory(ranked: CategoryScore[], minScore: number, minLead: number): string | null {
  const [first, second] = ranked;
  if (!first || first.score < minScore) return null;
  if (second && first.score < second.score * minLead) return null;
  return first.category;
}
