importScripts("defaults.js", "learn.js");

const OFFSCREEN_URL = "offscreen.html";
const LABELS = ["SFW", "NSFW", "Review", "Unsorted"];
let creatingOffscreen = null;

async function getSettings() {
  return Object.assign({}, XSAVER_DEFAULTS, await chrome.storage.sync.get(null));
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["BLOBS"],
        justification: "画像のNSFW判定モデルをブラウザ内で実行するため"
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function classify(url) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "classify", url });
  if (!res?.ok) throw new Error(res?.error || "判定に失敗しました");
  return { nsfwjs: res.nsfwjs, marqo: res.marqo };
}

// ファイル名・フォルダ名に使えない文字を除去（Windowsの予約名・末尾のドットや空白も）
function safe(s) {
  let v = String(s || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[._\s]+|[._\s]+$/g, "")
    .slice(0, 80);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(v)) v = "_" + v;
  return v || "_";
}

// コンテンツスクリプトから来た情報は信用せず、ここで作り直す
function normalizeItem(raw) {
  const mediaId = String(raw?.mediaId || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) throw new Error("不正な画像IDです");
  const ext = raw?.ext === "png" ? "png" : "jpg";
  const pick = (v, re) => (re.test(String(v || "")) ? String(v) : "");
  return {
    mediaId,
    ext,
    origUrl: `https://pbs.twimg.com/media/${mediaId}?format=${ext}&name=orig`,
    classifyUrl: `https://pbs.twimg.com/media/${mediaId}?format=${ext}&name=small`,
    user: pick(raw?.user, /^[A-Za-z0-9_]{1,15}$/),
    statusId: pick(raw?.statusId, /^\d{1,25}$/),
    index: pick(raw?.index, /^[1-4]$/),
    xSensitive: raw?.xSensitive === true
  };
}

function isExtensionPage(sender) {
  // 設定画面はタブで開かれることがあるので sender.tab の有無では判断しない。
  // コンテンツスクリプトの sender.url は x.com のURLになるので、拡張機能のURLかどうかで見分けられる
  return sender?.id === chrome.runtime.id && String(sender.url || "").startsWith(chrome.runtime.getURL(""));
}

// ダウンロード完了（または失敗）を待つ。登録前に終わっていた場合も取りこぼさない
function waitForDownload(id) {
  return new Promise((resolve) => {
    const done = (state) => { chrome.downloads.onChanged.removeListener(listener); resolve(state); };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") done(delta.state.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([d]) => {
      if (d && (d.state === "complete" || d.state === "interrupted")) done(d.state);
    });
  });
}

function folderFor(label, s) {
  return { NSFW: s.nsfwFolder, SFW: s.sfwFolder, Review: s.reviewFolder }[label] || "Unsorted";
}

function relPath(entry, label, s) {
  const parts = [safe(s.baseFolder), safe(folderFor(label, s))];
  if (s.perUserFolder && entry.user) parts.push(safe(entry.user));
  // 投稿IDか枚数が分からないときは画像IDを付けて、別の画像と名前が混ざらないようにする
  const base = entry.statusId && entry.index
    ? [entry.user, entry.statusId, entry.index].filter(Boolean).join("_")
    : [entry.user, entry.statusId, entry.mediaId].filter(Boolean).join("_");
  parts.push(safe(base) + "." + entry.ext);
  return parts.join("/");
}

async function download(url, filename) {
  const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
  const state = await waitForDownload(id);
  if (state !== "complete") throw new Error("ダウンロードが中断されました");
  return id;
}

// ---- 判定 ----
let personalCache = null;
async function getPersonal() {
  if (!personalCache) personalCache = (await chrome.storage.local.get("personal")).personal || null;
  return personalCache;
}

async function decide(cls, xSensitive, s) {
  if (xSensitive) return { label: "NSFW", p: 1, by: "X" }; // X自身がセンシティブ指定している
  const personal = s.learn ? await getPersonal() : null;
  let p, by;
  if (personal?.enabled && personal.model) {
    p = xsaverPredict(personal.model, xsaverFeatures(cls, false));
    by = "personal";
  } else {
    p = xsaverBaseProb(cls, s);
    by = cls.marqo && !cls.marqo.dummy ? "ensemble" : "nsfwjs";
  }
  const th = Number(s.threshold), band = Number(s.reviewBand);
  let label;
  if (s.useReview && p > th - band && p < th + band) label = "Review";
  else label = p >= th ? "NSFW" : "SFW";
  return { label, p, by };
}

// ---- 保存 ----

