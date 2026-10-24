// Real host UI + real 301 MB ZIP. All installation/profile writes are isolated.
// This intentionally does not open the workbench or load a GPU model.
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const host=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const artifact=path.resolve(process.env.NGR_PROGRESS_TEST_ZIP||'E:/快速找界面/release/0.7.0/quick-interface-finder-0.7.0-extension.zip');
const executablePath=path.join(host,'node_modules/electron/dist/electron.exe');
const out=path.resolve(process.env.NGR_PROGRESS_TEST_OUT||'E:/快速找界面/artifacts/extension-import-progress');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'qif-import-progress-'));
const profile=path.join(temporary,'host-profile');
await fs.mkdir(out,{recursive:true});
for(const file of [artifact,executablePath])await fs.access(file);
const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(artifact))hash.update(chunk);
const report={fixtureOnly:true,host,executablePath,artifact,artifactBytes:(await fs.stat(artifact)).size,artifactSha256:hash.digest('hex'),temporary,profile,packagedHost:false,hostInstallerRebuilt:false,noGPUModelLoaded:true};
const env={...process.env,NGR_E2E_USER_DATA:profile,APPDATA:path.join(temporary,'Roaming'),LOCALAPPDATA:path.join(temporary,'Local'),ELECTRON_ENABLE_LOGGING:'0'};
for(const directory of [profile,env.APPDATA,env.LOCALAPPDATA])await fs.mkdir(directory,{recursive:true});
for(const field of ['ELECTRON_RUN_AS_NODE','QUICK_UI_USER_DATA','QUICK_UI_MODEL_PATH','QUICK_UI_LIBRARY_PATH','QUICK_UI_PYTHON','QUICK_UI_DEV_URL','NODE_OPTIONS'])delete env[field];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const screenshots=[],testOperations=[];
let app,page,ownedProcess;
const errors=[],snapshots=[];
async function operation(name,fn){const value={name,fromUTC:Date.now()};testOperations.push(value);try{return await fn();}finally{value.toUTC=Date.now();}}
const screenshot=async name=>{await operation('screenshot:'+name,()=>page.screenshot({path:path.join(out,name),animations:'disabled'}));screenshots.push(name);};
const until=async(read,accept,label,timeout=180000)=>{
 const deadline=Date.now()+timeout;let value;
 while(Date.now()<deadline){value=await read();if(accept(value))return value;await delay(200);}
 throw Error(label+': '+JSON.stringify(value));
};
const pick=async file=>app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
async function state(){
 const started=performance.now();
 const value=await page.evaluate(async()=>({status:await window.ngrDesktop.finderExtension.status(),visible:!document.querySelector('#finderExtensionProgress')?.hidden,stage:document.querySelector('#finderExtensionProgressStage')?.textContent||'',counts:document.querySelector('#finderExtensionProgressCounts')?.textContent||'',hint:document.querySelector('#finderExtensionProgressHint')?.textContent||'',barValue:document.querySelector('#finderExtensionProgressBar')?.getAttribute('value'),statusText:document.querySelector('#finderExtensionStatus')?.textContent||''}));
 value.rpcMs=performance.now()-started;return value;
}
async function openManager(){
 if(await page.locator('#finderExtensionDialog').isVisible())return;
 await page.locator('#moreFeaturesEntry').click();
 await page.locator('#finderExtensionManage').click();
 await expect(page.locator('#finderExtensionDialog')).toBeVisible();
}
async function startHeartbeats(){
 await app.evaluate(()=>{
  const last=performance.now();globalThis.qifProgressHeartbeat={last,maxGap:0,ticks:0,gaps:[]};
  globalThis.qifProgressHeartbeatTimer=setInterval(()=>{const s=globalThis.qifProgressHeartbeat,now=performance.now(),gap=now-s.last;s.maxGap=Math.max(s.maxGap,gap);s.last=now;s.ticks++;s.gaps.push({gapMs:gap,atUTC:Date.now()});},50);
  const cp=process.getBuiltinModule('child_process'),original=cp.spawn;globalThis.qifProgressSpawns=[];cp.spawn=function(file,args,options){globalThis.qifProgressSpawns.push({file:String(file),args});return original.call(this,file,args,options);};
 });
 await page.evaluate(()=>{
  globalThis.qifProgressHeartbeat={last:performance.now(),maxGap:0,ticks:0,gaps:[]};
  globalThis.qifProgressHeartbeatTimer=setInterval(()=>{const s=globalThis.qifProgressHeartbeat,now=performance.now(),gap=now-s.last;s.maxGap=Math.max(s.maxGap,gap);s.last=now;s.ticks++;s.gaps.push({gapMs:gap,atUTC:Date.now()});},50);
 });
}
async function stopHeartbeats(){
 const main=await app.evaluate(()=>{clearInterval(globalThis.qifProgressHeartbeatTimer);return globalThis.qifProgressHeartbeat;});
 const renderer=await page.evaluate(()=>{clearInterval(globalThis.qifProgressHeartbeatTimer);return globalThis.qifProgressHeartbeat;});
 const summarize=value=>{
  const classified=value.gaps.map(gap=>({...gap,testOperations:testOperations.filter(op=>op.fromUTC<=gap.atUTC&&(op.toUTC||Date.now())>=gap.atUTC-gap.gapMs).map(op=>op.name),phase:snapshots.filter(sample=>Date.parse(sample.progress.updatedAt)<=gap.atUTC).at(-1)?.progress.phase||'startup-or-before-first-progress'}));
  return {ticks:value.ticks,maxGapMs:value.maxGap,passiveMaxGapMs:Math.max(0,...classified.filter(gap=>!gap.testOperations.length).map(gap=>gap.gapMs)),topGaps:classified.sort((a,b)=>b.gapMs-a.gapMs).slice(0,12)};
 };
 return {main:summarize(main),renderer:summarize(renderer)};
}

