import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../app/js/prefix-library.js", import.meta.url), "utf8");

function loadPrefixApi() {
  const context = { console, crypto: { randomUUID: () => "unit-test-id" } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.NgrPrefixLibrary;
}

test("全局前缀库保留内置项并迁移未知旧前缀", () => {
  const api = loadPrefixApi();
  const entries = api.normalizePrefixLibrary(null, ["T_UI", "Custom_UI", "custom_ui", "Bad / Prefix"]);
  assert.deepEqual(Array.from(entries.slice(0, 4), (entry) => entry.id), [
    "builtin:none",
    "builtin:t-ui",
    "builtin:t-ui-img",
    "builtin:t-ui-icon",
  ]);
  assert.equal(entries.filter((entry) => entry.value === "Custom_UI").length, 1);
  assert.ok(entries.some((entry) => entry.value === "Bad_Prefix" && entry.id.startsWith("custom:legacy-")));
  assert.ok(entries.slice(0, 4).every((entry) => entry.builtin));
});

test("自定义前缀使用稳定 ID，改名后引用仍解析到新值", () => {
  const api = loadPrefixApi();
  const entries = api.normalizePrefixLibrary({ entries: [{ id: "custom:stable", value: "Old_Prefix", builtin: false }] });
  const entry = api.getPrefixEntry(entries, "custom:stable");
  entry.value = "New_Prefix";
  entry.label = "New_Prefix";
  assert.equal(api.resolvePrefixValue(entries, "custom:stable"), "New_Prefix");
  assert.equal(api.getPrefixEntry(entries, "New_Prefix").id, "custom:stable");
  assert.equal(api.getPrefixEntry(entries, "__none").id, "builtin:none");
});
