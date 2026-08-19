import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/chenyuecai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = path.join(root, "sample_detection_assets");
const outDir = path.join(root, "ppt_assets");
const url = "http://127.0.0.1:8765/app/index.html";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

await page.goto(url, { waitUntil: "networkidle" });
await page.screenshot({ path: path.join(outDir, "01-home.png"), fullPage: true });

await page.click("#detectEntry");
await page.waitForSelector("#detectView.active");
await page.screenshot({ path: path.join(outDir, "02-detect-empty.png"), fullPage: true });

await page.selectOption("#detectionModeSelect", "ngr");
await page.selectOption("#duplicateSensitivitySelect", "low");
await page.setInputFiles("#detectionSingleInput", [
  path.join(assetDir, "normal_256x256.svg"),
  path.join(assetDir, "odd_size_257x128.svg"),
  path.join(assetDir, "large_2048x512.svg"),
  path.join(assetDir, "icon_not_square_128x64.svg"),
]);
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(outDir, "03-detect-results.png"), fullPage: true });

await page.click("#detectionRulesToggle");
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, "04-rules-expanded.png"), fullPage: true });

await page.click("#detectionProblemFilter");
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, "05-problems-only.png"), fullPage: true });

await page.click("#detectionProblemFilter");
await page.click("#detectionWarningFilter");
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, "06-warnings-only.png"), fullPage: true });

await page.selectOption("#detectionModeSelect", "icon");
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, "07-icon-mode.png"), fullPage: true });

await browser.close();
