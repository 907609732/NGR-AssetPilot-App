import { createRequire } from 'node:module';
const { _electron } = createRequire(import.meta.url)(process.env.FINDER_TEST_PLAYWRIGHT || 'playwright-core');
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import sharp from 'sharp';

const [hostExe, finderExe, archive, translationDirectory, modelDirectory, onnxArchive] = process.argv.slice(2);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'assetpilot-dual-packages-'));
const library = path.join(scratch, 'library');
await fs.mkdir(library);
const png = (await sharp({
  create: {width:64, height:64, channels:3, background:'#096a72'},
}).png().toBuffer()).toString('base64');
const wave = Buffer.alloc(8844);
wave.write('RIFF'); wave.writeUInt32LE(8836,4); wave.write('WAVEfmt ',8);
wave.writeUInt32LE(16,16); wave.writeUInt16LE(1,20); wave.writeUInt16LE(1,22);
wave.writeUInt32LE(44100,24); wave.writeUInt32LE(88200,28);
wave.writeUInt16LE(2,32); wave.writeUInt16LE(16,34); wave.write('data',36); wave.writeUInt32LE(8800,40);
const open = (instance, file) => instance.evaluate(({dialog}, selected) => {
  dialog.showOpenDialog = async () => ({canceled:false, filePaths:[selected]});
}, file);
async function verify(exe, hosted) {
  const profile = path.join(scratch, hosted ? 'host' : 'standalone');
  const builtInModel = hosted ? process.env.NGR_TEST_LOCAL_MODEL_ROOT : '';
  if (builtInModel) {
    const directory = path.join(profile,'local-image-search');
    await fs.mkdir(directory,{recursive:true});
    await fs.cp(builtInModel,path.join(directory,'models'),{recursive:true});
  }
  const env = {...process.env};
  for (const key of ['QUICK_UI_USER_DATA','QUICK_UI_LIBRARY_PATH','QUICK_UI_MODEL_PATH','QUICK_UI_PYTHON','ELECTRON_RUN_AS_NODE']) delete env[key];
  env[hosted ? 'NGR_E2E_USER_DATA' : 'QUICK_UI_USER_DATA'] = profile;
  const instance = await _electron.launch({executablePath:path.resolve(exe), env, timeout:40000});
  try {
    const top = await instance.firstWindow();
    let page = top;
    if (hosted) {
      await top.waitForFunction(() => Boolean(window.ngrDesktop?.finderExtension));
      const next = instance.waitForEvent('window', {timeout:20000});
      await top.evaluate(() => window.ngrDesktop.finderExtension.open());
      page = await next;
    }
    await page.waitForFunction(() => Boolean(window.quickUI));
    const invoke = (method, payload) => page.evaluate(([name, args]) => window.quickUI[name](args), [method,payload]);
    assert.equal((await invoke('models',{action:'status'})).runtime.ready,false);
    await open(instance, library);
    if (!hosted) {
      await invoke('createLibrary',{name:'双版本普通目录验收'});
      const initial = {id:'verification-system',name:'跨版本系统',aliases:[],category:'',tags:[],description:'初始描述',gm:[],deleted:false,screens:[]};
      await invoke('save',{payload:initial,parents:[]});
      const first = (await invoke('search',{text:'跨版本系统'})).results[0];
      await invoke('save',{payload:{...initial,description:'编辑验收'},parents:first.heads});
      await invoke('catalogSave',{payload:{id:'verification',kind:'folder',name:'跨版本资料'},parents:[]});
    } else {
      await invoke('chooseLibrary');
      assert.ok((await invoke('catalogList')).records.some(record => record.payload.name === '跨版本资料'));
    }

    const system = (await invoke('search',{text:'跨版本系统'})).results[0];
    assert.equal(system.payload.description,'编辑验收');

    const image = await invoke('importBytes',{name:hosted ? 'host.png' : 'standalone.png',folderId:'verification',base64:png});
    const list = async id => (await invoke('catalogList')).records.find(row => row.recordId === id);
    const imageRow = await list(image.id);
    assert.ok(imageRow.payload.file);
    assert.equal(imageRow.payload.metadata.width,64);
    const removed = await invoke('catalogImageDelete',{id:image.id,parents:imageRow.heads});
    assert.ok(removed);
    const trashed = (await invoke('catalogImageTrash')).items.find(item => item.id === image.id || item.recordId === image.id);
    assert.ok(trashed);
    await invoke('catalogImageRestore',{id:image.id,parents:(await list(image.id)).heads});
    assert.ok(!(await list(image.id)).payload.deleted);

    const audio = await invoke('importBytes',{name:hosted ? 'host.wav' : 'standalone.wav',folderId:'verification',base64:wave.toString('base64')});
    assert.match((await list(audio.id)).payload.mediaWarning,/FFmpeg/);
    await open(instance, archive);
    await invoke('models',{action:'import-runtime'});
    assert.equal((await invoke('models',{action:'status'})).runtime.ready,true);
    await invoke('catalogPreview',{id:audio.id});
    assert.ok((await list(audio.id)).payload.metadata.duration > 0);
    assert.ok(!(await list(audio.id)).payload.mediaWarning);
    if (process.env.FINDER_TEST_VIDEO) {
      const base64 = (await fs.readFile(process.env.FINDER_TEST_VIDEO)).toString('base64');
      const video = await invoke('importBytes',{name:'验收短片.mp4',folderId:'verification',base64});
      const row = await list(video.id);
      assert.ok(row.payload.previewHash);
      assert.equal(row.payload.metadata.videoCodec,'h264');
    }
    if (modelDirectory) {
      await open(instance, modelDirectory);
      await invoke('chooseModels');
      let ready = false;
      for (let second = 0; second < 180; second++) {
        const task = await invoke('models',{action:'status'});
        const {index} = await invoke('taskSnapshot',{});
        if (task.phase === 'error') throw new Error(task.error);
        if ((await invoke('boot')).library.ai.ready && index.known && index.done > 0) {
          ready = true;
          break;
        }
        await delay(1000);
      }
      assert.ok(ready, 'RTX model failed to become ready and index the image');
      const result = await invoke('search',{image:png});
      assert.ifError(result.error);
      assert.ok(result.assetMatches.length > 0);
    }
    if (hosted && translationDirectory) {
      assert.equal((await top.evaluate(() => window.ngrDesktop.offlineTranslation.getStatus())).ready,false);
      await instance.evaluate(({dialog}) => {dialog.showMessageBox = async () => ({response:1});});
      await instance.evaluate(({dialog}, args) => {
        dialog.showOpenDialog = async (_win, options) => ({
          canceled:false,
          filePaths:[options.properties.includes('openDirectory') ? args.translationDirectory : args.onnxArchive],
        });
      }, {translationDirectory, onnxArchive});
      assert.equal((await top.evaluate(() => window.ngrDesktop.offlineTranslation.install())).ready,true);
      assert.match((await top.evaluate(() => window.ngrDesktop.offlineTranslation.translate({text:'测试翻译'}))).text,/Test Translation/i);
      if (builtInModel) {
        const engine = await top.evaluate(() => window.ngrDesktop.localImageSearch.getEngineStatus({modelId:"clip-b32-multilingual-v1"}));
        assert.notEqual(engine.fallbackReason,'ENGINE_STATUS_UNAVAILABLE');
        console.log(JSON.stringify({hostInference:engine.visionProvider}));
      }
    }
    console.log(JSON.stringify({hosted,profile,library,abi:await instance.evaluate(() => process.versions)}));
  } finally {
    await instance.close();
  }
}
await verify(finderExe, false);
if (hostExe !== "-") await verify(hostExe, true);
