/* Local-only vocabulary index. No network translation is used here. */
const NgrLexiconData = (() => {
  const meanings = {
    normal: "常态", nml: "常态", default: "默认", hover: "悬停", pressed: "按下", down: "按下",
    active: "激活", selected: "选中", sel: "选中", unselected: "未选中", unsel: "未选中",
    disabled: "禁用", forbidden: "禁止", lock: "锁定", unlock: "解锁", open: "打开", close: "关闭",
    on: "开启", off: "关闭", check: "勾选", checked: "已勾选", focus: "聚焦", new: "新增", hot: "热门",
    bg: "背景", mainbg: "主背景", panelbg: "面板背景", iconbg: "图标背景", button: "按钮", btn: "按钮",
    go: "前往", icon: "图标", line: "线条", divider: "分割线", bar: "条", progressbar: "进度条",
    frame: "边框", mask: "遮罩", card: "卡片", tab: "页签", panel: "面板", popup: "弹窗",
    dialog: "对话框", window: "窗口", item: "条目", slot: "槽位", cell: "单元格", title: "标题",
    text: "文本", number: "数字", light: "光效 / 浅色", shadow: "阴影", pattern: "纹理",
    ornament: "装饰", deco: "装饰", glow: "发光", spark: "闪光", ribbon: "飘带", border: "边界",
    corner: "角", circle: "圆形", bubble: "气泡", point: "点", arrow: "箭头", star: "星形", dot: "圆点",
    wave: "波纹", cloud: "云", flame: "火焰", halo: "光环", illustration: "插图", character: "角色",
    weapon: "武器", rewards: "奖励", gift: "礼物", badge: "徽章", logo: "标识", avatar: "头像",
    portrait: "肖像", shop: "商店", task: "任务", quest: "任务", map: "地图", skill: "技能",
    rank: "排行", record: "记录", journal: "日志", mail: "邮件", bag: "背包", coin: "货币",
    gold: "金币 / 金色", diamond: "钻石", header: "页头", footer: "页尾", content: "内容",
    list: "列表", grid: "网格", menu: "菜单", nav: "导航", sidebar: "侧栏", toolbar: "工具栏",
    tips: "提示", toast: "轻提示", notice: "公告", tag: "标签", label: "标签", input: "输入框",
    slider: "滑条", switch: "开关", left: "左", right: "右", top: "上", bottom: "下",
    center: "居中", middle: "中间", front: "前", back: "后", topleft: "左上", topright: "右上",
    bottomleft: "左下", bottomright: "右下", horizontal: "水平", vertical: "垂直", red: "红色",
    blue: "蓝色", yellow: "黄色", green: "绿色", black: "黑色", white: "白色", purple: "紫色",
    orange: "橙色", gray: "灰色", dark: "深色", cyan: "青色", pink: "粉色",
  };
  const synonyms = { button: ["按键"], btn: ["按键"], hover: ["悬浮", "鼠标移入"], normal: ["默认", "正常"], nml: ["默认", "正常"], disabled: ["不可用", "失效"], bg: ["背景图", "底图"] };
  const normalize = (value) => String(value || "").normalize("NFKC").trim().toLowerCase();
  const tokens = (value) => normalize(value).split(/_+/).filter(Boolean);
  function termOffset(name, term) {
    const parts = tokens(name), needle = tokens(term);
    if (!needle.length) return -1;
    return parts.findIndex((_, start) => needle.every((part, i) => parts[start + i] === part));
  }
  function toggle(name, term) {
    const parts = String(name || "").split(/_+/).filter(Boolean);
    const extra = String(term || "").split(/_+/).filter(Boolean);
    if (!extra.length) return parts.join("_");
    let offset = termOffset(parts.join("_"), term);
    if (offset < 0) return [...parts, ...extra].join("_");
    while (offset >= 0) { parts.splice(offset, extra.length); offset = termOffset(parts.join("_"), term); }
    return parts.join("_");
  }
  function buildIndex({ categories, dictionary = {}, phrases = {}, mappings = [] }) {
    const aliasMap = new Map();
    for (const { keyword, value } of mappings) {
      if (!/[\u3400-\u9fff]/.test(keyword || "")) continue;
      const key = normalize(value);
      aliasMap.set(key, [...(aliasMap.get(key) || []), keyword]);
    }
    function meaning(term) {
      const key = normalize(term);
      if (meanings[key]) return meanings[key];
      if (/[\u3400-\u9fff]/.test(dictionary[key] || "")) return dictionary[key];
      const split = term.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      if (phrases[split]) return phrases[split];
      const words = split.split(/_+/).filter(Boolean);
      const translations = words.map((word) => meanings[word] || dictionary[word]);
      return translations.length && translations.every((word) => /[\u3400-\u9fff]/.test(word || "")) ? translations.join(" / ") : "暂无中文释义";
    }
    const byTerm = new Map();
    for (const category of categories) for (const term of category.terms) {
      const key = normalize(term);
      if (!key) continue;
      if (byTerm.has(key)) { const entry = byTerm.get(key); if (!entry.categories.includes(category.title)) entry.categories.push(category.title); continue; }
      const translated = meaning(term);
      const aliases = [...(aliasMap.get(key) || []), ...(synonyms[key] || []), dictionary[key] || ""];
      byTerm.set(key, { key, term, meaning: translated, categories: [category.title],
        search: normalize([term, translated === "暂无中文释义" ? "" : translated, ...aliases].join(" ")) });
    }
    return [...byTerm.values()];
  }
  function search(entries, query, category = "全部") {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return entries.filter((entry) => (category === "全部" || entry.categories.includes(category)) && words.every((word) => entry.search.includes(word)));
  }
  return { buildIndex, search, hasTerm: (name, term) => termOffset(name, term) >= 0, toggle };
})();
