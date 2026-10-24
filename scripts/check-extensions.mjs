import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./project-env.mjs";

export async function checkExtensions({fetchImpl = fetch, manifestPath = path.join(projectRoot, "build/extensions.json")} = {}) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const results = [];
  for (const extension of manifest.extensions) {
    let publishedVersion = null, checkState = "unchecked", message;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${extension.repository}/releases/latest`, {headers:{Accept:"application/vnd.github+json", "User-Agent":"NGR-AssetPilot-Extension-Check"}, signal:AbortSignal.timeout(7000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = await response.json();
      publishedVersion = String(release.tag_name || "").replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(publishedVersion)) throw new Error("公开版本格式无效");
      checkState = "checked";
      message = !extension.verifiedVersion ? "尚未完成兼容验证，请验证后更新扩展清单" : publishedVersion === extension.verifiedVersion ? "沿用已验证扩展版本" : "公开版本与已验证版本不同，请检查扩展版本更新及兼容验证";
    } catch { message = "公开版本未检查（网络或服务不可用），沿用已记录版本；发布前请检查扩展更新"; }
    results.push({...extension, publishedVersion, checkState, message});
  }
  return {schemaVersion:1, checkedAt:new Date().toISOString(), extensions:results};
}

export function extensionReleaseNotes(report) {
  return "## 扩展版本检查\n\n" + report.extensions.map((entry) => {
    const availability = entry.publicDownloadAvailable === false
      ? `扩展包尚未公开下载，单独交付；公开旧独立版不能导入。[项目发布页](${entry.downloadUrl})`
      : `[下载扩展](${entry.downloadUrl})`;
    return `- ${entry.name}：已验证 ${entry.verifiedVersion || "未验证"}；公开版本 ${entry.checkState === "checked" ? entry.publishedVersion : "未检查"}。${entry.message}。${availability}`;
  }).join("\n") + "\n";
}

export async function writeExtensionReport(outputDirectory, options) {
  const report = await checkExtensions(options);
  await fs.mkdir(outputDirectory,{recursive:true});
  await fs.writeFile(path.join(outputDirectory,"extension-report.json"),JSON.stringify(report,null,2)+"\n");
  await fs.writeFile(path.join(outputDirectory,"extension-release-notes.md"),extensionReleaseNotes(report));
  for(const entry of report.extensions) console.log(`【扩展更新提醒】${entry.name}：已验证 ${entry.verifiedVersion || "未验证"}；公开 ${entry.publishedVersion || "未检查"}。${entry.message}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await writeExtensionReport(path.join(projectRoot,".tmp","extension-check")); }
  catch(error) { console.warn(`【扩展更新提醒】清单检查未完成：${error.message}`); }
}
