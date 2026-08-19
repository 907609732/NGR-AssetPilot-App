import * as ort from "onnxruntime-node";

const [, , visionPath, textPath] = process.argv;
if (!visionPath || !textPath) process.exit(2);
try {
  const options = { executionProviders: ["dml"], graphOptimizationLevel: "all" };
  const vision = await ort.InferenceSession.create(visionPath, options);
  const text = await ort.InferenceSession.create(textPath, options);
  const visionInput = vision.inputNames.includes("pixel_values") ? "pixel_values" : vision.inputNames[0];
  await vision.run({ [visionInput]: new ort.Tensor("float32", new Float32Array(3 * 224 * 224), [1, 3, 224, 224]) });
  const textFeeds = {};
  for (const name of text.inputNames) {
    textFeeds[name] = new ort.Tensor("int64", BigInt64Array.from([101n, 102n, 0n, 0n]), [1, 4]);
  }
  await text.run(textFeeds);
  await vision.release();
  await text.release();
  process.exit(0);
} catch {
  process.exit(1);
}
