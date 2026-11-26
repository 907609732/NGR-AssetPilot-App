import test from 'node:test';
import assert from 'node:assert/strict';
import lock from '../build/finder-builtin.lock.json' with { type: 'json' };
import { pinnedFinderUrl, prepareBuiltinFinder } from '../scripts/prepare-builtin-finder-ci.mjs';

test('the cloud component path is derived from both immutable lock identifiers', () => {
  const base = 'https://private.example/packages/';
  assert.equal(pinnedFinderUrl(base).href, base + lock.commit + '/' + lock.sha256 + '/app.asar');
  assert.throws(() => pinnedFinderUrl('http://private.example'), /HTTPS/);
  assert.throws(() => pinnedFinderUrl(base + '?token=placeholder'), /目录地址/);
  assert.throws(() => pinnedFinderUrl(base, { ...lock, commit: 'main' }), /组件锁/);
});

test('cloud staging drops credentials on a cross-origin redirect and rejects wrong bytes', async () => {
  const first = pinnedFinderUrl('https://private.example/packages/');
  const redirect = 'https://storage.example/signed-object';
  const requests = [];
  await assert.rejects(prepareBuiltinFinder({
    base: 'https://private.example/packages/',
    token: 'test-placeholder',
    async request(url, options) {
      requests.push([url.href, options.headers.Authorization]);
      return url.href === first.href
        ? Response.redirect(redirect)
        : new Response('incorrect artifact bytes');
    },
  }), /固定版本不匹配/);
  assert.deepEqual(requests, [[first.href, 'Bearer test-placeholder'], [redirect, undefined]]);
});
