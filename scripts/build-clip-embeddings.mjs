// 품목 분류용 CLIP 텍스트 임베딩을 미리 계산해 JSON으로 저장한다.
//
// 브라우저에서는 이미지 모델만 받고, 품목 이름 쪽(텍스트) 계산은 여기서 한 번만 해 둔다.
// 품목을 추가·수정했을 때만 다시 실행하면 된다. 결과 파일은 커밋한다.
//
// 실행 방법 (텍스트 모델을 처음 한 번 내려받는다):
//   npm i --no-save @huggingface/transformers@3
//   node scripts/build-clip-embeddings.mjs
//
// 모델은 src/lib/classification/models.ts의 CLIP 이미지 모델과 반드시 같은 것이어야 한다.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODEL_ID = "Xenova/clip-vit-base-patch32";
const MODEL_REVISION = "d15189d7028b43f1d3e65039190477f6af591c2a";
const OUTPUT = fileURLToPath(new URL("../src/lib/classification/clipEmbeddings.json", import.meta.url));

/**
 * 품목명 → 영어 설명들. CLIP은 영어로 학습돼 있어 설명은 영어로 쓴다.
 * 같은 품목의 여러 표현을 평균내므로, 실제로 자주 들어오는 모양을 골고루 적는다.
 * category가 null인 항목은 "물건이 아님"을 뜻한다. 확률을 나눠 가져가 애매한 사진에서 엉뚱한 품목이 채워지는 걸 막는다.
 */
const CATEGORIES = [
  { category: "지갑", phrases: ["wallet", "leather wallet", "card holder wallet", "long zip wallet"] },
  { category: "가방", phrases: ["backpack", "handbag", "shoulder bag", "tote bag", "crossbody bag"] },
  { category: "쇼핑백", phrases: ["shopping bag", "paper shopping bag", "plastic shopping bag"] },
  { category: "파우치", phrases: ["pouch", "cosmetic pouch", "small zipper pouch"] },
  { category: "휴대폰", phrases: ["smartphone", "mobile phone", "cell phone with a case"] },
  { category: "태블릿", phrases: ["tablet computer", "iPad"] },
  { category: "노트북", phrases: ["laptop computer", "notebook computer"] },
  { category: "이어폰", phrases: ["wireless earbuds", "earbuds charging case", "earphones", "AirPods case"] },
  { category: "헤드폰", phrases: ["headphones", "over-ear headset"] },
  { category: "보조배터리", phrases: ["power bank", "portable battery charger"] },
  { category: "충전기", phrases: ["phone charger", "charging cable", "USB power adapter"] },
  { category: "카드", phrases: ["credit card", "transit card", "ID card", "plastic card"] },
  { category: "열쇠", phrases: ["keys", "key ring with keys", "car key"] },
  { category: "우산", phrases: ["umbrella", "folding umbrella", "closed umbrella"] },
  { category: "안경", phrases: ["eyeglasses", "sunglasses", "glasses case"] },
  { category: "시계", phrases: ["wristwatch", "smartwatch"] },
  { category: "카메라", phrases: ["digital camera", "camera"] },
  { category: "의류", phrases: ["jacket", "coat", "sweater", "shirt", "hoodie", "pants"] },
  { category: "모자", phrases: ["hat", "baseball cap", "beanie"] },
  { category: "목도리", phrases: ["scarf", "knitted muffler"] },
  { category: "장갑", phrases: ["gloves", "pair of gloves"] },
  { category: "신발", phrases: ["shoes", "sneakers", "boots", "sandals"] },
  { category: "도서", phrases: ["book", "paperback book", "spiral notebook"] },
  { category: "서류", phrases: ["paper documents", "envelope", "file folder"] },
  { category: "문구", phrases: ["pen", "pencil case", "stationery"] },
  { category: "물병", phrases: ["water bottle", "tumbler", "thermos"] },
  { category: "화장품", phrases: ["cosmetics", "lipstick", "perfume bottle", "makeup compact"] },
  { category: "인형", phrases: ["stuffed animal", "plush toy", "doll"] },
  { category: "액세서리", phrases: ["necklace", "bracelet", "ring", "earrings"] },
  { category: "전자기기", phrases: ["remote control", "computer mouse", "keyboard", "game controller"] },
  { category: "악기", phrases: ["musical instrument", "guitar", "violin", "guitar case"] },
  { category: "운동용품", phrases: ["ball", "tennis racket", "badminton racket", "sports equipment"] },
  { category: "자물쇠", phrases: ["padlock"] },
  { category: "현금", phrases: ["cash", "banknotes", "coins"] },
  { category: "약", phrases: ["medicine", "pill bottle", "medicine box"] },
  { category: null, phrases: ["empty table", "floor", "wall", "person's hand", "blank background"] },
];

/** 설명 하나를 여러 문장 틀에 넣어 평균내면 표현에 덜 휘둘린다. (CLIP 논문의 prompt ensembling) */
const TEMPLATES = [
  "a photo of a {}.",
  "a photo of a {} on a table.",
  "a close-up photo of a {}.",
  "a photo of a lost {}.",
];

function normalize(vector) {
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

const { AutoTokenizer, CLIPTextModelWithProjection, env } = await import(
  process.env.TRANSFORMERS_PATH ?? "@huggingface/transformers"
);
// 윈도우에서 기본 캐시 경로가 너무 길면 모델 파일을 못 여는 일이 있어 바꿀 수 있게 한다.
if (process.env.MODEL_CACHE_DIR) env.cacheDir = process.env.MODEL_CACHE_DIR;
const options = { revision: MODEL_REVISION, dtype: "fp32" };
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, options);
const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, options);

const labels = [];
const vectors = [];
for (const { category, phrases } of CATEGORIES) {
  const sentences = phrases.flatMap((phrase) => TEMPLATES.map((t) => t.replace("{}", phrase)));
  const inputs = tokenizer(sentences, { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  const [count, dim] = text_embeds.dims;
  const data = text_embeds.data;

  // 문장별로 정규화한 뒤 평균내고 다시 정규화한다.
  const sum = new Array(dim).fill(0);
  for (let i = 0; i < count; i += 1) {
    const row = normalize(Array.from(data.slice(i * dim, (i + 1) * dim)));
    for (let j = 0; j < dim; j += 1) sum[j] += row[j];
  }
  labels.push(category);
  vectors.push(normalize(sum));
  console.log(`${category ?? "(물건 아님)"}: ${sentences.length}문장`);
}

const dim = vectors[0].length;
const flat = new Float32Array(vectors.length * dim);
vectors.forEach((v, i) => flat.set(v, i * dim));

writeFileSync(
  OUTPUT,
  `${JSON.stringify(
    {
      model: `${MODEL_ID}@${MODEL_REVISION}`,
      dim,
      labels,
      // Float32 리틀엔디언을 base64로 담는다. 숫자 배열 JSON보다 훨씬 작다.
      embeddings: Buffer.from(flat.buffer).toString("base64"),
    },
    null,
    2,
  )}\n`,
);
console.log(`저장: ${OUTPUT} (${labels.length}개 × ${dim}차원)`);
