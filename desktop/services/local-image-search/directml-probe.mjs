import { performance } from "node:perf_hooks";
import path from "node:path";
import * as ort from "onnxruntime-node";

const [, , visionPath, rawDeviceId, rawProbeSpec] = process.argv;
const deviceId = Number(rawDeviceId);
let probeSpec = {};
try {
  probeSpec = rawProbeSpec ? JSON.parse(Buffer.from(rawProbeSpec, "base64url").toString("utf8")) : {};
} catch {
  probeSpec = {};
}

function report(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = exitCode;
}

function errorCode(error) {
  return String(error?.code || error?.message || error?.name || "DIRECTML_PROBE_FAILED").slice(0, 160);
}

if (!visionPath || !Number.isInteger(deviceId) || deviceId < 0) {
  report({ ok: false, error: "DIRECTML_PROBE_ARGUMENT_INVALID" }, 2);
} else {
  let session;
  try {
    session = await ort.InferenceSession.create(visionPath, {
      executionProviders: [{ name: "dml", deviceId }],
      graphOptimizationLevel: "basic",
      executionMode: "sequential",
      enableMemPattern: false,
      externalData: Array.isArray(probeSpec.externalData)
        ? probeSpec.externalData.filter((item) => item && typeof item.path === "string"
          && path.basename(item.path) === item.path && typeof item.data === "string" && path.isAbsolute(item.data))
        : [],
    });
    const inputName = probeSpec.inputName
      || (session.inputNames.includes("pixel_values") ? "pixel_values" : session.inputNames[0]);
    const pixelType = ["float32", "uint8", "int8"].includes(probeSpec.pixelType)
      ? probeSpec.pixelType
      : "float32";
    const layout = probeSpec.layout === "NHWC" ? "NHWC" : "NCHW";
    const width = Number.isInteger(Number(probeSpec.width)) ? Number(probeSpec.width) : 224;
    const height = Number.isInteger(Number(probeSpec.height)) ? Number(probeSpec.height) : 224;
    let successful = null;
    const failures = [];
    for (const batchSize of [16, 8, 4, 1]) {
      try {
        const length = batchSize * 3 * width * height;
        const input = pixelType === "uint8"
          ? new Uint8Array(length)
          : pixelType === "int8"
            ? new Int8Array(length)
            : new Float32Array(length);
        const dimensions = layout === "NHWC"
          ? [batchSize, height, width, 3]
          : [batchSize, 3, height, width];
        const feeds = { [inputName]: new ort.Tensor(pixelType, input, dimensions) };
        await session.run(feeds);
        const timings = [];
        for (let sample = 0; sample < 3; sample += 1) {
          const startedAt = performance.now();
          await session.run(feeds);
          timings.push(performance.now() - startedAt);
        }
        timings.sort((left, right) => left - right);
        const durationMs = timings[Math.floor(timings.length / 2)];
        successful = {
          ok: true,
          deviceId,
          batchSize,
          durationMs,
          millisecondsPerImage: durationMs / batchSize,
          failedBatchSizes: failures,
        };
        break;
      } catch (error) {
        failures.push({ batchSize, error: errorCode(error) });
      }
    }
    if (!successful) throw new Error("DIRECTML_ALL_BATCH_SIZES_FAILED");
    report(successful, 0);
  } catch (error) {
    report({ ok: false, deviceId, error: errorCode(error) }, 1);
  } finally {
    try {
      await session?.release();
    } catch {
      // The probe process is exiting; a failed provider release is non-fatal.
    }
  }
}
