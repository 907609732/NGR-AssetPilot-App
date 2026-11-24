import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'assetpilot-finder-smoke-'));
const env = {...process.env, NGR_E2E_USER_DATA: profile};
delete env.ELECTRON_RUN_AS_NODE;
const [packagedExe] = process.argv.slice(2);
const executablePath = path.resolve(packagedExe || 'node_modules/electron/dist/electron.exe');
const instance = await _electron.launch({ executablePath, args: packagedExe ? [] : ['.', '--ngr-edition=test'], env, timeout: 40000 });
try {
  const host = await instance.firstWindow();
  const open = async () => {
    await host.waitForFunction(() => typeof window.ngrDesktop?.finderExtension?.open === 'function');
    const pending = instance.waitForEvent('window', { timeout: 15000 });
    await host.evaluate(() => window.ngrDesktop.finderExtension.open());
    const finder = await pending;
    await finder.waitForFunction(() => document.body.innerText.includes('我的资料库'));
    return finder;
  };
  let finder = await open();
  const closed = finder.waitForEvent('close');
  await instance.evaluate(({ BrowserWindow }, needle) =>
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(needle)).close(),
    'finder-builtin');
  await closed;
  assert.equal(host.isClosed(), false);
  finder = await open();
  const versions = await instance.evaluate(async ({app}) => {
    const sqlite = process.getBuiltinModule('node:sqlite');
    const database = new sqlite.DatabaseSync(':memory:');
    database.exec('CREATE TABLE abi_check (value INTEGER); INSERT INTO abi_check VALUES (42)');
    const sqliteValue = database.prepare('SELECT value FROM abi_check').get().value;
    database.close();
    const path = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
    const sharp = require('sharp');
    const pixels = await sharp({create:{width:1,height:1,channels:3,background:'white'}}).raw().toBuffer();
    const fs = process.getBuiltinModule('node:fs');
    const onnxBundled = fs.existsSync(path.join(path.dirname(require.resolve('onnxruntime-node')), '../bin/napi-v6/win32/x64/onnxruntime_binding.node'));
    return {sqliteValue, sharpBytes:pixels.length, onnxBundled,

    packaged: app.isPackaged, arch: process.arch, electron: process.versions.electron,
    node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi};
  });
  assert.equal(versions.packaged, Boolean(packagedExe));
  assert.equal(versions.sqliteValue, 42);
  if (packagedExe) assert.equal(versions.onnxBundled, false);
  assert.equal(versions.sharpBytes, 3);
  console.log(versions);
} finally {
  await instance.close();
}
