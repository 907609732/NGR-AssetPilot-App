import * as ort from "onnxruntime-node";
import { AutoTokenizer, env } from "@huggingface/transformers";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;

let input = "";
for await (const chunk of process.stdin) {
  input += chunk.toString("utf8");
  if (input.length > 1024 * 1024) process.exit(2);
}
const payload = JSON.parse(input || "null");
if (!payload || typeof payload !== "object") process.exit(2);

const baseSessionOptions = {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "basic",
  executionMode: "sequential",
  enableMemPattern: false,
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
};

function sessionOptions(externalData) {
  if (!Array.isArray(externalData) || externalData.length === 0) return baseSessionOptions;
  return { ...baseSessionOptions, externalData };
}

function metadataFor(session, name, input = true) {
  const collection = input ? session.inputMetadata : session.outputMetadata;
  if (Array.isArray(collection)) return collection.find((item) => item?.name === name) || null;
  return collection?.[name] || null;
}

function selectName(session, preferred, { input = false, dimensions = 0 } = {}) {
  const names = input ? session.inputNames : session.outputNames;
  if (preferred) {
    if (!names.includes(preferred)) throw new Error(input ? "MODEL_INPUT_NAME_INVALID" : "MODEL_OUTPUT_NAME_INVALID");
    return preferred;
  }
  const candidates = names.filter((name) => {
    const metadata = metadataFor(session, name, input);
    if (!metadata?.isTensor) return false;
    const shape = metadata.shape || [];
    if (input) return shape.length === 4;
    if (![1, 2].includes(shape.length)) return false;
    const last = Number(shape.at(-1));
    return !dimensions || !Number.isFinite(last) || last === dimensions;
  });
  if (!candidates.length) throw new Error(input ? "MODEL_IMAGE_INPUT_NOT_FOUND" : "MODEL_EMBEDDING_OUTPUT_NOT_FOUND");
  return candidates[0];
}

function tensorData(type, length, fill = 0) {
  if (type === "float32") return new Float32Array(length).fill(fill);
  if (type === "float64") return new Float64Array(length).fill(fill);
  if (type === "uint8") return new Uint8Array(length).fill(fill);
  if (type === "int8") return new Int8Array(length).fill(fill);
  if (type === "uint16") return new Uint16Array(length).fill(fill);
  if (type === "int16") return new Int16Array(length).fill(fill);
  if (type === "uint32") return new Uint32Array(length).fill(fill);
  if (type === "int32") return new Int32Array(length).fill(fill);
  if (type === "int64") return new BigInt64Array(length).fill(BigInt(fill));
  if (type === "uint64") return new BigUint64Array(length).fill(BigInt(fill));
  if (type === "bool") return new Uint8Array(length).fill(fill ? 1 : 0);
  throw new Error("MODEL_TENSOR_TYPE_UNSUPPORTED");
}

function convertTensorData(type, source) {
  const target = tensorData(type, source.length, 0);
  const bigintTarget = target instanceof BigInt64Array || target instanceof BigUint64Array;
  for (let index = 0; index < source.length; index += 1) {
    target[index] = bigintTarget ? BigInt(source[index]) : Number(source[index]);
  }
  return target;
}

function tensorDimensions(tensor, expectedBatchSize = 1) {
  const dims = tensor?.dims || [];
  if (expectedBatchSize === 1 && dims.length === 1) return Number(dims[0]);
  if (dims.length === 2 && Number(dims[0]) === expectedBatchSize) return Number(dims[1]);
  throw new Error("MODEL_OUTPUT_SHAPE_UNSUPPORTED");
}

function assertFiniteOutput(tensor) {
  if (!tensor?.data || tensor.data.length < 1) throw new Error("MODEL_OUTPUT_EMPTY");
  if (!["float32", "float64"].includes(tensor.type)) throw new Error("MODEL_OUTPUT_TYPE_UNSUPPORTED");
  for (let index = 0; index < tensor.data.length; index += 1) {
    if (!Number.isFinite(Number(tensor.data[index]))) throw new Error("MODEL_OUTPUT_NOT_FINITE");
  }
}

