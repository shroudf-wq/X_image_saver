const $ = (id) => document.getElementById(id);
let filter = "review";
let items = [];
let hoveredCard = null;
let statusTimer;

function flash(msg) {
  $("status").textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), 2500);
}

function text(l) { return XSAVER_LABEL_TEXT[l] || l; }

function card(it) {
  const c = document.createElement("div");
  c.className = "card";
  c.dataset.id = it.mediaId;
  const a = document.createElement("a");
  a.className = "thumb";
  a.href = `https://pbs.twimg.com/media/${it.mediaId}?format=${it.ext}&name=orig`;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.style.backgroundImage = `url("https://pbs.twimg.com/media/${it.mediaId}?format=${it.ext}&name=small")`;
  const meta = document.createElement("div");
  meta.className = "meta";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = it.user ? "@" + it.user : it.mediaId;
  const chip = document.createElement("span");
  chip.className = "chip " + it.label;
  chip.textContent = text(it.label);
  const score = document.createElement("span");
  score.className = "score";
  score.textContent = it.by === "X" ? "X指定" : it.p != null ? `AI ${Math.round(it.p * 100)}%` : "";
  score.title = "AIが判定したNSFWらしさ";
  meta.append(who, score, chip);
  const act = document.createElement("div");
  act.className = "actions";
  for (const l of ["SFW", "NSFW"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = l;
    if (it.label === l) b.classList.add("cur");
    b.addEventListener("click", () => setLabel(it, l, c));
    act.append(b);
  }
  c.append(a, meta, act);
  if (it.verified) {
    const ok = document.createElement("div");
    ok.className = "ok";
    ok.textContent = it.corrected ? "✓ 直しました" : "✓ 確認済み";
    c.append(ok);
  }
  c.addEventListener("mouseenter", () => (hoveredCard = { c, it }));
  c.addEventListener("mouseleave", () => (hoveredCard = null));
  return c;
}

async function setLabel(it, label, c) {
  c.classList.add("busy");
  const r = await chrome.runtime.sendMessage({ type: "relabel", mediaId: it.mediaId, label });
  if (r?.status === "relabeled") {
    flash(it.label === label ? "確認しました" : `${text(label)} に移動しました` + (r.note ? `（${r.note}）` : ""));
  } else if (r?.status === "busy") {
    flash("処理中です。少し待ってからもう一度押してください");
  } else {
    flash("失敗しました：" + (r?.error || r?.status));
  }
  await load();
}

async function load() {
  items = await chrome.runtime.sendMessage({ type: "list", filter });
  const grid = $("grid");
  grid.replaceChildren(...items.map(card));
  $("empty").hidden = items.length > 0;
  $("count").textContent = `${items.length} 枚` + (items.length >= 300 ? "（新しい300枚まで表示）" : "");
  $("confirmAll").hidden = !(filter === "unchecked" && items.some((i) => i.label === "SFW" || i.label === "NSFW"));
}

document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    filter = b.dataset.filter;
    load();
  })
);

$("confirmAll").addEventListener("click", async () => {
  const targets = items.filter((i) => !i.verified && (i.label === "SFW" || i.label === "NSFW"));
  if (!confirm(`表示中の ${targets.length} 枚を、今の判定のまま「正しい」として確認します。間違っているものは先に直してください。`)) return;
  for (const it of targets) await chrome.runtime.sendMessage({ type: "relabel", mediaId: it.mediaId, label: it.label });
  flash(`${targets.length} 枚を確認しました`);
  load();
});

// ぼかし設定はこのブラウザだけで覚える
function applyBlur(on) {
  document.body.classList.toggle("blur", on);
  $("blur").checked = on;
}
let blurOn = true;
try { blurOn = localStorage.getItem("xsaver-blur") !== "0"; } catch (e) {}
applyBlur(blurOn);
$("blur").addEventListener("change", (e) => {
  applyBlur(e.target.checked);
  try { localStorage.setItem("xsaver-blur", e.target.checked ? "1" : "0"); } catch (err) {}
});

document.addEventListener("keydown", (e) => {
  if (!hoveredCard || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const l = e.key === "1" ? "SFW" : e.key === "2" ? "NSFW" : null;
  if (!l) return;
  e.preventDefault();
  setLabel(hoveredCard.it, l, hoveredCard.c);
});

const q = new URLSearchParams(location.search).get("filter");
if (q) document.querySelector(`.tabs button[data-filter="${q}"]`)?.click();
else load();