try{
 app=await electron.launch({executablePath,args:[path.join(host,'desktop/main/index.mjs')],cwd:host,env,timeout:120000});
 ownedProcess=app.process();page=await app.firstWindow();
 page.on('pageerror',error=>errors.push(error.message));
 await page.waitForLoadState('load');
 await page.waitForFunction(()=>Boolean(window.ngrDesktop?.finderExtension));
 await until(()=>app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed());return Boolean(window?.isVisible()&&window?.isMaximized());}),value=>value,'Host must finish showing before measurements',30000);
 report.electronVersion=await app.evaluate(()=>process.versions.electron);assert.match(report.electronVersion,/^43\./);
 assert.equal((await page.evaluate(()=>window.ngrDesktop.finderExtension.status())).state,'not-found');
 await openManager();await pick(artifact);await startHeartbeats();await delay(2000);report.idleBaselineHeartbeats=await stopHeartbeats();await startHeartbeats();
 const started=performance.now();
 await operation('click-import',()=>page.locator('#finderExtensionChoose').click());
 const first=await until(state,value=>value.status.progress?.state==='running','Import did not enter running state');
 assert.ok(first.visible,'progress panel must be shown while importing');
 await expect(page.locator('#finderExtensionChoose')).toBeDisabled();await expect(page.locator('#finderExtensionLaunch')).toBeDisabled();
 report.busyButtonsDisabled=true;
 let captured=false,reopened=false,lastRevision=-1,installed;
 const deadline=Date.now()+180000;
 while(Date.now()<deadline){
  const value=await state(),progress=value.status.progress;
  if(progress&&progress.revision!==lastRevision){snapshots.push({atMs:performance.now()-started,observedAtUTC:Date.now(),rpcMs:value.rpcMs,progress,ui:{visible:value.visible,stage:value.stage,counts:value.counts,barValue:value.barValue,hint:value.hint}});lastRevision=progress.revision;}
  if(progress?.state==='error')throw Error('Valid ZIP import failed: '+JSON.stringify(value));
  if(!captured&&progress?.state==='running'&&Number(progress.total)>0&&Number(progress.done)>0&&value.visible){
   await until(()=>page.locator('#finderExtensionProgressCounts').innerText(),text=>/\d/.test(text),'No visible import counts',10000);
   await screenshot('import-progress.png');captured=true;
   await operation('close-and-reopen-manager',async()=>{await page.locator('#finderExtensionClose').click();await expect(page.locator('#finderExtensionDialog')).not.toBeVisible();await openManager();});
   await expect(page.locator('#finderExtensionProgress')).toBeVisible();
   reopened=true;
  }
  if(progress?.state==='complete'&&value.status.bound){installed=value.status;break;}
  await delay(180);
 }
 if(!installed)throw Error('Real ZIP install timeout: '+JSON.stringify(await state()));
 report.elapsedMs=performance.now()-started;
 report.heartbeats=await stopHeartbeats();
 assert.ok(report.heartbeats.main.ticks>10,'main event loop must keep advancing during import');
 assert.ok(report.heartbeats.renderer.ticks>10,'renderer must keep advancing during import');
 report.testOperations=testOperations;
 report.maxSampledStatusRPCMs=Math.max(...snapshots.map(value=>value.rpcMs));
 // No main-thread latency SLA was requested: measure its actual gaps, separating
 // debugger screenshot/control work from passive import, rather than invent one.
 report.mainThread1500msDiagnosticExceeded=report.heartbeats.main.maxGapMs>=1500;
 assert.ok(report.heartbeats.renderer.maxGapMs<1500,JSON.stringify(report.heartbeats));
 assert.ok(captured,'must capture real determinate import progress');assert.ok(reopened,'dialog reopen must retain running/completed progress');
 const phases=[...new Set(snapshots.map(value=>value.progress.phase))];
 assert.ok(phases.some(value=>['extracting','verifying'].includes(value)),JSON.stringify(phases));
 assert.ok(snapshots.filter(value=>value.progress.state==='running'&&value.progress.done>0).length>1,'progress must advance more than once');
 assert.ok(snapshots.some(value=>/MB|MiB|KB|GB|字节/.test(value.ui.counts)),'visible size progress is required');
 report.progressPhases=phases;report.progressSamples=snapshots.length;report.closeAndReopenPreservesProgress=true;report.zipImportedThroughHostUI=true;
 report.installedVersion=installed.bound.version;report.installedRoot=installed.bound.root;
 assert.ok(installed.bound.root.startsWith(profile));
 await expect(page.locator('#finderExtensionLaunch')).toBeEnabled();
 await screenshot('import-complete.png');
 const bindingFile=path.join(path.dirname(installed.bound.root),'current.json'),binding=await fs.readFile(bindingFile,'utf8');
 const bad=path.join(temporary,'invalid-extension.zip');await fs.writeFile(bad,'synthetic invalid zip for isolated test');
 await pick(bad);await page.locator('#finderExtensionChoose').click();
 const failed=await until(state,value=>value.status.progress?.state==='error','Bad ZIP did not display error',30000);
 assert.ok(failed.visible);assert.ok(failed.hint.trim()||failed.statusText.trim());assert.equal(failed.status.bound?.version,installed.bound.version);
 assert.equal(await fs.readFile(bindingFile,'utf8'),binding,'bad import must preserve installed current pointer');
 await expect(page.locator('#finderExtensionChoose')).toBeEnabled();
 await screenshot('import-error.png');report.invalidZIPShowsErrorAndKeepsPreviousVersion=true;
 report.noGPUModelLoaded=await app.evaluate(()=>!globalThis.qifProgressSpawns.some(value=>/python\.exe$/i.test(value.file)));
 assert.equal(report.noGPUModelLoaded,true);assert.deepEqual(errors,[]);
 report.pageErrors=errors;report.screenshots=screenshots;report.success=true;
 const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Host quit timeout')),20000);ownedProcess.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 await app.evaluate(({app})=>{app.quit();}).catch(()=>{});report.normalHostQuit=await exited;assert.equal(report.normalHostQuit.code,0);
 await app.close().catch(()=>{});app=null;
 await fs.writeFile(path.join(out,'progress-e2e.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'progress-samples.json'),JSON.stringify(snapshots,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
 report.success=false;report.error=error.stack||String(error);report.pageErrors=errors;report.screenshots=screenshots;
 if(page&&!page.isClosed())await screenshot('import-failed.png').catch(()=>{});
 await fs.writeFile(path.join(out,'progress-e2e-failed.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'progress-samples-failed.json'),JSON.stringify(snapshots,null,2));throw error;
}finally{
 if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});if(ownedProcess?.exitCode===null)ownedProcess.kill();}
}
