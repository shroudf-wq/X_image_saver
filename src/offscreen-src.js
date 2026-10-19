// オフスクリーン文書：判定モデルをブラウザ内で動かす（画像は外部に送信しない）
//  - NSFWJS (MobileNetV2 Mid, TensorFlow.js)
//  - Marqo nsfw-image-detection-384 (ViT, ONNX Runtime Web)  ※ models/marqo があるときだけ
import * as tf from "@tensorflow/tfjs";
import { load } from "nsfwjs/core";
import { MobileNetV2MidModel } from "nsfwjs/models/mobilenet_v2_mid";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import * as ort from "onnxruntime-web/wasm";

setWasmPaths(chrome.runtime.getURL("tfjs/"));
// マルチスレッド版はクロスオリジン分離が必要で、オフスクリーン文書では動かないので使わない
tf.env().set("WASM_HAS_MULTITHREAD_SUPPORT", false);

// ---------- NSFWJS ----------
let nsfwjsPromise = null;
const backendLog = []; // どの計算方式が使えなかったか（診断用）
function getNsfwjs() {
  if (!nsfwjsPromise) {
    nsfwjsPromise = (async () => {
      // GPU(WebGL) → WebAssembly(CPUでも速い) → 素のJavaScript の順に試す。
      // setBackend は失敗しても例外を出さず false を返すので、戻り値で判定する
      for (const name of ["webgl", "wasm", "cpu"]) {
        let ok = false;
        const warn = console.warn;
        console.warn = (...a) => { backendLog.push(name + ": " + a.map(String).join(" ").slice(0, 300)); warn(...a); };
        try { ok = await tf.setBackend(name); } catch (e) { ok = false; backendLog.push(name + ": " + e); }
        finally { console.warn = warn; }
        if (ok) break;
      }
      await tf.ready();
      return load("MobileNetV2Mid", { modelDefinitions: [MobileNetV2MidModel] });
    })().catch((e) => { nsfwjsPromise = null; throw e; });
  }
  return nsfwjsPromise;
}

// ---------- Marqo (ONNX) ----------
ort.env.wasm.wasmPaths = { wasm: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.wasm") };
ort.env.wasm.numThreads = 1;   // オフスクリーン文書はクロスオリジン分離されていないので1スレッド
ort.env.wasm.proxy = false;

let marqoPromise = null;
function getMarqo() {
  if (!marqoPromise) {
    marqoPromise = (async () => {
      const res = await fetch(chrome.runtime.getURL("models/marqo/model.json"));
      if (!res.ok) return null; // モデル未同梱
      const meta = await res.json();
      const session = await ort.InferenceSession.create(chrome.runtime.getURL("models/marqo/model.onnx"), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all"
      });
      return { meta, session };
    })().catch((e) => { console.warn("[X Image Saver] Marqoモデルを読み込めません:", e); return null; });
  }
  return marqoPromise;
}

// timm の評価時と同じ前処理：短辺を size/crop_pct に縮小 → 中央を size×size で切り出し → 正規化
function preprocess(bitmap, meta) {
  const [, , H, W] = meta.input;
  const scale = Math.round(H / (meta.crop_pct || 1)) / Math.min(bitmap.width, bitmap.height);
  const rw = Math.max(W, Math.round(bitmap.width * scale));
  const rh = Math.max(H, Math.round(bitmap.height * scale));
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, -Math.floor((rw - W) / 2), -Math.floor((rh - H) / 2), rw, rh);
  const px = g.getImageData(0, 0, W, H).data;
  const out = new Float32Array(3 * H * W);
  const plane = H * W;
  for (let i = 0; i < plane; i++) {
    for (let ch = 0; ch < 3; ch++) {
      out[ch * plane + i] = (px[i * 4 + ch] / 255 - meta.mean[ch]) / meta.std[ch];
    }
  }
  return new ort.Tensor("float32", out, meta.input);
}

function softmax(a) {
  const m = Math.max(...a);
  const e = a.map((v) => Math.exp(v - m));
  const s = e.reduce((x, y) => x + y, 0);
  return e.map((v) => v / s);
}

async function runMarqo(bitmap) {
  const m = await getMarqo();
  if (!m) return null;
  const out = await m.session.run({ pixel_values: preprocess(bitmap, m.meta) });
  const probs = softmax(Array.from(out.logits.data));
  const nsfw = probs[m.meta.labels.indexOf(m.meta.nsfw_label)];
  return { nsfw, dummy: !!m.meta.dummy };
}

async function runNsfwjs(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const model = await getNsfwjs();
  const preds = await model.classify(canvas, 5);
  const scores = {};
  for (const p of preds) scores[p.className] = p.probability;
  return scores; // { Drawing, Hentai, Neutral, Porn, Sexy }
}

async function classify(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("画像の取得に失敗: HTTP " + res.status);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const t0 = performance.now();
    const nsfwjs = await runNsfwjs(bitmap);
    const t1 = performance.now();
    const marqo = await runMarqo(bitmap);
    const t2 = performance.now();
    return { nsfwjs, marqo, ms: Math.round(t2 - t0), msNsfwjs: Math.round(t1 - t0), msMarqo: Math.round(t2 - t1), backend: tf.getBackend() };
  } finally {
    bitmap.close();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "classify") {
    classify(msg.url)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === "status") {
    Promise.all([getMarqo(), getNsfwjs().catch(() => null)]).then(([m]) =>
      sendResponse({ marqo: m ? { name: m.meta.name, dummy: !!m.meta.dummy } : null, backend: tf.getBackend(), backendLog }));
    return true;
  }
});

// 起動時にモデルを先読み
getNsfwjs().catch(() => {});
getMarqo();