async function handleSave(rawItem, forcedLabel = null) {
  const item = normalizeItem(rawItem);
  const key = "saved:" + item.mediaId;
  if (forcedLabel && forcedLabel !== "SFW" && forcedLabel !== "NSFW") throw new Error("不正なラベルです");

  if (inFlight.has(item.mediaId)) {
    // 自動保存の最中に 1 / 2 キーが押されたら、保存が終わるのを待ってから直す
    if (!forcedLabel) return { status: "busy" };
    await inFlight.get(item.mediaId).catch(() => {});
    return relabel(item.mediaId, forcedLabel);
  }
  // 確認と「処理中」の登録の間に await を挟まない（同時に来た依頼を確実に1つにする）
  return track(item.mediaId, (async () => {
    const s = await getSettings();
    const prev = (await chrome.storage.local.get(key))[key];
    if (prev) {
      if (forcedLabel) return relabelNow(item.mediaId, forcedLabel, key, prev);
      if (s.skipSaved) return { status: "skipped", label: prev.label };
    }
    return saveNew(item, s, key, forcedLabel);
  })());
}

// 同じ画像の処理が重ならないように、処理中のものを覚えておく
const inFlight = new Map();
function track(mediaId, promise) {
  inFlight.set(mediaId, promise);
  return promise.finally(() => inFlight.delete(mediaId));
}

async function saveNew(item, s, key, forcedLabel) {
  {
    // 判定は軽い "small" サイズで行い、保存は原寸
    let cls = null, auto;
    try {
      cls = await classify(item.classifyUrl);
      auto = await decide(cls, item.xSensitive, s);
    } catch (e) {
      console.warn("[X Image Saver] 判定失敗:", e);
      auto = { label: "Unsorted", p: null, by: "error" };
    }
    const label = forcedLabel || auto.label;
    const entry = {
      mediaId: item.mediaId, ext: item.ext, user: item.user, statusId: item.statusId, index: item.index,
      xs: item.xSensitive, cls, p: auto.p, by: auto.by, autoLabel: auto.label, label,
      verified: !!forcedLabel, t: Date.now()
    };
    entry.filename = relPath(entry, label, s);
    entry.downloadId = await download(item.origUrl, entry.filename);
    await chrome.storage.local.set({ [key]: entry });
    if (forcedLabel) scheduleRetrain();
    return { status: "saved", label, filename: entry.filename, p: auto.p, by: auto.by };
  }
}

// ---- 判定を直す（別フォルダに保存し直して、元のファイルを消す）----
async function relabel(mediaId, label) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(mediaId))) throw new Error("不正な画像IDです");
  if (label !== "SFW" && label !== "NSFW") throw new Error("不正なラベルです");
  if (inFlight.has(mediaId)) {
    await inFlight.get(mediaId).catch(() => {});
    return relabel(mediaId, label); // 前の処理が終わってから最新の状態で直す
  }
  const key = "saved:" + mediaId;
  return track(mediaId, (async () => {
    const entry = (await chrome.storage.local.get(key))[key];
    if (!entry) return { status: "notfound" };
    return relabelNow(mediaId, label, key, entry);
  })());
}

async function relabelNow(mediaId, label, key, entry) {
  {
    entry.ext = entry.ext || (/\.png$/i.test(entry.filename || "") ? "png" : "jpg");
    entry.mediaId = mediaId;
    let note = "";
    if (entry.label !== label) {
      const s = await getSettings();
      const filename = relPath(entry, label, s);
      const url = `https://pbs.twimg.com/media/${mediaId}?format=${entry.ext}&name=orig`;
      const newId = await download(url, filename);
      // 元のファイルを消す（ユーザーが移動・削除済みなら何もしない）
      let oldId = entry.downloadId;
      if (oldId == null) {
        const [d] = await chrome.downloads.search({ url, state: "complete" });
        if (d && d.id !== newId) oldId = d.id;
      }
      if (oldId != null) {
        try { await chrome.downloads.removeFile(oldId); } catch (e) { note = "元のファイルは見つかりませんでした"; }
        try { await chrome.downloads.erase({ id: oldId }); } catch (e) {}
      } else {
        note = "元のファイルは手動で削除してください";
      }
      entry.filename = filename;
      entry.downloadId = newId;
      entry.corrected = entry.autoLabel === "SFW" || entry.autoLabel === "NSFW" ? entry.autoLabel !== label : false;
    }
    entry.label = label;
    entry.verified = true;
    await chrome.storage.local.set({ [key]: entry });
    scheduleRetrain();
    return { status: "relabeled", label, filename: entry.filename, note };
  }
}

