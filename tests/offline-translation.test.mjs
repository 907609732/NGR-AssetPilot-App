import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OfflineTranslationService } from "../desktop/services/offline-translation/service.mjs";
import { OFFLINE_TRANSLATION_MODEL, OFFLINE_TRANSLATION_TOTAL_BYTES } from "../desktop/services/offline-translation/manifest.mjs";

test("离线翻译模型锁定 revision、大小与逐文件 SHA-256", () => {
  assert.equal(OFFLINE_TRANSLATION_MODEL.id, "Xenova/opus-mt-zh-en");
  assert.equal(OFFLINE_TRANSLATION_MODEL.revision, "39d480d52a9ea3065a1f117adfe4dbc55de10e6f");
  assert.equal(OFFLINE_TRANSLATION_MODEL.files.length, 10);
  assert.equal(OFFLINE_TRANSLATION_TOTAL_BYTES, 122855036);
  for (const file of OFFLINE_TRANSLATION_MODEL.files) {
    assert.ok(file.size > 0);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(path.isAbsolute(file.path), false);
    assert.equal(file.path.includes(".."), false);
  }
});

test("离线翻译服务在模型缺失时明确报告，且限制中译英与输入长度", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngr-offline-translation-"));
  const service = new OfflineTranslationService({ modelLibraryRoot: root });
  try {
    assert.equal(service.getStatus().ready, false);
    await assert.rejects(
      service.translate({ text: "hello", from: "en", to: "zh" }),
      (error) => error?.code === "OFFLINE_TRANSLATION_DIRECTION_UNSUPPORTED",
    );
    await assert.rejects(
      service.translate({ text: "首页", from: "zh", to: "en" }),
      (error) => error?.code === "OFFLINE_TRANSLATION_MODEL_MISSING",
    );
    await assert.rejects(
      service.translate({ text: "中".repeat(201), from: "zh", to: "en" }),
      (error) => error?.code === "OFFLINE_TRANSLATION_TEXT_INVALID",
    );
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("旧离线翻译 Worker 延迟退出不会拒绝新 Worker 的请求", async () => {
  class FakeWorker extends EventEmitter {
    messages = [];

    postMessage(message) {
      this.messages.push(message);
    }

    async terminate() {
      return 0;
    }
  }

  const workers = [];
  const service = new OfflineTranslationService({
    modelLibraryRoot: path.join(os.tmpdir(), "ngr-offline-translation-worker-race"),
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  service.getStatus = () => ({ ready: true });

  try {
    const first = service.translate({ text: "首页", from: "zh", to: "en" });
    await new Promise((resolve) => setImmediate(resolve));
    const oldWorker = workers[0];
    oldWorker.emit("error", new Error("simulated worker failure"));
    await assert.rejects(first, (error) => error?.code === "OFFLINE_TRANSLATION_WORKER_EXITED");

    const second = service.translate({ text: "下载", from: "zh", to: "en" });
    await new Promise((resolve) => setImmediate(resolve));
    const newWorker = workers[1];
    assert.ok(newWorker, "第二次请求应创建新的 Worker");
    oldWorker.emit("exit", 1);
    newWorker.emit("message", {
      requestId: newWorker.messages[0].requestId,
      ok: true,
      result: { text: "Download" },
    });
    assert.deepEqual(await second, { text: "Download" });
  } finally {
    await service.dispose();
  }
});

test("离线翻译 Worker 同步发送失败后可由下一次请求恢复", async () => {
  class FakeWorker extends EventEmitter {
    constructor({ throwOnPost = false } = {}) {
      super();
      this.throwOnPost = throwOnPost;
      this.messages = [];
    }

    postMessage(message) {
      if (this.throwOnPost) throw new Error("simulated post failure");
      this.messages.push(message);
    }

    async terminate() {
      return 0;
    }
  }

  const workers = [];
  const service = new OfflineTranslationService({
    modelLibraryRoot: path.join(os.tmpdir(), "ngr-offline-translation-post-race"),
    workerFactory: () => {
      const worker = new FakeWorker({ throwOnPost: workers.length === 0 });
      workers.push(worker);
      return worker;
    },
  });
  service.getStatus = () => ({ ready: true });

  try {
    await assert.rejects(
      service.translate({ text: "首页", from: "zh", to: "en" }),
      (error) => error?.code === "OFFLINE_TRANSLATION_WORKER_POST_FAILED",
    );
    const recovered = service.translate({ text: "下载", from: "zh", to: "en" });
    await new Promise((resolve) => setImmediate(resolve));
    const worker = workers[1];
    worker.emit("message", {
      requestId: worker.messages[0].requestId,
      ok: true,
      result: { text: "Download" },
    });
    assert.deepEqual(await recovered, { text: "Download" });
  } finally {
    await service.dispose();
  }
});

test("同一事件循环内发起翻译后立即关闭不会创建 Worker", async () => {
  const workers = [];
  const service = new OfflineTranslationService({
    modelLibraryRoot: path.join(os.tmpdir(), "ngr-offline-translation-dispose-before-start"),
    workerFactory: () => {
      const worker = new EventEmitter();
      worker.postMessage = () => {};
      worker.terminate = async () => 0;
      workers.push(worker);
      return worker;
    },
  });
  service.getStatus = () => ({ ready: true });

  const translation = service.translate({ text: "首页", from: "zh", to: "en" });
  await service.dispose();

  await assert.rejects(translation, (error) => error?.code === "OFFLINE_TRANSLATION_DISPOSED");
  assert.equal(workers.length, 0);
  assert.equal(service.worker, null);
  assert.equal(service.pending.size, 0);
});

test("关闭服务会拒绝排队翻译且不会重新创建 Worker", async () => {
  class FakeWorker extends EventEmitter {
    messages = [];

    postMessage(message) {
      this.messages.push(message);
    }

    async terminate() {
      return 0;
    }
  }

  const workers = [];
  const service = new OfflineTranslationService({
    modelLibraryRoot: path.join(os.tmpdir(), "ngr-offline-translation-dispose-queued"),
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  service.getStatus = () => ({ ready: true });

  const first = service.translate({ text: "首页", from: "zh", to: "en" });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = service.translate({ text: "下载", from: "zh", to: "en" });
  await service.dispose();

  await assert.rejects(first, (error) => error?.code === "OFFLINE_TRANSLATION_WORKER_EXITED");
  await assert.rejects(queued, (error) => error?.code === "OFFLINE_TRANSLATION_DISPOSED");
  assert.equal(workers.length, 1);
  assert.equal(service.worker, null);
  assert.equal(service.pending.size, 0);
});
