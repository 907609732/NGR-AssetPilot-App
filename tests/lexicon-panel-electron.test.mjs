import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

test("左侧大尺寸词库搜索、当前图片联动、面板互斥与长列表状态保留", { timeout: 120_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "lexicon-ui-"));
  const evidence = path.join(root, "artifacts", "lexicon-panel");
  fs.mkdirSync(evidence, { recursive: true });
  const launch = () => electron.launch({ args: [path.join(root, "desktop/main/index.mjs")], cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: path.join(dir, "UserData"), ELECTRON_ENABLE_LOGGING: "0" } });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    await page.screenshot({ path: path.join(evidence, "tools-closed-left.png") });
    const closedVisual = await page.locator("#lexiconToggle").evaluate((node) => ({
      boxShadow: getComputedStyle(node).boxShadow,
      transition: getComputedStyle(node).transition,
      haloAnimation: getComputedStyle(node, "::before").animationName,
    }));
    assert.notEqual(closedVisual.boxShadow, "none");
    assert.match(closedVisual.transition, /transform/);
    assert.equal(closedVisual.haloAnimation, "side-tool-breathe");
    await page.locator("#lexiconToggle").focus();
    const focusVisual = await page.locator("#lexiconToggle").evaluate((node) => ({ outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow }));
    assert.equal(focusVisual.outline, "solid");
    assert.notEqual(focusVisual.shadow, "none");
    await page.locator("#lexiconToggle").hover();
    await page.waitForTimeout(280);
    assert.notEqual(await page.locator("#lexiconToggle").evaluate((node) => getComputedStyle(node).transform), "none");
    await page.locator("#lexiconToggle").click();
    await page.waitForTimeout(500);
    const leftToolGeometry = await page.locator("#lexiconToggle").boundingBox();
    const initialPanelGeometry = await page.locator("#lexiconPanel").boundingBox();
    assert.ok(leftToolGeometry.x <= 6);
    assert.ok(initialPanelGeometry.x >= 48 && initialPanelGeometry.x <= 64);
    assert.ok(initialPanelGeometry.width >= 540);
    const lexiconGlass = await page.locator("#lexiconPanel").evaluate((node) => ({
      animation: getComputedStyle(node).animationName,
      backdrop: getComputedStyle(node).backdropFilter || getComputedStyle(node).webkitBackdropFilter,
      background: getComputedStyle(node).backgroundImage,
      bling: getComputedStyle(document.querySelector("#lexiconToggle"), "::after").animationName,
    }));
    assert.equal(lexiconGlass.animation, "side-glass-panel-in");
    assert.match(lexiconGlass.backdrop, /blur\(20px\)/);
    assert.match(lexiconGlass.background, /linear-gradient/);
    assert.equal(lexiconGlass.bling, "side-tool-bling");
    await page.waitForTimeout(950);
    await page.screenshot({ path: path.join(evidence, "glass-lexicon-open.png") });
    await page.locator("#lexiconSearch").fill("按钮");
    assert.ok(await page.locator('.lexicon-entry[data-term="Button"]').isDisabled());
    assert.match(await page.locator("#lexiconTargetName").innerText(), /选择图片/);
    await page.locator("#lexiconSearch").press("Escape");
    assert.equal(await page.locator("#lexiconPanel").isVisible(), false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#lexiconToggle").click();
    const reducedMotion = await page.locator("#lexiconPanel").evaluate((node) => ({
      panel: getComputedStyle(node).animationName,
      halo: getComputedStyle(document.querySelector("#lexiconToggle"), "::before").animationName,
      sparkle: getComputedStyle(document.querySelector("#lexiconToggle"), "::after").animationName,
    }));
    assert.deepEqual(reducedMotion, { panel: "none", halo: "none", sparkle: "none" });
    await page.locator("#lexiconClose").click();
    await page.locator("#translatorToggle").click();
    assert.equal(await page.locator(".translator-body").evaluate((node) => getComputedStyle(node).animationName), "none");
    await page.locator("#translatorClose").click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#workEntry").click();
    const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARUlEQVRYhe3XsREAMAhC0czAmEzh5maLpHmFvXcifE6m+3OOBeIEQ4T1hsuIwopHGFUcLyAJJBtQWli+iklUs1FO+1wHFywT7GqIQKHAAAAAAElFTkSuQmCC", "base64");
    const files = Array.from({ length: 24 }, (_, i) => ({ name: `image-${String(i).padStart(2, "0")}.png`, mimeType: "image/png", buffer }));
    await page.locator("#singleInput").setInputFiles(files);
    await page.waitForFunction(() => document.querySelectorAll("#assetList .asset-item").length === 24);
    assert.equal(await page.locator(".inline-lexicon").count(), 0);
    const firstInput = page.locator("#assetList .inline-final-name input").first();
    const lastInput = page.locator("#assetList .inline-final-name input").last();
    await firstInput.fill("Home");
    await lastInput.fill("Shop");
    await page.locator("#lexiconToggle").click();
    assert.equal(await page.locator("#lexiconSearch").inputValue(), "按钮");
    await page.waitForFunction(() => document.getElementById("lexiconTargetName").textContent === "image-23.png");
    const pageY = await page.evaluate(() => scrollY);
    await page.locator('.lexicon-entry[data-term="Button"]').click();
    assert.equal(await lastInput.inputValue(), "Shop_Button");
    assert.equal(await firstInput.inputValue(), "Home");
    assert.equal(await page.evaluate(() => scrollY), pageY);
    assert.equal(await page.locator('.lexicon-entry[data-term="Button"]').getAttribute("aria-pressed"), "true");
    await page.locator('.lexicon-entry[data-term="Button"]').click();
    assert.equal(await lastInput.inputValue(), "Shop");
    await page.locator("#lexiconSearch").fill("按键");
    assert.ok(await page.locator('.lexicon-entry[data-term="Btn"]').isVisible());
    await page.locator("#lexiconSearch").fill("bUtToN");
    assert.ok(await page.locator('.lexicon-entry[data-term="Button"]').isVisible());
    await page.locator('[data-category="颜色"]').click();
    assert.match(await page.locator("#lexiconResults").innerText(), /没有找到词条/);
    await page.locator("#lexiconClear").click();
    assert.equal(await page.locator(".lexicon-entry").count(), 14);
    await page.locator('[data-category="全部"]').click();
    await page.locator(".lexicon-more").click();
    assert.ok(await page.locator(".lexicon-entry").count() > 80);
    await page.locator("#lexiconResults").evaluate((node) => { node.scrollTop = 500; });
    const resultY = await page.locator("#lexiconResults").evaluate((node) => node.scrollTop);
    await page.locator("#lexiconClose").click();
    await page.locator("#lexiconToggle").click();
    assert.equal(await page.locator("#lexiconResults").evaluate((node) => node.scrollTop), resultY);
    await page.locator("#translatorToggle").click();
    assert.equal(await page.locator("#lexiconPanel").isVisible(), false);
    assert.equal(await page.locator("#translatorPanel").getAttribute("class"), "translator-panel");
    await page.waitForTimeout(500);
    const translatorGeometry = await page.locator("#translatorPanel").boundingBox();
    assert.ok(translatorGeometry.x >= 48 && translatorGeometry.x <= 64);
    assert.ok(translatorGeometry.width >= 320 && translatorGeometry.width <= 360);
    assert.ok(translatorGeometry.height >= 180 && translatorGeometry.height <= 300);
    const translatorGlass = await page.locator("#translatorPanel").evaluate((node) => ({
      animation: getComputedStyle(node.querySelector(".translator-body")).animationName,
      backdrop: getComputedStyle(node.querySelector(".translator-body")).backdropFilter || getComputedStyle(node.querySelector(".translator-body")).webkitBackdropFilter,
      background: getComputedStyle(node.querySelector(".translator-body")).backgroundImage,
    }));
    assert.equal(translatorGlass.animation, "side-glass-panel-in");
    assert.match(translatorGlass.backdrop, /blur\(20px\)/);
    assert.match(translatorGlass.background, /linear-gradient/);
    await page.waitForTimeout(950);
    await page.screenshot({ path: path.join(evidence, "glass-translator-open.png") });
    const dragHandle = page.locator("#translatorDragHandle");
    const handleBox = await dragHandle.boundingBox();
    const beforeDrag = await page.locator("#translatorPanel").boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 74, handleBox.y + handleBox.height / 2 + 34, { steps: 6 });
    await page.mouse.up();
    const afterDrag = await page.locator("#translatorPanel").boundingBox();
    assert.ok(afterDrag.x > beforeDrag.x + 50 && afterDrag.y > beforeDrag.y + 20);
    assert.ok(await page.locator("#lexiconToggle").isVisible());
    await page.locator("#lexiconToggle").click();
    assert.match(await page.locator("#translatorPanel").getAttribute("class"), /collapsed/);
    await page.locator("#translatorToggle").click();
    await page.waitForTimeout(500);
    const reopenedTranslator = await page.locator("#translatorPanel").boundingBox();
    assert.ok(Math.abs(reopenedTranslator.x - afterDrag.x) <= 2 && Math.abs(reopenedTranslator.y - afterDrag.y) <= 2);
    await page.locator("#lexiconToggle").click();
    await page.locator("#lexiconSearch").fill("悬停");
    await page.screenshot({ path: path.join(evidence, "search-and-target.png") });
    await page.locator('.lexicon-entry[data-term="Hover"]').click();
    assert.equal(await lastInput.inputValue(), "Shop_Hover");
    // Changing scheme data must refresh all terms, including those beyond the former 32-word limit.
    await page.evaluate(() => {
      rules.pageTerms = Array.from({ length: 90 }, (_, i) => `UniquePage${i}`).join("\n");
      rules.filenameRules += "\n特殊页面=UniquePage89";
      window.NgrLexiconPanel.refresh();
    });
    await page.locator("#lexiconSearch").fill("特殊页面");
    await page.locator('.lexicon-entry[data-term="UniquePage89"]').waitFor({ state: "visible" });
    await page.locator("#lexiconClose").click();
    await page.locator("#listDisplayModeSelect").selectOption("compact");
    assert.equal(await page.locator(".inline-lexicon").count(), 0);
    await page.locator("#listDisplayModeSelect").selectOption("album");
    await page.locator("#assetList .album-card").first().click();
    assert.equal(await page.locator(".inline-lexicon").count(), 0);
    await page.locator("#lexiconToggle").click();
    await page.locator("#lexiconSearch").fill("按钮");
    await page.locator('.lexicon-entry[data-term="Button"]').click();
    assert.equal(await page.locator(".album-final-field input").inputValue(), "Home_Button");
    // Smaller desktop window: the drawer and permanent tools stay inside the viewport.
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setSize(1100, 700); });
    await page.waitForFunction(() => innerHeight < 750);
    await page.screenshot({ path: path.join(evidence, "small-window.png") });
    const geometry = await page.locator("#lexiconPanel").boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= viewport.width && geometry.y + geometry.height <= viewport.height);
    assert.ok(geometry.y <= 24);
    assert.ok(viewport.height - (geometry.y + geometry.height) >= 100);
    await page.locator("#lexiconClose").click();
    await page.locator("#saveNamingWorkspace").click();
    await page.waitForFunction(() => document.getElementById("namingSaveStatus").textContent.includes("已保存"));
    assert.deepEqual(errors, []);
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    await restored.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    await restored.locator("#workEntry").click();
    await restored.waitForFunction(() => assets.length === 24);
    assert.equal(await restored.evaluate(() => assets[0].finalBaseName), "Home_Button");
    assert.equal(await restored.evaluate(() => assets[23].finalBaseName), "Shop_Hover");
    await restored.locator("#assetList .album-card").last().click();
    await restored.locator("#lexiconToggle").click();
    await restored.waitForFunction(() => document.getElementById("lexiconTargetName").textContent === "image-23.png");
    await restored.locator("#removeSelected").click();
    await restored.waitForFunction(() => assets.length === 23 && document.getElementById("lexiconTargetName").textContent === "image-00.png");
    await restored.locator("#newNamingSession").click();
    await restored.waitForFunction(() => assets.length === 0 && document.getElementById("lexiconTargetName").textContent === "请在命名页面选择图片");
    assert.equal(await restored.locator(".lexicon-entry:enabled").count(), 0);
    await restored.locator("#backButton").click();
    assert.ok(await restored.locator("#lexiconPanel").isVisible());
    assert.equal(await restored.locator(".lexicon-entry:enabled").count(), 0);
  } finally { await app.close(); }
});
