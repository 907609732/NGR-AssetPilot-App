(() => {
  const bridge = window.ngrDesktop?.localAssets;
  if (!bridge) return;

  const jobs = new Map();
  const requests = new Map();
  const MIME_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".tif": "image/tiff",
    ".tiff": "image/tiff", ".ico": "image/x-icon", ".avif": "image/avif", ".heic": "image/heic",
  };

  function namingSettingsKey() {
    return JSON.stringify([rules, getActiveProject()?.id, currentWorkProjectName, prefixLibrary, aiSettings?.providerId]);
  }

  async function prepareNaming(payload, signal) {
    if (!rules || !aiSettings) throw new Error("not_ready");
    const key = namingSettingsKey();
    const knowledge = parseKnowledge();
    let provider = null;
    if (payload.mode === "ai") {
      const providers = await window.NgrDesktopBridge.listProviders();
      signal.throwIfAborted();
      provider = providers.find((item) => item.id === aiSettings.providerId && item.service === "ai" && item.hasSecret);
      if (!provider) throw new Error("provider_required");
    }
    if (key !== namingSettingsKey()) throw new Error("settings_changed");
    const settings = provider ? {
      providerId: provider.id,
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl,
      model: provider.model?.trim() || "gpt-4.1-mini",
    } : null;
    jobs.set(payload.contextId, { key, knowledge, settings, entries: new Map() });
    return {
      provider: settings ? { name: provider.name, endpoint: settings.baseUrl, model: settings.model } : null,
    };
  }

  function prepareSliceCheck(payload) {
    if (!rules) throw new Error("not_ready");
    const profile = getActiveDetectionProfile();
    if (!profile) throw new Error("not_ready");
    jobs.set(payload.contextId, { profile, entries: new Map() });
    return { profileName: profile.name };
  }

  function assertNamingSettings(context) {
    if (context.key !== namingSettingsKey()) throw new Error("settings_changed");
  }

  async function inspectNamingFile(context, payload, file, signal) {
    assertNamingSettings(context);
    const asset = await fileToAsset(file);
    signal.throwIfAborted();
    assertNamingSettings(context);
    if (!asset.dimensions.width || !asset.dimensions.height) {
      context.entries.set(payload.relativePath, { status: "failed", message: "无法读取图片" });
      return;
    }
    const localRecommendations = context.settings
      ? makeRecommendations(asset, context.knowledge)
      : await makeRecommendationsWithTranslation(asset, context.knowledge, { allowExternal: false });
    let recommendations = localRecommendations;
    let status = "done";
    let message = "";
    if (context.settings) {
      try {
        recommendations = await requestAiRecommendations(asset, localRecommendations, signal, {
          providerSettings: context.settings,
          reference: null,
          prompt: buildAiPrompt(asset, localRecommendations),
          expectedProviderBaseUrl: context.settings.baseUrl,
          strictNames: true,
        });
      } catch {
        signal.throwIfAborted();
        status = "fallback";
        message = "AI 命名未成功，已使用本地推荐";
      }
    }
    asset.file = null;
    asset.recommendations = recommendations;
    asset.finalBaseName = recommendations[0] || "";
    context.entries.set(payload.relativePath, { asset, status, message });
  }

  async function inspectFile(context, payload, signal) {
    const type = MIME_TYPES[getExtension(payload.name)] || "";
    const file = new File([payload.bytes], payload.name, { type });
    if (payload.type === "naming") {
      await inspectNamingFile(context, payload, file, signal);
    } else {
      const asset = await fileToDetectionAsset(file, { profile: context.profile, fileSize: payload.size });
      signal.throwIfAborted();
      asset.file = null;
      asset.name = payload.relativePath;
      context.entries.set(payload.relativePath, asset);
    }
    return { status: "done" };
  }

  function finalizeNaming(context, relativePaths) {
    assertNamingSettings(context);
    const entries = [...context.entries.values()];
    applySemanticSequenceNumbers(entries.map(({ asset }) => asset).filter(Boolean));
    return relativePaths.map((relativePath) => {
      const entry = context.entries.get(relativePath);
      const asset = entry?.asset;
      if (!asset?.finalBaseName) {
        return { relativePath, status: "failed", message: entry?.message || "未生成可用的推荐名称" };
      }
      return {
        relativePath,
        status: entry.status,
        message: entry.message,
        recommendations: asset.recommendations.map((finalBaseName) => buildExportName({ ...asset, finalBaseName })),
        proposedName: buildExportName(asset),
        projectFolder: buildExportProjectFolderName(asset),
      };
    });
  }

  function finalizeSliceCheck(context, relativePaths) {
    applySimilarResourceWarnings([...context.entries.values()], context.profile);
    return relativePaths.map((relativePath) => {
      const asset = context.entries.get(relativePath);
      return {
        relativePath,
        width: asset.dimensions.width,
        height: asset.dimensions.height,
        format: asset.detectedFormat,
        issues: asset.messages || [],
        warnings: asset.warnings || [],
        similarNames: asset.similarNames || [],
      };
    });
  }

  async function run(action, payload, signal) {
    signal.throwIfAborted();
    switch (action) {
      case "prepare_naming":
        jobs.clear();
        return prepareNaming(payload, signal);
      case "prepare_slice_check":
        jobs.clear();
        return prepareSliceCheck(payload);
      case "release_job":
        jobs.delete(payload.contextId);
        return null;
      default:
        break;
    }
    const context = jobs.get(payload.contextId);
    if (!context) throw new Error("context_missing");
    if (action === "inspect_file") return inspectFile(context, payload, signal);
    if (action === "finalize_job") {
      return payload.type === "naming"
        ? finalizeNaming(context, payload.relativePaths)
        : finalizeSliceCheck(context, payload.relativePaths);
    }
    throw new Error("invalid_action");
  }

  bridge.onRequest(async ({ id, action, payload }) => {
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      const result = await run(action, payload, controller.signal);
      if (!controller.signal.aborted) await bridge.reply({ id, result });
    } catch (error) {
      if (!controller.signal.aborted) await bridge.reply({ id, error: error?.message || "failed" }).catch(() => {});
    } finally {
      requests.delete(id);
    }
  });
  bridge.onCancel(({ id }) => requests.get(id)?.abort());
})();

