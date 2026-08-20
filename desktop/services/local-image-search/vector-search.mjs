export function exactTopK(vectors, rowCount, query, limit) {
  if (!(vectors instanceof Float32Array) || !(query instanceof Float32Array)) {
    throw new TypeError("vectors and query must be Float32Array");
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || query.length < 1 || vectors.length !== rowCount * query.length) {
    throw new RangeError("vector dimensions do not match");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("limit must be a non-negative integer");
  const resultLimit = Math.min(limit, rowCount);
  if (resultLimit === 0) return [];
  const dimensions = query.length;
  const heap = [];

  const isWorse = (left, right) => (
    left.score < right.score || (left.score === right.score && left.rowIndex > right.rowIndex)
  );
  const isBetter = (left, right) => (
    left.score > right.score || (left.score === right.score && left.rowIndex < right.rowIndex)
  );
  const siftUp = (index) => {
    let cursor = index;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (!isWorse(heap[cursor], heap[parent])) break;
      [heap[parent], heap[cursor]] = [heap[cursor], heap[parent]];
      cursor = parent;
    }
  };
  const siftDown = (index) => {
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = left + 1;
      let worst = cursor;
      if (left < heap.length && isWorse(heap[left], heap[worst])) worst = left;
      if (right < heap.length && isWorse(heap[right], heap[worst])) worst = right;
      if (worst === cursor) break;
      [heap[cursor], heap[worst]] = [heap[worst], heap[cursor]];
      cursor = worst;
    }
  };

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    let score = 0;
    const offset = rowIndex * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      score += query[dimension] * vectors[offset + dimension];
    }
    const candidate = { rowIndex, score };
    if (heap.length < resultLimit) {
      heap.push(candidate);
      siftUp(heap.length - 1);
    } else if (isBetter(candidate, heap[0])) {
      heap[0] = candidate;
      siftDown(0);
    }
  }
  return heap.sort((left, right) => right.score - left.score || left.rowIndex - right.rowIndex);
}
