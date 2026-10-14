/**
 * 품목 자동 인식용 CLIP 이미지 모델 (OpenAI CLIP ViT-B/32, MIT 라이선스 · 8비트 양자화본).
 *
 * 사진을 512차원 벡터로 바꾸고, 미리 계산해 둔 품목 설명(clipEmbeddings.json)과 가장 가까운 품목을 고른다.
 * ImageNet 분류 모델과 달리 이어폰·카드·열쇠·보조배터리처럼 원하는 품목을 글로 정해 추가할 수 있다.
 * 품목을 바꾸려면 scripts/build-clip-embeddings.mjs를 고쳐 다시 실행한다. (두 곳의 모델·커밋이 같아야 한다)
 *
 * 커밋 sha로 고정해 파일이 바뀌지 않게 한다. Hugging Face는 CORS를 허용해 브라우저에서 바로 받을 수 있다.
 */
export const CLASSIFIER_MODEL = {
  url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/vision_model_quantized.onnx",
  size: 224,
  // CLIP 학습 때 쓴 정규화 값 (preprocessor_config.json)
  mean: [0.48145466, 0.4578275, 0.40821073] as [number, number, number],
  std: [0.26862954, 0.26130258, 0.27577711] as [number, number, number],
  /** 이미지·텍스트 벡터 유사도에 곱하는 배율. CLIP 학습값(logit_scale = 100)이다. */
  logitScale: 100,
  /** 안내 문구용 대략 크기(MB) */
  megabytes: 89,
};
