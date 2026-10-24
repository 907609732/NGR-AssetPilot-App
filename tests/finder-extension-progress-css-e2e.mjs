// Focused CSS verification; no ZIP import, GPU, real profile or host installer.
import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const host=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reuse=process.env.NGR_PROGRESS_CSS_TEST_PROFILE&&path.resolve(process.env.NGR_PROGRESS_CSS_TEST_PROFILE);
if(reuse&&(path.basename(reuse)!=='host-profile'||path.dirname(path.dirname(reuse)).toLowerCase()!==path.resolve(os.tmpdir()).toLowerCase()||!/^qif-import-progress-[a-z0-9]+$/i.test(path.basename(path.dirname(reuse)))))throw Error('Reuse is restricted to this test family\'s isolated temporary host-profile');
const temporary=reuse?path.dirname(reuse):await fs.mkdtemp(path.join(os.tmpdir(),'qif-progress-css-')),profile=reuse||path.join(temporary,'profile'),out='E:/快速找界面/artifacts/extension-import-progress';
await fs.mkdir(profile,{recursive:true});await fs.mkdir(out,{recursive:true});
const env={...process.env,NGR_E2E_USER_DATA:profile,ELECTRON_ENABLE_LOGGING:'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
let app;const report={fixtureOnly:true,cssVerificationOnly:true,noZIPImported:true,noGPUModelLoaded:true,temporary,reusedInstalledFixture:Boolean(reuse),hostInstallerBuilt:false};
try{
 app=await electron.launch({executablePath:path.join(host,'node_modules/electron/dist/electron.exe'),args:[path.join(host,'desktop/main/index.mjs')],cwd:host,env,timeout:60000});
 const page=await app.firstWindow();await page.waitForLoadState('load');await page.waitForFunction(()=>Boolean(window.ngrDesktop?.finderExtension));
 report.idleStatusRPC=[];
 for(let index=0;index<5;index++){
  const started=performance.now(),state=await page.evaluate(()=>window.ngrDesktop.finderExtension.status());
  report.idleStatusRPC.push({ms:performance.now()-started,state:state.state,version:state.bound?.version});
  if(reuse)assert.equal(state.bound?.version,'0.7.0');
 }
 report.maxIdleStatusRPCMs=Math.max(...report.idleStatusRPC.map(value=>value.ms));
 await page.locator('#moreFeaturesEntry').click();await page.locator('#finderExtensionManage').click();
 await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>new Promise(resolve=>{globalThis.qifCSSResolveDialog=resolve;});});
 await page.locator('#finderExtensionChoose').click();
 await expect(page.locator('#finderExtensionProgress')).toBeVisible();
 await expect(page.locator('#finderExtensionProgressBar')).not.toHaveAttribute('value',/.+/);
 report.indeterminate=await page.evaluate(()=>{const track=document.querySelector('#finderExtensionProgressTrack'),style=getComputedStyle(track,'::after');return {animationName:style.animationName,content:style.content,width:style.width};});
 assert.equal(report.indeterminate.animationName,'update-indeterminate');assert.notEqual(report.indeterminate.content,'none');
 report.determinate=await page.evaluate(()=>{const bar=document.querySelector('#finderExtensionProgressBar');bar.value=25;const style=getComputedStyle(document.querySelector('#finderExtensionProgressTrack'),'::after');return {animationName:style.animationName,content:style.content};});
 assert.ok(['none','normal'].includes(report.determinate.content),JSON.stringify(report.determinate));
 await page.emulateMedia({reducedMotion:'reduce'});
 report.reducedMotion=await page.evaluate(()=>{document.querySelector('#finderExtensionProgressBar').removeAttribute('value');const style=getComputedStyle(document.querySelector('#finderExtensionProgressTrack'),'::after');return {animationName:style.animationName,content:style.content,left:style.left};});
 assert.equal(report.reducedMotion.animationName,'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.screenshot({path:path.join(out,'import-indeterminate.png'),animations:'disabled'});
 await app.evaluate(()=>{globalThis.qifCSSResolveDialog({canceled:true,filePaths:[]});});
 await expect(page.locator('#finderExtensionChoose')).toBeEnabled();
 report.cancelled=await page.evaluate(()=>({state:document.querySelector('#finderExtensionProgress').dataset.state,hidden:document.querySelector('#finderExtensionProgressBar').hidden,content:getComputedStyle(document.querySelector('#finderExtensionProgressTrack'),'::after').content}));
 assert.equal(report.cancelled.state,'cancelled');assert.equal(report.cancelled.hidden,true);assert.ok(['none','normal'].includes(report.cancelled.content));
 report.success=true;await fs.writeFile(path.join(out,'progress-css-e2e.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){report.success=false;report.error=error.stack||String(error);await fs.writeFile(path.join(out,'progress-css-e2e-failed.json'),JSON.stringify(report,null,2));throw error;}
finally{if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}}
