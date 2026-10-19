importScripts("defaults.js");

const OFFSCREEN_URL = "offscreen.html";
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
  return res.scores;
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
  return sender?.id === chrome.runtime.id && !sender.tab && String(sender.url || "").startsWith(chrome.runtime.getURL(""));
}

// ダウンロード完了（または失敗）を待つ
function waitForDownload(id) {
  return new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(delta.state.current);
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

const inFlight = new Set();

async function handleSave(rawItem) {
  const item = normalizeItem(rawItem);
  const s = await getSettings();
  const key = "saved:" + item.mediaId;

  if (s.skipSaved) {
    const prev = (await chrome.storage.local.get(key))[key];
    if (prev) return { status: "skipped", label: prev.label };
  }
  if (inFlight.has(item.mediaId)) return { status: "busy" };
  inFlight.add(item.mediaId);

  try {
    // 判定は軽い "small" サイズで行い、保存は原寸
    let label = "SFW";
    let scores = null;
    if (item.xSensitive) {
      label = "NSFW"; // X自身がセンシティブ指定している
    } else try {
      scores = await classify(item.classifyUrl);
      let nsfw = (scores.Porn || 0) + (scores.Hentai || 0);
      if (s.countSexy) nsfw += scores.Sexy || 0;
      label = nsfw >= Number(s.threshold) ? "NSFW" : "SFW";
    } catch (e) {
      console.warn("[X Image Saver] 判定失敗、Unsortedに保存します:", e);
      label = "Unsorted";
    }

    const folder = label === "NSFW" ? s.nsfwFolder : label === "SFW" ? s.sfwFolder : "Unsorted";
    const parts = [safe(s.baseFolder), safe(folder)];
    if (s.perUserFolder && item.user) parts.push(safe(item.user));
    // 投稿IDか枚数が分からないときは画像IDを付けて、別の画像と名前が混ざらないようにする
    const base = item.statusId && item.index
      ? [item.user, item.statusId, item.index].filter(Boolean).join("_")
      : [item.user, item.statusId, item.mediaId].filter(Boolean).join("_");
    parts.push(safe(base) + "." + item.ext);
    const filename = parts.join("/");

    const id = await chrome.downloads.download({
      url: item.origUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    const state = await waitForDownload(id);
    if (state !== "complete") throw new Error("ダウンロードが中断されました");

    await chrome.storage.local.set({ [key]: { label, filename, t: Date.now() } });
    return { status: "saved", label, filename, scores };
  } finally {
    inFlight.delete(item.mediaId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id) return;
  if (msg?.type === "save") {
    handleSave(msg.item)
      .then(sendResponse)
      .catch((e) => sendResponse({ status: "error", error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === "warmup") {
    ensureOffscreen().catch(() => {}); // Xを開いた時点でモデルを先読みしておく
    return;
  }
  if (msg?.type === "clearHistory") {
    if (!isExtensionPage(sender)) return; // 設定画面からのみ受け付ける
    chrome.storage.local.get(null).then(async (all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith("saved:"));
      await chrome.storage.local.remove(keys);
      sendResponse({ removed: keys.length });
    });
    return true;
  }
  if (msg?.type === "stats") {
    chrome.storage.local.get(null).then((all) => {
      const st = { SFW: 0, NSFW: 0, Unsorted: 0 };
      for (const [k, v] of Object.entries(all)) if (k.startsWith("saved:")) st[v.label] = (st[v.label] || 0) + 1;
      sendResponse(st);
    });
    return true;
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
