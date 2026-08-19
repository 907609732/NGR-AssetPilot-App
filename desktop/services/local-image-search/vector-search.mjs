import { EMBEDDING_DIMENSIONS } from "./constants.mjs";

export function exactTopK(vectors, rowCount, query, limit) {
  if (!(vectors instanceof Float32Array) || !(query instanceof Float32Array)) {
    throw new TypeError("vectors and query must be Float32Array");
  }
  if (query.length !== EMBEDDING_DIMENSIONS || vectors.length !== rowCount * EMBEDDING_DIMENSIONS) {
    throw new RangeError("vector dimensions do not match");
  }
  const best = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    let score = 0;
    const offset = rowIndex * EMBEDDING_DIMENSIONS;
    for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
      score += query[dimension] * vectors[offset + dimension];
    }
    if (best.length < limit || score > best[best.length - 1].score) {
      best.push({ rowIndex, score });
      best.sort((left, right) => right.score - left.score);
      if (best.length > limit) best.pop();
    }
  }
  return best;
}
