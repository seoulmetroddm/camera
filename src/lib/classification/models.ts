/**
 * 물건 종류 자동 인식용 모델. ImageNet-1k 1000종으로 분류한 뒤
 * categorize.ts에서 유실물 관련 큰 분류(가방/지갑/우산 등)로 다시 묶는다.
 * ONNX Model Zoo 공식 배포본(Apache-2.0). 커밋 sha로 고정해 파일이 바뀌지 않게 한다.
 */
export const CLASSIFIER_MODEL = {
  url: "https://huggingface.co/onnxmodelzoo/mobilenetv2-12/resolve/23a2a25eaaa6fcd61865414c8a1acf13dda66b7a/mobilenetv2-12.onnx",
  size: 224,
  mean: [0.485, 0.456, 0.406] as [number, number, number],
  std: [0.229, 0.224, 0.225] as [number, number, number],
};
