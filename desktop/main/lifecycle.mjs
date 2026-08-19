import { randomUUID } from "node:crypto";

export class QuitCoordinator {
  constructor({ app, channel, timeoutMs = 5_000 }) {
    this.app = app;
    this.channel = channel;
    this.timeoutMs = timeoutMs;
    this.window = null;
    this.pending = null;
    this.allowQuit = false;
    this.onBeforeQuit = (event) => this.#intercept(event);
    this.onWindowClose = (event) => this.#intercept(event);
    app.on("before-quit", this.onBeforeQuit);
  }

  attachWindow(window) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeListener("close", this.onWindowClose);
    }
    this.window = window;
    window.on("close", this.onWindowClose);
  }

  #intercept(event) {
    if (this.allowQuit) return;
    event.preventDefault();
    if (this.pending) return;
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      this.#finish();
      return;
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => this.#finish(), this.timeoutMs);
    timer.unref?.();
    this.pending = { requestId, timer };
    this.window.webContents.send(this.channel, {
      requestId,
      deadlineMs: this.timeoutMs,
    });
  }

  ready(requestId) {
    if (!this.pending || requestId !== this.pending.requestId) return false;
    this.#finish();
    return true;
  }

  #finish() {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.allowQuit = true;
    setImmediate(() => this.app.quit());
  }

  dispose() {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.app.removeListener("before-quit", this.onBeforeQuit);
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeListener("close", this.onWindowClose);
    }
  }
}
