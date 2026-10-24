// Minimal official ASAR fixture: exercises the actual worker module and dependency
// from inside ASAR using Electron 43, without producing a host installer.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {_electron as electron} from '@playwright/test';

const require=createRequire(import.meta.url),asar=require('@electron/asar'),AdmZip=require('adm-zip');
const host=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'qif-worker-asar-'));
const source=path.join(temporary,'source'),out='E:/快速找界面/artifacts/extension-import-progress';
const archive=path.join(temporary,'worker-probe.asar'),tinySource=path.join(temporary,'tiny-source'),tinyAsar=path.join(temporary,'tiny.asar');
await fs.mkdir(path.join(source,'desktop/services'),{recursive:true});await fs.mkdir(tinySource);await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(source,'package.json'),JSON.stringify({type:'module',name:'finder-worker-asar-probe',version:'0.0.0'}));
for(const file of ['finder-extension-files.mjs','finder-extension-worker.mjs'])await fs.copyFile(path.join(host,'desktop/services',file),path.join(source,'desktop/services',file));
await fs.cp(path.join(host,'node_modules/adm-zip'),path.join(source,'node_modules/adm-zip'),{recursive:true});
await fs.writeFile(path.join(source,'desktop/services/probe-entry.mjs'),`import {Worker} from 'node:worker_threads';\nexport function probe(kind,payload){return new Promise((resolve,reject)=>{const messages=[];let result,failure;const worker=new Worker(new URL('./finder-extension-worker.mjs',import.meta.url),{workerData:{kind,payload}});worker.on('message',message=>{messages.push(message);if(message.type==='result')result=message.result;if(message.type==='error')failure=message.error;});worker.on('error',reject);worker.on('exit',code=>failure?reject(Error(failure.message)):code!==0?reject(Error('Worker exit '+code)):!result?reject(Error('No worker result')):resolve({result,messages,workerExited:true}));});}\n`);
await fs.writeFile(path.join(tinySource,'package.json'),JSON.stringify({name:'synthetic-extension-asar',version:'0.7.0'}));await fs.writeFile(path.join(tinySource,'index.cjs'),'module.exports={};');await asar.createPackage(tinySource,tinyAsar);
const data={'resources/app.asar':await fs.readFile(tinyAsar),'resources/worker/python.exe':Buffer.from('fixture only - never executed')};
const manifest={format:1,id:'quick-interface-finder',name:'快速找界面',version:'0.7.0',hostApi:1,entry:'resources/app.asar/desktop/main.cjs',platform:'win32',arch:'x64',files:Object.entries(data).map(([file,bytes])=>({path:file,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}))};
const zip=new AdmZip();for(const [file,bytes]of Object.entries(data))zip.addFile('quick-interface-finder-0.7.0/'+file,bytes);zip.addFile('quick-interface-finder-0.7.0/extension.json',Buffer.from(JSON.stringify(manifest)));const fixtureZip=path.join(temporary,'fixture.zip');zip.writeZip(fixtureZip);
await asar.createPackage(source,archive);
const appData=path.join(temporary,'profile');await fs.mkdir(appData);
const installRoot=path.join(temporary,'installed'),staging=path.join(installRoot,'.install-probe');
const harness=path.join(temporary,'harness.mjs');
await fs.writeFile(harness,`import {app,BrowserWindow} from 'electron';\napp.setPath('userData',${JSON.stringify(appData)});\napp.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('about:blank');try{const module=await import(${JSON.stringify(pathToFileURL(path.join(archive,'desktop/services/probe-entry.mjs')).href)});const install=await module.probe('install',${JSON.stringify({archivePath:fixtureZip,installRoot,staging})});const verify=await module.probe('verify',{root:install.result.entry.root,options:{verifyHashes:true}});globalThis.finderAsarProbe={success:true,electron:process.versions.electron,install,verify};}catch(error){globalThis.finderAsarProbe={success:false,electron:process.versions.electron,error:error.stack||String(error)};}});\n`);
const env={...process.env,ELECTRON_ENABLE_LOGGING:'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
let app;const report={temporary,fixtureOnly:true,hostInstallerBuilt:false,archive,workerAndHelperInsideASAR:true,dependencyInsideASAR:true};
try{
 app=await electron.launch({executablePath:path.join(host,'node_modules/electron/dist/electron.exe'),args:[harness],cwd:host,env,timeout:30000});await app.firstWindow();
 const deadline=Date.now()+30000;let value;
 while(Date.now()<deadline){value=await app.evaluate(()=>globalThis.finderAsarProbe);if(value)break;await new Promise(resolve=>setTimeout(resolve,100));}
 Object.assign(report,value||{success:false,error:'ASAR worker probe timed out'});
 await fs.writeFile(path.join(out,'worker-asar-probe.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 assert.equal(report.success,true,report.error);assert.equal(report.install.workerExited,true);assert.equal(report.verify.workerExited,true);assert.equal(report.verify.result.version,'0.7.0');
}finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}}
