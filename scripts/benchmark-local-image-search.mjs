import { performance } from "node:perf_hooks";
import { EMBEDDING_DIMENSIONS } from "../desktop/services/local-image-search/constants.mjs";
import { exactTopK } from "../desktop/services/local-image-search/vector-search.mjs";

const rowCount = 100_000;
const beforeBytes = process.memoryUsage().arrayBuffers;
const vectors = new Float32Array(rowCount * EMBEDDING_DIMENSIONS);
const query = new Float32Array(EMBEDDING_DIMENSIONS);
for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
  query[dimension] = ((dimension % 17) - 8) / 64;
}
for (let row = 0; row < rowCount; row += 1) {
  const offset = row * EMBEDDING_DIMENSIONS;
  for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
    vectors[offset + dimension] = ((row * 13 + dimension * 7) % 101 - 50) / 64;
  }
}

const samples = [];
let result;
for (let run = 0; run < 7; run += 1) {
  const started = performance.now();
  result = exactTopK(vectors, rowCount, query, 50);
  samples.push(performance.now() - started);
}
samples.sort((left, right) => left - right);
const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
const vectorMemoryMb = (process.memoryUsage().arrayBuffers - beforeBytes) / 1024 / 1024;
const summary = { rowCount, dimensions: EMBEDDING_DIMENSIONS, p95Ms, vectorMemoryMb, resultCount: result.length };
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (p95Ms > 2000) throw new Error(`p95 ${p95Ms.toFixed(1)}ms exceeds 2000ms target`);
if (vectorMemoryMb > 300) throw new Error(`vector memory ${vectorMemoryMb.toFixed(1)}MB exceeds 300MB target`);