async function inspectVision() {
  const session = await ort.InferenceSession.create(payload.visionPath, sessionOptions(payload.visionExternalData));
  try {
    const inputName = selectName(session, payload.preprocessing?.inputName, { input: true });
    const outputName = selectName(session, payload.preprocessing?.outputName, {
      dimensions: Number(payload.preprocessing?.dimensions || 0),
    });
    if (session.inputNames.length !== 1) throw new Error("MODEL_MULTIPLE_IMAGE_INPUTS_UNSUPPORTED");
    const inputMetadata = metadataFor(session, inputName, true);
    const type = inputMetadata?.type || payload.preprocessing?.pixelType || "float32";
    if (payload.preprocessing?.pixelType && type !== payload.preprocessing.pixelType) {
      throw new Error("MODEL_IMAGE_INPUT_TYPE_MISMATCH");
    }
    const layout = payload.preprocessing?.layout === "NHWC" ? "NHWC" : "NCHW";
    const height = Number(payload.preprocessing?.height || 224);
    const width = Number(payload.preprocessing?.width || 224);
    const dims = layout === "NHWC" ? [1, height, width, 3] : [1, 3, height, width];
    const data = tensorData(type, 3 * width * height, 0);
    const outputs = await session.run({ [inputName]: new ort.Tensor(type, data, dims) });
    const tensor = outputs[outputName];
    assertFiniteOutput(tensor);
    return {
      inputName,
      outputName,
      inputType: type,
      inputShape: dims,
      outputShape: [...tensor.dims],
      outputType: tensor.type,
      dimensions: tensorDimensions(tensor),
      inputs: [...session.inputNames],
      outputs: [...session.outputNames],
    };
  } finally {
    await session.release();
  }
}

async function inspectText(dimensions) {
  const session = await ort.InferenceSession.create(payload.textPath, sessionOptions(payload.textExternalData));
  try {
    if (typeof payload.tokenizerRoot !== "string" || !payload.tokenizerRoot) {
      throw new Error("MODEL_TOKENIZER_DIRECTORY_REQUIRED");
    }
    let tokenizer;
    try {
      tokenizer = await AutoTokenizer.from_pretrained(payload.tokenizerRoot, { local_files_only: true });
    } catch {
      throw new Error("MODEL_TOKENIZER_LOAD_FAILED");
    }
    let encoded;
    try {
      encoded = await tokenizer(["本地图片", "local image"], {
        padding: true,
        truncation: true,
        max_length: 32,
      });
    } catch {
      throw new Error("MODEL_TOKENIZER_ENCODE_FAILED");
    }
    const feeds = {};
    for (const name of session.inputNames) {
      const metadata = metadataFor(session, name, true);
      if (!metadata?.isTensor || (metadata.shape || []).length !== 2) throw new Error("MODEL_TEXT_INPUT_UNSUPPORTED");
      const type = metadata.type || "int64";
      const encodedTensor = encoded[name]
        || (name === payload.preprocessing?.textInputName ? encoded.input_ids : null);
      if (encodedTensor?.data && Array.isArray(encodedTensor.dims)) {
        const data = encodedTensor.type === type ? encodedTensor.data : convertTensorData(type, encodedTensor.data);
        feeds[name] = new ort.Tensor(type, data, [...encodedTensor.dims]);
      } else if (/token_type/i.test(name) && encoded.input_ids?.dims) {
        const dims = [...encoded.input_ids.dims];
        feeds[name] = new ort.Tensor(type, tensorData(type, dims.reduce((product, item) => product * item, 1), 0), dims);
      } else {
        throw new Error("MODEL_TOKENIZER_OUTPUT_MISSING");
      }
    }
    const requestedInput = payload.preprocessing?.textInputName;
    if (requestedInput && !session.inputNames.includes(requestedInput)) throw new Error("MODEL_TEXT_INPUT_NAME_INVALID");
    const outputName = selectName(session, payload.preprocessing?.textOutputName, { dimensions });
    const outputs = await session.run(feeds);
    const tensor = outputs[outputName];
    assertFiniteOutput(tensor);
    if (tensorDimensions(tensor, 2) !== dimensions) throw new Error("MODEL_TEXT_DIMENSIONS_MISMATCH");
    return {
      inputName: requestedInput || session.inputNames[0],
      inputNames: [...session.inputNames],
      outputName,
      outputShape: [...tensor.dims],
      outputType: tensor.type,
      inputs: [...session.inputNames],
      outputs: [...session.outputNames],
    };
  } finally {
    await session.release();
  }
}

try {
  const vision = await inspectVision();
  const text = payload.type === "image-text" ? await inspectText(vision.dimensions) : null;
  process.stdout.write(JSON.stringify({
    vision,
    text,
    dimensions: vision.dimensions,
    supportsText: Boolean(text),
  }));
} catch (error) {
  process.stderr.write(String(error?.message || "MODEL_VALIDATION_FAILED").slice(0, 4096));
  process.exitCode = 1;
}