// ---- 学習 ----
let retrainTimer = null;
function scheduleRetrain() {
  clearTimeout(retrainTimer);
  retrainTimer = setTimeout(retrain, 1500);
}

async function allEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith("saved:")).map(([k, v]) => ({ ...v, mediaId: v.mediaId || k.slice(6) }));
}

async function retrain() {
  const s = await getSettings();
  const examples = (await allEntries())
    .filter((e) => e.verified && e.cls && (e.label === "SFW" || e.label === "NSFW"))
    .map((e) => ({ f: xsaverFeatures(e.cls, e.xs), y: e.label === "NSFW" ? 1 : 0, cls: e.cls, xs: e.xs }));
  const personal = xsaverBuildPersonal(examples, s);
  personal.t = Date.now();
  personalCache = personal;
  await chrome.storage.local.set({ personal });
  return personal;
}

async function stats() {
  const entries = await allEntries();
  const count = { SFW: 0, NSFW: 0, Review: 0, Unsorted: 0 };
  for (const e of entries) count[e.label] = (count[e.label] || 0) + 1;
  // 実測の精度：自動でSFW/NSFWに振り分けたうち、あなたが確認した（直した・正しいと確認した）もの
  const checked = entries.filter((e) => e.verified && (e.autoLabel === "SFW" || e.autoLabel === "NSFW") && (e.label === "SFW" || e.label === "NSFW"));
  const correct = checked.filter((e) => e.autoLabel === e.label).length;
  const auto = entries.filter((e) => e.autoLabel && e.autoLabel !== "Unsorted");
  const review = auto.filter((e) => e.autoLabel === "Review").length;
  const personal = await getPersonal();
  let model = null;
  try {
    await ensureOffscreen();
    model = await chrome.runtime.sendMessage({ target: "offscreen", type: "status" });
  } catch (e) {}
  return {
    count,
    checked: checked.length,
    correct,
    accuracy: checked.length ? correct / checked.length : null,
    reviewRate: auto.length ? review / auto.length : null,
    personal: personal ? { enabled: personal.enabled, n: personal.n, pos: personal.pos, neg: personal.neg, cv: personal.cv, reason: personal.reason } : null,
    marqo: model?.marqo || null
  };
}

async function listEntries(filter) {
  let entries = (await allEntries()).sort((a, b) => b.t - a.t);
  if (filter === "review") entries = entries.filter((e) => e.label === "Review" || e.label === "Unsorted");
  else if (filter === "unchecked") entries = entries.filter((e) => !e.verified);
  else if (filter === "corrected") entries = entries.filter((e) => e.corrected);
  return entries.slice(0, 300).map((e) => ({
    mediaId: e.mediaId, ext: e.ext || "jpg", user: e.user, label: e.label, autoLabel: e.autoLabel,
    p: e.p, by: e.by, verified: !!e.verified, corrected: !!e.corrected, filename: e.filename, t: e.t
  }));
}

// ---- メッセージ ----
function reply(promise, sendResponse) {
  promise.then(sendResponse).catch((e) => sendResponse({ status: "error", error: String(e?.message || e) }));
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id) return;
  if (msg?.target === "offscreen") return;
  switch (msg?.type) {
    case "save":
      return reply(handleSave(msg.item), sendResponse);
    case "label": // ホバー中に 1 / 2 キー：未保存なら指定のフォルダに保存、保存済みなら直す
      if (msg.label !== "SFW" && msg.label !== "NSFW") return;
      return reply(handleSave(msg.item, msg.label), sendResponse);
    case "warmup":
      ensureOffscreen().catch(() => {}); // Xを開いた時点でモデルを先読みしておく
      return;
  }
  // ここから下は拡張機能の画面（設定・振り分けページ）からだけ受け付ける
  if (!isExtensionPage(sender)) return;
  switch (msg?.type) {
    case "relabel":
      return reply(relabel(msg.mediaId, msg.label), sendResponse);
    case "list":
      return reply(listEntries(msg.filter), sendResponse);
    case "stats":
      return reply(stats(), sendResponse);
    case "retrain":
      return reply(retrain(), sendResponse);
    case "resetLearning":
      return reply((async () => {
        const entries = await allEntries();
        const patch = {};
        for (const e of entries) if (e.verified) patch["saved:" + e.mediaId] = { ...e, verified: false, corrected: false };
        await chrome.storage.local.set(patch);
        return retrain();
      })(), sendResponse);
    case "clearHistory":
      return reply((async () => {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => k.startsWith("saved:") || k === "personal");
        await chrome.storage.local.remove(keys);
        personalCache = null;
        return { removed: keys.filter((k) => k !== "personal").length };
      })(), sendResponse);
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
