// 実行時に読み込む WebAssembly を extension/ にコピーする（CDN からは読み込まない）
import { copyFileSync, mkdirSync } from "node:fs";
const copies = [
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "extension/ort/ort-wasm-simd-threaded.wasm"],
  ["node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm", "extension/tfjs/tfjs-backend-wasm.wasm"],
  ["node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm", "extension/tfjs/tfjs-backend-wasm-simd.wasm"],
];
for (const [from, to] of copies) {
  mkdirSync(to.slice(0, to.lastIndexOf("/")), { recursive: true });
  copyFileSync(from, to);
  console.log("copied", to);
}
