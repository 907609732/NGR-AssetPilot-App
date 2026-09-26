import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL("../app/js/config.js", import.meta.url), "utf8"), context);
vm.runInContext(fs.readFileSync(new URL("../app/js/lexicon-data.js", import.meta.url), "utf8") + "\nglobalThis.data = NgrLexiconData; globalThis.categories = lexiconCategories;", context);
const { data, categories } = context;

test("内置词库全部有中文释义，中英文及别名搜索，跨分类去重", () => {
  const entries = data.buildIndex({ categories });
  assert.ok(entries.length > 100);
  assert.deepEqual(Array.from(entries.filter((entry) => entry.meaning === "暂无中文释义"), (entry) => entry.term), []);
  for (const query of ["按钮", "按键"]) {
    const terms = Array.from(data.search(entries, query), (entry) => entry.term);
    assert.ok(terms.includes("Button")); assert.ok(terms.includes("Btn"));
  }
  assert.equal(data.search(entries, "bUtToN")[0].term, "Button");
  assert.equal(data.search(entries, "悬停")[0].term, "Hover");
  assert.equal(data.search(entries, "按钮", "颜色").length, 0);
  assert.equal(entries.filter((entry) => entry.term === "Gold").length, 1);
  assert.equal(data.search(entries, "不存在的中文词").length, 0);
});

test("完整索引可搜索第 32 个以后的自定义词，复合词释义与未知词区分", () => {
  const terms = Array.from({ length: 150 }, (_, i) => `Custom${i}`);
  const entries = data.buildIndex({ categories: [{ title: "自定义", terms: [...terms, "Home_Button", "Mystery_Button"] }],
    dictionary: { home: "首页", button: "按钮" }, mappings: [{ keyword: "自定义尾词", value: "Custom149" }] });
  assert.equal(data.search(entries, "自定义尾词")[0].term, "Custom149");
  assert.equal(data.search(entries, "Home_Button")[0].meaning, "首页 / 按钮");
  assert.equal(data.search(entries, "Mystery_Button")[0].meaning, "暂无中文释义");
});

test("追加与移除词条只处理完整片段，支持下划线复合词并保留其他名称", () => {
  assert.equal(data.toggle("Home_MyButton", "Button"), "Home_MyButton_Button");
  assert.equal(data.toggle("Home_MyButton_Button", "button"), "Home_MyButton");
  assert.equal(data.toggle("Home", "Go_Button"), "Home_Go_Button");
  assert.equal(data.hasTerm("Home_Go_Button_Hover", "go_button"), true);
  assert.equal(data.toggle("Home_Go_Button_Hover", "Go_Button"), "Home_Hover");
  assert.equal(data.toggle("Button", "Button"), "");
});
