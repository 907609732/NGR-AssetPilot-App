import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseManagedProviderConfig } from "../desktop/services/managed-provider-config.mjs";
import { projectPaths } from "./project-env.mjs";

const outputPath = path.join(projectPaths.generated, "managed-provider-config.json");

function configFromEnvironment(env) {
  const endpoint = String(env.NGR_BAIDU_CFC_ENDPOINT || "").trim();
  const bearerToken = String(env.NGR_BAIDU_CFC_BEARER_TOKEN || "").trim();
  if (!endpoint && !bearerToken) return null;
  return parseManagedProviderConfig({
    version: 1,
    baiduCfc: {
      enabled: true,
      endpoint,
      bearerToken,
    },
  });
}

function readExistingConfig() {
  if (!fs.existsSync(outputPath)) return null;
  try {
    return parseManagedProviderConfig(JSON.parse(fs.readFileSync(outputPath, "utf8")));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function prepareManagedProviderConfig({ env = process.env, required = false } = {}) {
  const fromEnvironment = configFromEnvironment(env);
  const config = fromEnvironment || readExistingConfig();
  if (!config) {
    if (required) {
      throw new Error("正式版构建缺少 NGR_BAIDU_CFC_ENDPOINT 与 NGR_BAIDU_CFC_BEARER_TOKEN");
    }
    return { enabled: false, outputPath };
  }
  if (required && !config.baiduCfc.bearerToken) {
    throw new Error("正式版托管翻译必须配置 CFC Bearer Token");
  }
  writeConfig(config);
  return { enabled: true, outputPath };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const required = process.argv.includes("--required");
    const result = prepareManagedProviderConfig({ required });
    console.log(result.enabled ? `托管翻译配置已生成：${result.outputPath}` : "未配置托管翻译，开发环境继续使用用户自有凭据");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "托管翻译配置生成失败");
    process.exitCode = 1;
  }
}
