import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(scriptDirectory, "..");

export const projectPaths = Object.freeze({
  cache: path.join(projectRoot, ".cache"),
  npmCache: path.join(projectRoot, ".cache", "npm"),
  electronCache: path.join(projectRoot, ".cache", "electron"),
  electronBuilderCache: path.join(projectRoot, ".cache", "electron-builder"),
  playwrightCache: path.join(projectRoot, ".cache", "ms-playwright"),
  temp: path.join(projectRoot, ".tmp"),
  logs: path.join(projectRoot, "logs"),
  generated: path.join(projectRoot, "build", "generated"),
  devArtifacts: path.join(projectRoot, "artifacts", "dev"),
  testArtifacts: path.join(projectRoot, "artifacts", "test"),
});

export function ensureProjectDirectories() {
  for (const directory of Object.values(projectPaths)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}
export function createProjectEnvironment(overrides = {}) {
  ensureProjectDirectories();
  return {
    ...process.env,
    npm_config_cache: projectPaths.npmCache,
    NPM_CONFIG_CACHE: projectPaths.npmCache,
    ELECTRON_CACHE: projectPaths.electronCache,
    electron_config_cache: projectPaths.electronCache,
    ELECTRON_BUILDER_CACHE: projectPaths.electronBuilderCache,
    PLAYWRIGHT_BROWSERS_PATH: projectPaths.playwrightCache,
    TMP: projectPaths.temp,
    TEMP: projectPaths.temp,
    TMPDIR: projectPaths.temp,
    ...overrides,
  };
}
