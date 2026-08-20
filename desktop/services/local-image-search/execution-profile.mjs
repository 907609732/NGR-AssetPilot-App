import { createHash } from "node:crypto";

export const INDEX_EXECUTION_PROFILE_VERSION = "execution-v2";

export function createIndexExecutionProfile(contract) {
  const canonical = {
    version: INDEX_EXECUTION_PROFILE_VERSION,
    modelFingerprint: String(contract.modelFingerprint || ""),
    preprocessingVersion: String(contract.preprocessingVersion || ""),
    preprocessing: contract.preprocessing || {},
    provider: contract.provider === "dml" ? "dml" : "cpu",
    batchSize: Number(contract.batchSize || 1),
    deviceId: contract.provider === "dml" && Number.isInteger(contract.deviceId) ? contract.deviceId : null,
    driverFingerprint: contract.provider === "dml" ? String(contract.driverFingerprint || "unknown") : null,
    onnxRuntimeVersion: String(contract.onnxRuntimeVersion || "unknown"),
    architecture: String(contract.architecture || process.arch),
  };
  return `${INDEX_EXECUTION_PROFILE_VERSION}:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}
