import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrationRoot = path.join(projectRoot, "integrations", "tapd-report");
const rendererOutput = path.join(projectRoot, "app", "tapd-report");
const runtimeOutput = path.join(projectRoot, "desktop", "services", "tapd-report-runtime.mjs");

await mkdir(path.join(rendererOutput, "assets"), { recursive: true });

await build({
  entryPoints: [path.join(integrationRoot, "runtime-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: runtimeOutput,
  external: ["electron", "exceljs", "playwright-core", "sharp", "sql.js"],
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
});

await build({
  entryPoints: [path.join(integrationRoot, "src", "renderer", "main.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome132",
  jsx: "automatic",
  outfile: path.join(rendererOutput, "assets", "index.js"),
  legalComments: "none",
  sourcemap: false,
  minify: true,
  logLevel: "info",
});

await writeFile(
  path.join(rendererOutput, "index.html"),
  `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TAPD 周报／月报</title>
    <link rel="stylesheet" href="assets/index.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="assets/index.js"></script>
  </body>
</html>
`,
  "utf8",
);

process.stdout.write("TAPD report integration built.\n");
