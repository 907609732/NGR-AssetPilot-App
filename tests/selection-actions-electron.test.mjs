import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

test("长列表可在底部勾选删除，记录热区与开机启动系统接口可用", { timeout: 120_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "selection-ui-"));
  const evidence = path.join(root, "artifacts", "selection-actions");
  fs.mkdirSync(evidence, { recursive: true });
  const app = await electron.launch({ args: [path.join(root, "desktop/main/index.mjs")], cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: path.join(dir, "UserData"), ELECTRON_ENABLE_LOGGING: "0" } });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    await page.locator("#workEntry").click();
    const toolbarLayout = await page.evaluate(() => {
      const selectors = [
        ".naming-batch-tools .prefix-picker-trigger",
        "#workProjectName",
        "#workViewName",
        ".naming-batch-tools .batch-operation-group",
        "#listDisplayModeSelect",
        "#listSortModeSelect",
        "#problemFilter",
        "#removeSelected",
      ];
      const boxes = Object.fromEntries(selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
      }));
      const fieldWidths = Object.fromEntries([
        ["prefix", document.querySelector("#workBasePrefix").closest("label").getBoundingClientRect().width],
        ["batch", document.querySelector(".batch-operation-field").getBoundingClientRect().width],
        ["display", document.querySelector("#listDisplayModeSelect").closest("label").getBoundingClientRect().width],
        ["sort", document.querySelector("#listSortModeSelect").closest("label").getBoundingClientRect().width],
      ]);
      return { boxes, fieldWidths };
    });
    const controlTops = Object.values(toolbarLayout.boxes).map((box) => Math.round(box.y));
    assert.ok(Math.max(...controlTops) - Math.min(...controlTops) <= 2, JSON.stringify(toolbarLayout.boxes));
    assert.ok(toolbarLayout.fieldWidths.prefix <= 120);
    assert.ok(toolbarLayout.fieldWidths.batch <= 300);
    assert.ok(toolbarLayout.fieldWidths.display <= 160);
    assert.ok(toolbarLayout.fieldWidths.sort <= 170);
    await page.screenshot({ path: path.join(evidence, "naming-toolbar-single-row.png") });
    const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARUlEQVRYhe3XsREAMAhC0czAmEzh5maLpHmFvXcifE6m+3OOBeIEQ4T1hsuIwopHGFUcLyAJJBtQWli+iklUs1FO+1wHFywT7GqIQKHAAAAAAElFTkSuQmCC", "base64");
    const files = Array.from({ length: 24 }, (_, i) => ({ name: `image-${String(i).padStart(2, "0")}.png`, mimeType: "image/png", buffer }));
    await page.locator("#singleInput").setInputFiles(files);
    await page.waitForFunction(() => document.querySelectorAll("#assetList .asset-item").length === 24);
    const namingRows = page.locator("#assetList .asset-item");
    const compactHeaderLayout = await page.evaluate(() => {
      const collectCenters = (selectors) => selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, centerY: rect.top + (rect.height / 2) };
      });
      return {
        historyHeight: document.querySelector(".naming-history-bar").getBoundingClientRect().height,
        listHeadHeight: document.querySelector(".work-view .list-head").getBoundingClientRect().height,
        history: collectCenters([".history-head > strong", "#newNamingSession", "#saveNamingWorkspace", "#namingSaveStatus", ".naming-session-item"]),
        list: collectCenters([".list-title-block > strong", ".select-all-control", "#fileCount", "#selectedAssetCount"]),
      };
    });
    for (const group of [compactHeaderLayout.history, compactHeaderLayout.list]) {
      const centers = group.map((item) => item.centerY);
      assert.ok(Math.max(...centers) - Math.min(...centers) <= 2, JSON.stringify(group));
    }
    assert.ok(compactHeaderLayout.historyHeight <= 60, JSON.stringify(compactHeaderLayout));
    assert.ok(compactHeaderLayout.listHeadHeight <= 44, JSON.stringify(compactHeaderLayout));
    await page.screenshot({ path: path.join(evidence, "naming-header-single-line.png") });
    const rowColorEvidence = await namingRows.evaluateAll((rows) => rows.slice(1, 3).map((row) => {
      const style = getComputedStyle(row);
      const rect = row.getBoundingClientRect();
      return { background: style.backgroundColor, border: style.borderColor, boxShadow: style.boxShadow, top: rect.top, bottom: rect.bottom };
    }));
    assert.notEqual(rowColorEvidence[0].background, rowColorEvidence[1].background);
    assert.notEqual(rowColorEvidence[0].boxShadow, rowColorEvidence[1].boxShadow);
    assert.ok(rowColorEvidence[1].top - rowColorEvidence[0].bottom >= 6);
    await namingRows.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, "naming-row-colors.png") });
    await namingRows.nth(22).locator('.inline-final-name input').fill("First_Name");
    await namingRows.nth(23).locator('.inline-final-name input').fill("Second_Name");
    await namingRows.nth(22).locator('input[type="checkbox"]').check();
    await namingRows.nth(23).locator('input[type="checkbox"]').check();
    await page.locator("#floatingRemoveSelected").waitFor({ state: "visible" });
    assert.match(await page.locator("#floatingSelectionActions").innerText(), /已选 2 张/);
    await page.locator('[data-batch-kind="project"]').fill("BatchProject");
    await page.locator('[data-batch-kind="project"]').press("Enter");
    await page.locator('[data-batch-kind="view"]').fill("HomePanel");
    await page.locator('[data-batch-kind="view"]').press("Enter");
    await page.locator(".selection-prefix-picker .prefix-picker-trigger").click();
    await page.locator('.selection-prefix-picker [data-prefix-id="builtin:t-ui-icon"]').click();
    assert.deepEqual(await page.evaluate(() => assets.slice(22).map((asset) => ({
      prefix: asset.customBasePrefix,
      project: asset.customProjectName,
      view: asset.customViewName,
      name: asset.finalBaseName,
    }))), [
      { prefix: "T_UI_Icon", project: "BatchProject", view: "HomePanel", name: "First_Name" },
      { prefix: "T_UI_Icon", project: "BatchProject", view: "HomePanel", name: "Second_Name" },
    ]);
    assert.equal(await page.evaluate(() => assets[0].customProjectName || ""), "");
    await page.locator("#listDisplayModeSelect").selectOption("compact");
    assert.ok(await page.locator("#floatingSelectionActions").isVisible());
    await page.locator("#listDisplayModeSelect").selectOption("album");
    assert.ok(await page.locator("#floatingSelectionActions").isVisible());
    await page.locator("#listDisplayModeSelect").selectOption("full");
    await page.screenshot({ path: path.join(evidence, "naming-bottom.png") });
    await page.locator("#floatingRemoveSelected").click();
    await page.waitForFunction(() => document.querySelectorAll("#assetList .asset-item").length === 22);
    assert.equal(await page.locator('#assetList .asset-item', { hasText: "image-00" }).count(), 1);
    await page.locator("#floatingSelectionActions").waitFor({ state: "hidden" });
    await page.locator("#newNamingSession").click();
    const deleteButton = page.locator(".session-delete").first();
    const box = await deleteButton.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44);
    const before = await page.locator(".naming-session-item").count();
    await deleteButton.click({ position: { x: 3, y: 3 } });
    assert.equal(await page.locator(".naming-session-item").count(), before - 1);
    await page.locator("#backButton").click();
    await page.locator("#detectEntry").click();
    await page.locator("#detectionSingleInput").setInputFiles(files);
    await page.waitForFunction(() => document.querySelectorAll("#detectionList .detection-item").length === 24);
    await page.locator('#detectionList input[type="checkbox"]').last().check();
    await page.locator("#floatingRemoveSelected").waitFor({ state: "visible" });
    assert.match(await page.locator("#floatingSelectionActions").innerText(), /已选 1 张/);
    await page.screenshot({ path: path.join(evidence, "detection-bottom.png") });
    await page.locator("#floatingRemoveSelected").click();
    await page.waitForFunction(() => document.querySelectorAll("#detectionList .detection-item").length === 23);
    await page.locator("#selectVisibleDetection").check();
    await page.waitForFunction(() => document.getElementById("selectedDetectionCount").textContent === "已选 23 张");
    await page.locator("#selectVisibleDetection").uncheck();
    await page.locator("#backButton").click();
    await page.locator("#rulesEntry").click();
    assert.equal(await page.locator("#floatingSelectionActions").isVisible(), false);
    await page.waitForFunction(() => document.getElementById("autoStartStatus").textContent.includes("Windows 安装版"));
    assert.equal(await page.locator("#autoStartEnabled").isChecked(), false);
    await page.screenshot({ path: path.join(evidence, "settings.png") });
    // Exercise the native Windows API using a unique temporary entry and always remove it.
    const nativeResult = await app.evaluate(({ app }) => {
      const name = `NGR AutoStart Verification ${Date.now()}`;
      const options = { path: process.execPath, args: [], name };
      const get = () => app.getLoginItemSettings({ path: `"${process.execPath}"`, args: [] }).launchItems.find((item) => item.name === name && item.scope === "user");
      try {
        app.setLoginItemSettings({ ...options, openAtLogin: true, enabled: true });
        const on = get();
        const restored = get();
        app.setLoginItemSettings({ ...options, openAtLogin: false, enabled: false });
        const off = get();
        return { on, restored, off };
      } finally { app.setLoginItemSettings({ path: process.execPath, args: [], name, openAtLogin: false, enabled: false }); }
    });
    assert.equal(nativeResult.on.enabled, true);
    assert.equal(nativeResult.restored.enabled, true);
    assert.equal(nativeResult.off, undefined);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
