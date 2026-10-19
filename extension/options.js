const $ = (id) => document.getElementById(id);
const textIds = ["baseFolder", "sfwFolder", "nsfwFolder", "reviewFolder", "saveKey", "sfwKey", "nsfwKey"];
const checkIds = ["countSexy", "perUserFolder", "skipSaved", "showBadge", "useReview", "learn"];
const rangeIds = { hoverDelay: (v) => (v / 1000).toFixed(1) + " 秒", threshold: (v) => Number(v).toFixed(2), reviewBand: (v) => "±" + Number(v).toFixed(2) };
let s = {};
let statusTimer;

function flash(msg) {
  $("status").textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), 1800);
}

function render() {
  document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === s.mode));
  for (const [id, fmt] of Object.entries(rangeIds)) {
    $(id).value = s[id];
    $(id + "Out").textContent = fmt(s[id]);
  }
  $("hoverDelay").disabled = s.mode !== "hover";
  $("reviewBand").disabled = !s.useReview;
  for (const id of textIds) if (document.activeElement !== $(id)) $(id).value = s[id];
  for (const id of checkIds) $(id).checked = !!s[id];
  const parts = [s.baseFolder, s.nsfwFolder];
  if (s.perUserFolder) parts.push("username");
  parts.push("username_1850000000000000000_1.jpg");
  $("example").textContent = "ダウンロード/" + parts.join("/");
}

async function save(patch) {
  Object.assign(s, patch);
  render();
  try {
    await chrome.storage.sync.set(patch);
    flash("保存しました");
  } catch (e) {
    flash("保存できませんでした：" + (e?.message || e));
  }
}

// スライダーは動かしている間は表示だけ更新し、指を離したときに1回だけ保存する
// （chrome.storage.sync は1分あたりの書き込み回数に上限があるため）
function preview(patch) {
  Object.assign(s, patch);
  render();
}

const pct = (v) => (v * 100).toFixed(1) + "%";

async function loadStats() {
  const st = await chrome.runtime.sendMessage({ type: "stats" });
  if (!st?.count) return;
  const c = st.count;
  $("stats").textContent = `これまでの保存：SFW ${c.SFW} 枚 / NSFW ${c.NSFW} 枚 / 要確認 ${c.Review} 枚` + (c.Unsorted ? ` / 未判定 ${c.Unsorted} 枚` : "");

  if (st.accuracy == null) {
    $("accuracy").textContent = "まだ測れていません";
    $("accuracyNote").textContent = "振り分けページや 1 / 2 キーで判定を確認・修正すると、あなたの使い方での実際の正解率がここに出ます。";
  } else {
    $("accuracy").textContent = `正解率 ${pct(st.accuracy)}`;
    $("accuracyNote").textContent =
      `確認した ${st.checked} 枚のうち ${st.correct} 枚が正しく振り分けられていました（要確認に回った画像は含みません）。` +
      (st.reviewRate != null ? ` 要確認に回った割合：${pct(st.reviewRate)}。` : "") +
      (st.checked < 50 ? " まだ枚数が少ないので目安です。" : "");
  }
  const m = st.marqo;
  $("modelInfo").textContent = "判定モデル：NSFWJS（MobileNetV2）" +
    (m && !m.dummy ? " ＋ Marqo（ViT）の組み合わせ" : m?.dummy ? "（Marqoはテスト用のダミーなので使っていません）" : "");

  const p = st.personal;
  if (!s.learn) $("learnInfo").textContent = "";
  else if (!p) $("learnInfo").textContent = "確認・修正した画像が増えると、あなたの基準に合わせて判定を調整します。";
  else if (p.enabled)
    $("learnInfo").textContent = `学習中：確認済み ${p.n} 枚から作った判定を使っています（見込みの正解率 ${pct(p.cv.personal)}、標準の判定は ${pct(p.cv.base)}）。`;
  else $("learnInfo").textContent = `確認済み ${p.n} 枚（NSFW ${p.pos} / SFW ${p.neg}）。${p.reason}` +
    (p.cv ? `（学習した判定 ${pct(p.cv.personal)} / 標準 ${pct(p.cv.base)}）` : "");
}

(async () => {
  s = Object.assign({}, XSAVER_DEFAULTS, await chrome.storage.sync.get(null));
  render();
  loadStats();

  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => save({ mode: r.value }))
  );
  for (const id of Object.keys(rangeIds)) {
    $(id).addEventListener("input", (e) => preview({ [id]: Number(e.target.value) }));
    $(id).addEventListener("change", (e) => save({ [id]: Number(e.target.value) }));
  }
  for (const id of checkIds) $(id).addEventListener("change", (e) => { save({ [id]: e.target.checked }); if (id === "learn") loadStats(); });
  for (const id of textIds) {
    $(id).addEventListener("change", (e) => {
      const v = e.target.value.trim() || XSAVER_DEFAULTS[id];
      e.target.value = v;
      save({ [id]: v });
    });
  }
  $("resetLearning").addEventListener("click", async () => {
    if (!confirm("学習結果と「確認済み」の記録をリセットしますか？（保存した画像ファイルは消えません）")) return;
    await chrome.runtime.sendMessage({ type: "resetLearning" });
    flash("学習をリセットしました");
    loadStats();
  });
  $("clear").addEventListener("click", async () => {
    if (!confirm("保存履歴をリセットしますか？学習結果も消えます。（保存した画像ファイルは消えません）")) return;
    const r = await chrome.runtime.sendMessage({ type: "clearHistory" });
    flash(`履歴を ${r.removed} 件リセットしました`);
    loadStats();
  });
})();
