import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";
import { LocalImageSearchStorage } from "../desktop/services/local-image-search/storage.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appEntry = path.join(projectRoot, "desktop", "main", "index.mjs");
const LARGE_LIBRARY_ID = "11111111-1111-4111-8111-111111111111";
const SMALL_LIBRARY_ID = "22222222-2222-4222-8222-222222222222";
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function seedLibrary(storage, { id, root, name, count, prefix = "" }) {
  fs.mkdirSync(root, { recursive: true });
  storage.createLibrary({ id, rootPath: root, name });
  const insert = storage.db.prepare(`
    INSERT INTO images(
      library_id, relative_path, mtime_ms, size_bytes, sha256, format,
      width, height, scan_generation, error_code
    ) VALUES (?, ?, ?, ?, ?, 'png', 1, 1, 1, NULL)
  `);
  storage.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 1; index <= count; index += 1) {
      const fileName = `asset-${String(index).padStart(3, "0")}.png`;
      const relativePath = prefix ? `${prefix}/${fileName}` : fileName;
      const absolutePath = path.join(root, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, ONE_PIXEL_PNG);
      insert.run(id, relativePath, 1_700_000_000_000 + index, ONE_PIXEL_PNG.length, `digest-${id}-${index}`);
    }
    storage.db.prepare(`
      UPDATE libraries
      SET catalog_status='ready', catalog_item_count=?, catalog_revision=1,
        catalog_last_scanned_at=?
      WHERE id=?
    `).run(count, new Date().toISOString(), id);
    storage.db.exec("COMMIT");
  } catch (error) {
    storage.db.exec("ROLLBACK");
    throw error;
  }
}

test("本地搜图默认素材库支持文件夹、100张分页、筛选和快速切库", { timeout: 45_000 }, async () => {
  fs.mkdirSync(path.join(projectRoot, ".tmp"), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(projectRoot, ".tmp", "asset-browser-e2e-"));
  const userData = path.join(runRoot, "UserData");
  const dataRoot = path.join(userData, "local-image-search");
  const storage = new LocalImageSearchStorage({ dataRoot });
  seedLibrary(storage, {
    id: LARGE_LIBRARY_ID,
    root: path.join(runRoot, "素材大库"),
    name: "素材大库",
    count: 105,
    prefix: "界面/按钮",
  });
  seedLibrary(storage, {
    id: SMALL_LIBRARY_ID,
    root: path.join(runRoot, "素材小库"),
    name: "素材小库",
    count: 3,
    prefix: "图标",
  });
  storage.close();

  const electronApp = await electron.launch({
    args: [appEntry],
    cwd: projectRoot,
    env: {
      ...process.env,
      APPDATA: path.join(runRoot, "Roaming"),
      LOCALAPPDATA: path.join(runRoot, "Local"),
      NGR_E2E_USER_DATA: userData,
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForFunction(() => Boolean(window.ngrDesktop?.localImageSearch?.listAssets));
    await window.waitForFunction(() => (
      document.querySelector("#localSearchRuntimeStatus")?.textContent?.includes("Windows 桌面版")
      && document.querySelector("#localSearchQuickLibrarySelect")?.options.length >= 3
    ));
    await window.locator("#localImageSearchEntry").click();
    await window.waitForFunction(() => document.querySelector("#localImageSearchView")?.classList.contains("active"));
    if (await window.locator("#localSearchGuideOverlay").isVisible()) {
      await window.locator("#localSearchGuideStart").click();
    }

    await window.locator("#localSearchQuickLibrarySelect").selectOption(LARGE_LIBRARY_ID);
    await window.waitForFunction(() => document.querySelectorAll("#localSearchAssetGrid .local-search-asset-card").length === 100);
    assert.equal(await window.locator("#localSearchContentTitle").innerText(), "素材库");
    assert.match(await window.locator("#localSearchResultCount").innerText(), /105 项/);
    assert.match(await window.locator("#localSearchAssetFolders").innerText(), /界面/);
    assert.equal(await window.locator("#localSearchAssetGrid").getAttribute("aria-busy"), "false");
    assert.equal(await window.locator("#localSearchAssetFolders").getAttribute("role"), "tree");
    assert.match(await window.locator("#localSearchAssetGrid .local-search-result-actions button").first().getAttribute("aria-label"), /asset-/);
    assert.equal(await window.locator("#localSearchAssetPage").innerText(), "1");
    assert.equal(await window.locator("#localSearchAssetPageCount").innerText(), "2");

    await window.locator("#localSearchAssetNext").click();
    await window.waitForFunction(() => (
      document.querySelector("#localSearchAssetPage")?.textContent === "2"
      && document.querySelectorAll("#localSearchAssetGrid .local-search-asset-card").length === 5
    ));

    await window.locator("#localSearchAssetFilter").fill("asset-105");
    await window.waitForFunction(() => (
      document.querySelectorAll("#localSearchAssetGrid .local-search-asset-card").length === 1
      && document.querySelector("#localSearchAssetGrid")?.textContent?.includes("asset-105.png")
    ));

    await window.locator("#localSearchQuickLibrarySelect").selectOption(SMALL_LIBRARY_ID);
    await window.waitForFunction((libraryId) => (
      document.querySelectorAll("#localSearchAssetGrid .local-search-asset-card").length === 3
      && document.querySelector("#localSearchQuickLibrarySelect")?.value === libraryId
    ), SMALL_LIBRARY_ID);

    const searchState = await window.evaluate((libraryId) => {
      const context = window.NgrLocalImageBrowser.beginSearch(libraryId);
      window.NgrLocalImageBrowser.renderSearchResults({ results: [], executionProvider: "cpu" }, context);
      return {
        mode: window.NgrLocalImageBrowser.getMode(),
        title: document.querySelector("#localSearchContentTitle")?.textContent,
        returnVisible: !document.querySelector("#localSearchReturnToLibrary")?.classList.contains("hidden"),
      };
    }, SMALL_LIBRARY_ID);
    assert.deepEqual(searchState, { mode: "results", title: "搜索结果", returnVisible: true });
    await window.locator("#localSearchReturnToLibrary").click();
    await window.waitForFunction(() => window.NgrLocalImageBrowser.getMode() === "browse");
    assert.equal(await window.locator("#localSearchBrowser").isVisible(), true);
    assert.equal(await window.evaluate(() => document.activeElement?.id), "localSearchContentTitle");
  } finally {
    await electronApp.close();
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
