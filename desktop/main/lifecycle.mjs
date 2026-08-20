import { randomUUID } from "node:crypto";

export class QuitCoordinator {
  constructor({ app, channel, timeoutMs = 5_000 }) {
    this.app = app;
    this.channel = channel;
    this.timeoutMs = timeoutMs;
    this.window = null;
    this.pending = null;
    this.allowQuit = false;
    this.finalizers = new Map();
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

  addFinalizer(name, finalizer) {
    const key = String(name || "").trim();
    if (!key || typeof finalizer !== "function") throw new TypeError("finalizer name and function are required");
    this.finalizers.set(key, finalizer);
    return () => this.finalizers.delete(key);
  }

  #intercept(event) {
    if (this.allowQuit) return;
    event.preventDefault();
    if (this.pending) return;
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      this.pending = {
        requestId: randomUUID(),
        timer: null,
        finalizing: false,
        finalizersDone: false,
        rendererReady: true,
      };
      this.#startDeadline();
      void this.#runFinalizers();
      return;
    }

    const requestId = randomUUID();
    this.pending = {
      requestId,
      timer: null,
      finalizing: false,
      finalizersDone: false,
      rendererReady: false,
    };
    this.#startDeadline();
    void this.#runFinalizers();
    this.window.webContents.send(this.channel, {
      requestId,
      deadlineMs: this.timeoutMs,
    });
  }

  ready(requestId) {
    if (!this.pending || requestId !== this.pending.requestId) return false;
    this.pending.rendererReady = true;
    this.#finishIfReady();
    return true;
  }

  #startDeadline() {
    const timer = setTimeout(() => this.#finish(), this.timeoutMs);
    timer.unref?.();
    this.pending.timer = timer;
  }

  async #runFinalizers() {
    if (!this.pending || this.pending.finalizing) return;
    this.pending.finalizing = true;
    const tasks = [...this.finalizers.entries()].map(async ([name, finalizer]) => {
      try {
        await finalizer();
      } catch {
        // Quit must remain bounded even when a subsystem cannot finalize.
        return name;
      }
      return null;
    });
    await Promise.allSettled(tasks);
    if (!this.pending) return;
    this.pending.finalizersDone = true;
    this.#finishIfReady();
  }

  #finishIfReady() {
    if (this.pending?.rendererReady && this.pending?.finalizersDone) this.#finish();
  }

  #finish() {
    if (this.allowQuit) return;
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.allowQuit = true;
    setImmediate(() => this.app.quit());
  }

  dispose() {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.finalizers.clear();
    this.app.removeListener("before-quit", this.onBeforeQuit);
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeListener("close", this.onWindowClose);
    }
  }
}
