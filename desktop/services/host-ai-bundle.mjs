import path from "node:path";
import { OFFLINE_TRANSLATION_MODEL } from "./offline-translation/manifest.mjs";

const runtime = "onnxruntime-win32-x64.tgz";
const translationRoot = "offline-translation";

export const hostAiBundleFiles = Object.freeze({
  [runtime]: {
    bytes: 113507888,
    sha256: "6e3390d6b783e7be946fad629292799da28d0b42f84856e50d2c1b0383291e75",
  },
  ...Object.fromEntries(OFFLINE_TRANSLATION_MODEL.files.map(file => [
    `${translationRoot}/${file.path}`,
    { bytes: file.size, sha256: file.sha256 },
  ])),
});

export function createHostAiBundleComponents({ onnxComponent, offlineTranslationInstaller }) {
  return {
    files: hostAiBundleFiles,
    async install(staging) {
      if (onnxComponent) await onnxComponent.install(path.join(staging, runtime));
      await offlineTranslationInstaller.install(path.join(staging, translationRoot));
      await this.activateSharedRtx?.();
    },
  };
}
