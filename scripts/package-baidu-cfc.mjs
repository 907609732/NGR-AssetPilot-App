import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";

import { projectRoot } from "./project-env.mjs";

const sourceDirectory = path.join(projectRoot, "infra", "cfc", "baidu-translation");
const outputDirectory = path.join(projectRoot, "artifacts", "cfc");
const outputPath = path.join(outputDirectory, "NGR-AssetPilot-Baidu-CFC.zip");
const checksumPath = `${outputPath}.sha256`;
const allowedFiles = ["index.js", "package.json"];

fs.mkdirSync(outputDirectory, { recursive: true });
const zip = new AdmZip();
for (const fileName of allowedFiles) {
  const filePath = path.join(sourceDirectory, fileName);
  if (!fs.existsSync(filePath)) throw new Error(`CFC 打包缺少 ${fileName}`);
  zip.addLocalFile(filePath, "", fileName);
}
zip.writeZip(outputPath);

const archive = fs.readFileSync(outputPath);
const sha256 = createHash("sha256").update(archive).digest("hex");
fs.writeFileSync(checksumPath, `${sha256}  ${path.basename(outputPath)}\n`, "utf8");
console.log(`CFC 部署包已生成：${outputPath}`);
console.log(`SHA-256：${sha256}`);
