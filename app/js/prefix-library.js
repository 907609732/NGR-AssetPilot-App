/* NGR AssetPilot V3.0.0 module: prefix-library.js */
(function initializePrefixLibrary(globalScope) {
  "use strict";

  const BUILTIN_PREFIXES = Object.freeze([
    Object.freeze({ id: "builtin:none", value: "", label: "无", builtin: true }),
    Object.freeze({ id: "builtin:t-ui", value: "T_UI", label: "T_UI", builtin: true }),
    Object.freeze({ id: "builtin:t-ui-img", value: "T_UI_Img", label: "T_UI_Img", builtin: true }),
    Object.freeze({ id: "builtin:t-ui-icon", value: "T_UI_Icon", label: "T_UI_Icon", builtin: true }),
  ]);
  const pickerInstances = new Set();

  function sanitizePrefixValue(value) {
    return String(value || "")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  function normalizedKey(value) {
    return sanitizePrefixValue(value).toLocaleLowerCase("en-US");
  }

  function legacyId(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `custom:legacy-${(hash >>> 0).toString(16)}`;
  }

  function createCustomId() {
    if (globalScope.crypto?.randomUUID) return `custom:${globalScope.crypto.randomUUID()}`;
    return `custom:${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizePrefixLibrary(rawValue, legacyValues = []) {
    let parsed = rawValue;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = null;
      }
    }
    const candidates = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
    const seen = new Set(BUILTIN_PREFIXES.map((entry) => normalizedKey(entry.value)).filter(Boolean));
    const customEntries = [];
    const appendCustom = (candidate, fallbackId = "") => {
      const value = sanitizePrefixValue(typeof candidate === "string" ? candidate : candidate?.value);
      const key = normalizedKey(value);
      if (!value || seen.has(key)) return;
      seen.add(key);
      const requestedId = typeof candidate === "object" ? String(candidate?.id || "") : "";
      const id = requestedId.startsWith("custom:") ? requestedId : fallbackId || legacyId(value);
      customEntries.push({ id, value, label: value, builtin: false });
    };
    candidates.filter((entry) => !entry?.builtin).forEach((entry) => appendCustom(entry));
    legacyValues.forEach((value) => appendCustom(value, legacyId(value)));
    return [...BUILTIN_PREFIXES.map((entry) => ({ ...entry })), ...customEntries];
  }

  function getPrefixEntry(entries, idOrValue) {
    const raw = String(idOrValue ?? "");
    if (!raw || raw === "__none") return entries.find((entry) => entry.id === "builtin:none") || null;
    return entries.find((entry) => entry.id === raw)
      || entries.find((entry) => normalizedKey(entry.value) === normalizedKey(raw))
      || null;
  }

  function ensurePrefixEntry(entries, value) {
    const clean = sanitizePrefixValue(value);
    if (!clean) return getPrefixEntry(entries, "builtin:none");
    const existing = getPrefixEntry(entries, clean);
    if (existing) return existing;
    const entry = { id: legacyId(clean), value: clean, label: clean, builtin: false };
    entries.push(entry);
    return entry;
  }

  function resolvePrefixValue(entries, idOrValue) {
    return getPrefixEntry(entries, idOrValue)?.value || "";
  }

  function closeAllPickers(except = null) {
    pickerInstances.forEach((instance) => {
      if (instance !== except) instance.close();
    });
  }

  function createPrefixPicker({ value = "builtin:none", onChange = null, className = "" } = {}) {
    const root = document.createElement("div");
    root.className = `prefix-picker ${className}`.trim();
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "prefix-picker-trigger";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const current = document.createElement("span");
    const chevron = document.createElement("span");
    chevron.className = "prefix-picker-chevron";
    chevron.textContent = "⌄";
    trigger.append(current, chevron);
    const menu = document.createElement("div");
    menu.className = "prefix-picker-menu hidden";
    menu.setAttribute("role", "menu");
    root.append(trigger, menu);

    let selectedId = "builtin:none";
    const instance = {
      root,
      get value() {
        return selectedId;
      },
      setValue(nextValue, emit = false) {
        const entry = getPrefixEntry(globalScope.prefixLibrary || BUILTIN_PREFIXES, nextValue)
          || getPrefixEntry(globalScope.prefixLibrary || BUILTIN_PREFIXES, "builtin:none");
        selectedId = entry?.id || "builtin:none";
        current.textContent = entry?.label || "无";
        root.dataset.prefixId = selectedId;
        root.dataset.prefixValue = entry?.value || "";
        menu.querySelectorAll("[data-prefix-id]").forEach((button) => {
          button.classList.toggle("selected", button.dataset.prefixId === selectedId);
        });
        if (emit && typeof onChange === "function") onChange(selectedId, entry?.value || "");
      },
      refresh() {
        menu.innerHTML = "";
        (globalScope.prefixLibrary || BUILTIN_PREFIXES).forEach((entry) => {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "prefix-picker-option";
          option.dataset.prefixId = entry.id;
          option.setAttribute("role", "menuitemradio");
          option.textContent = entry.label;
          option.addEventListener("click", () => {
            instance.setValue(entry.id, true);
            instance.close();
          });
          menu.appendChild(option);
        });
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "prefix-picker-edit";
        edit.textContent = "＋ 新建/编辑前缀";
        edit.addEventListener("click", () => {
          instance.close();
          globalScope.openPrefixLibraryEditor?.();
        });
        menu.appendChild(edit);
        instance.setValue(selectedId, false);
      },
      open() {
        closeAllPickers(instance);
        menu.classList.remove("hidden");
        trigger.setAttribute("aria-expanded", "true");
      },
      close() {
        menu.classList.add("hidden");
        trigger.setAttribute("aria-expanded", "false");
      },
    };
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.classList.contains("hidden")) instance.open();
      else instance.close();
    });
    menu.addEventListener("click", (event) => event.stopPropagation());
    pickerInstances.add(instance);
    instance.refresh();
    instance.setValue(value, false);
    return instance;
  }

  function mountPrefixPicker(host, options = {}) {
    host.innerHTML = "";
    const instance = createPrefixPicker(options);
    host.appendChild(instance.root);
    host.prefixPicker = instance;
    Object.defineProperty(host, "value", {
      configurable: true,
      get: () => instance.value,
      set: (nextValue) => instance.setValue(nextValue, false),
    });
    return instance;
  }

  function refreshPrefixPickers() {
    pickerInstances.forEach((instance) => instance.refresh());
  }

  if (globalScope.document) {
    document.addEventListener("click", () => closeAllPickers());
  }

  globalScope.NgrPrefixLibrary = Object.freeze({
    BUILTIN_PREFIXES,
    sanitizePrefixValue,
    normalizePrefixLibrary,
    getPrefixEntry,
    ensurePrefixEntry,
    resolvePrefixValue,
    createCustomId,
    createPrefixPicker,
    mountPrefixPicker,
    refreshPrefixPickers,
  });
})(window);
