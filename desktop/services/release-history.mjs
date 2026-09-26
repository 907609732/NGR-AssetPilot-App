import { DesktopError } from "../shared/core.mjs";
import snapshot from "./release-history-snapshot.json" with { type: "json" };

const API = "https://api.github.com/repos/907609732/NGR-AssetPilot-App/releases";
export class ReleaseHistory {
  constructor({ fetchImpl = fetch, initialHistory = snapshot } = {}) {
    this.fetch = fetchImpl; this.cached = initialHistory ? { ...initialHistory, stale: true } : null;
    this.pending = null; this.updatedAt = 0;
  }
  async list() {
    if (this.cached && Date.now() - this.updatedAt < 5 * 60_000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }
  async load() {
    const releases = [], seen = new Set();
    const signal = AbortSignal.timeout(60_000);
    try {
      for (let page = 1; ; page++) {
        const response = await this.fetch(`${API}?per_page=100&page=${page}`, { signal, redirect: "error", headers: { Accept: "application/vnd.github+json", "User-Agent": "NGR-AssetPilot" } });
        if (!response.ok) throw new Error("request failed");
        const entries = await response.json();
        if (!Array.isArray(entries)) throw new Error("invalid response");
        let added = 0;
        for (const entry of entries) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id); added++;
          if (entry.draft || !entry.tag_name) continue;
          releases.push({ id: entry.id, version: String(entry.tag_name), name: String(entry.name || entry.tag_name),
            date: entry.published_at || "", notes: String(entry.body || "暂无更新说明"), prerelease: Boolean(entry.prerelease) });
        }
        if (entries.length < 100) break;
        if (!added) throw new Error("pagination repeated");
      }
      releases.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
      this.updatedAt = Date.now();
      this.cached = { releases, fetchedAt: new Date(this.updatedAt).toISOString(), stale: false };
      return this.cached;
    } catch {
      if (this.cached) return { ...this.cached, stale: true };
      throw new DesktopError("RELEASE_HISTORY_UNAVAILABLE", "历史版本加载失败，请检查网络后重试");
    }
  }
}
