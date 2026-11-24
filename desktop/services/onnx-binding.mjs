import { registerHooks } from "node:module";
import path from "node:path";

const directory = process.env.NGR_ONNX_COMPONENT_DIRECTORY;
if (directory) {
  // Only redirect the pinned ONNX package's own native binding request.
  // Windows resolves its DLLs beside the binding, without modifying PATH.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "../bin/napi-v6/win32/x64/onnxruntime_binding.node" &&
          context.parentURL?.endsWith("/onnxruntime-node/dist/binding.js")) {
        return nextResolve(path.join(directory, "onnxruntime_binding.node"), context);
      }
      return nextResolve(specifier, context);
    },
  });
}
