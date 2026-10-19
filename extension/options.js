const $ = (id) => document.getElementById(id);
const textIds = ["baseFolder", "sfwFolder", "nsfwFolder", "saveKey"];
const checkIds = ["countSexy", "perUserFolder", "skipSaved", "showBadge"];
let s = {};
let statusTimer;

function flash(msg) {
  $("status").textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), 1500);
}

function render() {
  document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === s.mode));
  $("hoverDelay").value = s.hoverDelay;
  $("hoverDelayOut").textContent = (s.hoverDelay / 1000).toFixed(1) + " 秒";
  $("hoverDelay").disabled = s.mode !== "hover";
  $("threshold").value = s.threshold;
  $("thresholdOut").textContent = Number(s.threshold).toFixed(2);
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

async function loadStats() {
  const st = await chrome.runtime.sendMessage({ type: "stats" });
  $("stats").textContent = `これまでの保存：SFW ${st.SFW} 枚 / NSFW ${st.NSFW} 枚` + (st.Unsorted ? ` / 未判定 ${st.Unsorted} 枚` : "");
}

(async () => {
  s = Object.assign({}, XSAVER_DEFAULTS, await chrome.storage.sync.get(null));
  render();
  loadStats();

  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => save({ mode: r.value }))
  );
  for (const id of ["hoverDelay", "threshold"]) {
    $(id).addEventListener("input", (e) => preview({ [id]: Number(e.target.value) }));
    $(id).addEventListener("change", (e) => save({ [id]: Number(e.target.value) }));
  }
  for (const id of checkIds) $(id).addEventListener("change", (e) => save({ [id]: e.target.checked }));
  for (const id of textIds) {
    $(id).addEventListener("change", (e) => {
      const v = e.target.value.trim() || XSAVER_DEFAULTS[id];
      e.target.value = v;
      save({ [id]: v });
    });
  }
  $("clear").addEventListener("click", async () => {
    if (!confirm("保存履歴をリセットしますか？（保存した画像ファイルは消えません）")) return;
    const r = await chrome.runtime.sendMessage({ type: "clearHistory" });
    flash(`履歴を ${r.removed} 件リセットしました`);
    loadStats();
  });
})();
