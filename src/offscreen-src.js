// オフスクリーン文書：NSFW判定モデルをブラウザ内で動かす（画像は外部に送信しない）
import * as tf from "@tensorflow/tfjs";
import { load } from "nsfwjs/core";
import { MobileNetV2MidModel } from "nsfwjs/models/mobilenet_v2_mid";

let modelPromise = null;

function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      // setBackend は失敗しても例外を出さず false を返すので、戻り値で判定する
      let ok = false;
      try {
        ok = await tf.setBackend("webgl");
      } catch (e) {
        ok = false;
      }
      if (!ok) await tf.setBackend("cpu");
      await tf.ready();
      return load("MobileNetV2Mid", { modelDefinitions: [MobileNetV2MidModel] });
    })().catch((e) => {
      modelPromise = null;
      throw e;
    });
  }
  return modelPromise;
}

async function classify(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("画像の取得に失敗: HTTP " + res.status);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const model = await getModel();
  const preds = await model.classify(canvas, 5);
  const scores = {};
  for (const p of preds) scores[p.className] = p.probability;
  return scores; // { Drawing, Hentai, Neutral, Porn, Sexy }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen" || msg.type !== "classify") return;
  classify(msg.url)
    .then((scores) => sendResponse({ ok: true, scores }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// 起動時にモデルを先読み
getModel().catch(() => {});
