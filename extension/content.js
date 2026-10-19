(() => {
  const MEDIA_RE = /^https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)(?:\.(jpe?g|png|webp|gif))?(?=$|[?:])/i;
  let settings = Object.assign({}, XSAVER_DEFAULTS);
  chrome.storage.sync.get(null).then((s) => Object.assign(settings, s));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue ?? XSAVER_DEFAULTS[k];
  });

  chrome.runtime.sendMessage({ type: "warmup" }).catch(() => {});

  // ---- 画面上の表示 ----
  const ring = document.createElement("div");
  ring.className = "xsaver-ring";
  ring.innerHTML = '<svg viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/><circle class="fg" cx="18" cy="18" r="15"/></svg>';
  const toastLayer = document.createElement("div");
  toastLayer.className = "xsaver-layer";
  document.documentElement.append(ring, toastLayer);

  function placeAtCorner(el, img, corner) {
    const r = img.getBoundingClientRect();
    el.style.top = Math.max(4, r.top + 8) + "px";
    el.style.left = (corner === "right" ? r.right - 44 : r.left + 8) + "px";
  }

  function showRing(img, ms) {
    placeAtCorner(ring, img, "right");
    ring.style.setProperty("--dur", ms + "ms");
    ring.classList.remove("run");
    void ring.offsetWidth; // アニメーションを最初から
    ring.classList.add("run", "show");
  }
  function hideRing() {
    ring.classList.remove("run", "show");
  }

  function badge(img, text, kind) {
    if (!settings.showBadge) return;
    const b = document.createElement("div");
    b.className = "xsaver-badge xsaver-" + kind;
    b.textContent = text;
    placeAtCorner(b, img, "left");
    toastLayer.append(b);
    setTimeout(() => b.classList.add("out"), 1400);
    setTimeout(() => b.remove(), 1800);
    return b;
  }

  // ---- 画像情報の取り出し ----
  function infoFromImg(img) {
    const m = img.src.match(MEDIA_RE);
    if (!m) return null;
    const mediaId = m[1];
    // 形式は png / jpg のどちらかに限定（URLの値をそのまま使わない）
    const u = new URL(img.src);
    const raw = (u.searchParams.get("format") || m[2] || "jpg").toLowerCase();
    const fmt = raw === "png" ? "png" : "jpg";
    const origUrl = `https://pbs.twimg.com/media/${mediaId}?format=${fmt}&name=orig`;
    const classifyUrl = `https://pbs.twimg.com/media/${mediaId}?format=${fmt}&name=small`;

    // Xがセンシティブ指定してぼかしている画像か
    const photoBox = img.closest('[data-testid="tweetPhoto"]') || img.parentElement;
    let xSensitive = false;
    for (let el = img; el && el !== photoBox?.parentElement; el = el.parentElement) {
      if (/blur\(/.test(getComputedStyle(el).filter)) { xSensitive = true; break; }
    }
    if (!xSensitive && photoBox) {
      for (const el of photoBox.querySelectorAll("div")) {
        if (/blur\(/.test(getComputedStyle(el).filter)) { xSensitive = true; break; }
      }
    }

    // 投稿者・投稿ID・何枚目か
    let user = "", statusId = "", index = "";
    const parse = (href) => {
      const p = href && href.match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/photo\/(\d+))?/);
      if (p) { user = p[1]; statusId = p[2]; if (p[3]) index = p[3]; return true; }
      return false;
    };
    const photoLink = img.closest('a[href*="/photo/"]');
    if (!parse(photoLink?.getAttribute("href"))) {
      const inModal = img.closest('[aria-modal="true"]');
      const quote = img.closest('article div[role="link"]');
      if (inModal) {
        parse(location.pathname);
        index = ""; // モーダルでは隣の画像も描画されているので、URLの枚数は当てにしない
      } else if (quote) {
        // 引用ポスト内：外側のポストの情報は使わず、引用元のユーザー名だけ取る
        // 「@ユーザー名」だけが入った要素を探す（隣の時刻などと文字がくっつかないように）
        for (const el of quote.querySelectorAll("span, div")) {
          const h = el.textContent.trim().match(/^@([A-Za-z0-9_]{1,15})$/);
          if (h) { user = h[1]; break; }
        }
      } else {
        const art = img.closest("article");
        const t = art?.querySelector('a[href*="/status/"] time')?.closest("a");
        parse(t?.getAttribute("href"));
      }
    }
    return { mediaId, origUrl, classifyUrl, ext: fmt, user, statusId, index, xSensitive };
  }

  // ---- 保存 ----
  const sessionDone = new Map(); // mediaId -> label（このタブで保存済み）

  async function save(img, label = null) {
    const item = infoFromImg(img);
    if (!item) return;
    if (!label && settings.skipSaved && sessionDone.has(item.mediaId)) return;
    sessionDone.set(item.mediaId, "…");
    const waiting = badge(img, label ? "保存中…" : "判定中…", "wait");
    let res;
    try {
      res = await chrome.runtime.sendMessage(label ? { type: "label", item, label } : { type: "save", item });
    } catch (e) {
      res = { status: "error", error: "拡張機能が再読み込みされました。ページを更新してください" };
    }
    waiting?.remove();
    const text = (l) => XSAVER_LABEL_TEXT[l] || l;
    if (res?.status === "saved") {
      sessionDone.set(item.mediaId, res.label);
      badge(img, "保存 " + text(res.label), res.label.toLowerCase());
    } else if (res?.status === "relabeled") {
      sessionDone.set(item.mediaId, res.label);
      badge(img, text(res.label) + " に変更", res.label.toLowerCase());
    } else if (res?.status === "skipped") {
      sessionDone.set(item.mediaId, res.label);
      badge(img, "保存済み " + text(res.label), "skip");
    } else if (res?.status === "busy") {
      sessionDone.delete(item.mediaId); // 別タブで処理中。結果は向こうで出る
    } else {
      sessionDone.delete(item.mediaId);
      badge(img, "失敗", "error");
      console.warn("[X Image Saver]", res?.error);
    }
  }

  // ---- ホバー検出 ----
  let hovered = null;
  let timer = null;
  let mouse = { x: -1, y: -1 };
  let pending = false;

  function imgAtPoint(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.tagName === "IMG" && MEDIA_RE.test(el.src)) return el;
    }
    // X は透明な img の上に div を重ねているので、写真コンテナから探す
    for (const el of document.elementsFromPoint(x, y)) {
      const box = el.closest?.('[data-testid="tweetPhoto"]');
      const img = box?.querySelector("img");
      if (img && MEDIA_RE.test(img.src)) return img;
    }
    return null;
  }

  function update() {
    pending = false;
    const img = mouse.x < 0 ? null : imgAtPoint(mouse.x, mouse.y);
    if (img === hovered) return;
    hovered = img;
    clearTimeout(timer);
    hideRing();
    if (!img || settings.mode !== "hover") return;
    const id = img.src.match(MEDIA_RE)[1];
    if (settings.skipSaved && sessionDone.has(id)) return;
    const delay = Math.max(150, Number(settings.hoverDelay) || 800);
    showRing(img, delay);
    timer = setTimeout(() => {
      hideRing();
      // 待っている間に画像が消えた・カーソルが外れた場合は保存しない
      if (hovered === img && img.isConnected && imgAtPoint(mouse.x, mouse.y) === img) save(img);
      else hovered = null;
    }, delay);
  }
  function schedule() {
    if (!pending) { pending = true; requestAnimationFrame(update); }
  }

  document.addEventListener("mousemove", (e) => { mouse = { x: e.clientX, y: e.clientY }; schedule(); }, { passive: true });
  document.addEventListener("scroll", schedule, { passive: true, capture: true });
  document.addEventListener("mouseleave", () => { mouse = { x: -1, y: -1 }; schedule(); });
  window.addEventListener("blur", () => { clearTimeout(timer); hideRing(); hovered = null; });

  // ホバー中のキー操作（どのモードでも有効）
  //   保存キー(S)       : すぐ保存（自動判定）
  //   SFWキー(1)/NSFWキー(2): そのフォルダに保存。保存済みなら判定を直す（直した結果は学習に使う）
  document.addEventListener("keydown", (e) => {
    if (!hovered || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    const is = (name, def) => k === String(settings[name] || def).toLowerCase();
    const label = is("sfwKey", "1") ? "SFW" : is("nsfwKey", "2") ? "NSFW" : null;
    if (!label && !is("saveKey", "s")) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer);
    hideRing();
    const id = hovered.src.match(MEDIA_RE)[1];
    sessionDone.delete(id); // キー操作は明示的なので、このタブ内の重複スキップは無視
    save(hovered, label);
  }, true);
})();
