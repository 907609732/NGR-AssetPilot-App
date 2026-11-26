import test from 'node:test';
import assert from 'node:assert/strict';
import lock from '../build/finder-builtin.lock.json' with { type: 'json' };
import { verifyFinderArtifact } from '../scripts/prepare-builtin-finder-ci.mjs';

test('the private Finder artifact must match the two pinned commits and content identity', () => {
  const manifest = { sourceCommit: lock.commit, sha256: lock.sha256, bytes: lock.bytes };
  assert.doesNotThrow(() => verifyFinderArtifact(lock.artifactCommit, manifest));
  assert.throws(() => verifyFinderArtifact('main', manifest), /私有产物提交/);
  assert.throws(() => verifyFinderArtifact('0'.repeat(40), manifest), /私有产物提交/);
  for (const altered of [
    { sourceCommit: '0'.repeat(40) },
    { sha256: '0'.repeat(64) },
    { bytes: lock.bytes - 1 },
  ]) {
    assert.throws(() => verifyFinderArtifact(lock.artifactCommit, { ...manifest, ...altered }), /产物清单/);
  }
});
