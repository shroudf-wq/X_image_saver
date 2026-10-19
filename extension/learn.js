// 判定の組み合わせと「直した結果から覚える」仕組み（background と テストで共有）
// 個人モデル = 各モデルの出力を入力にしたロジスティック回帰。直した／確認した画像だけで学習する。

const XSAVER_FEATURES = ["Hentai", "Porn", "Sexy", "Drawing", "Neutral", "Marqo", "X_sensitive"];

function xsaverClamp(p) { return Math.min(1 - 1e-4, Math.max(1e-4, Number(p) || 0)); }
function xsaverLogit(p) { p = xsaverClamp(p); return Math.log(p / (1 - p)); }
function xsaverSigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// 判定結果 → 特徴量（確率は logit に変換しておくと線形モデルで扱いやすい）
function xsaverFeatures(cls, xSensitive) {
  const n = cls?.nsfwjs || {};
  const m = cls?.marqo && !cls.marqo.dummy ? cls.marqo.nsfw : 0.5;
  return [n.Hentai, n.Porn, n.Sexy, n.Drawing, n.Neutral, m].map(xsaverLogit).concat([xSensitive ? 1 : 0]);
}

// 学習前の標準の判定（NSFWJS と Marqo を logit 平均。Marqo のほうを重めに見る）
function xsaverBaseProb(cls, settings) {
  const n = cls?.nsfwjs || {};
  let p1 = (n.Porn || 0) + (n.Hentai || 0) + (settings.countSexy ? n.Sexy || 0 : 0);
  const hasMarqo = cls?.marqo && !cls.marqo.dummy;
  if (!hasMarqo) return xsaverClamp(p1);
  return xsaverSigmoid(0.4 * xsaverLogit(p1) + 0.6 * xsaverLogit(cls.marqo.nsfw));
}

// ---- ロジスティック回帰 ----
function xsaverTrain(X, y, opt = {}) {
  const l2 = opt.l2 ?? 0.05, iters = opt.iters ?? 600, lr = opt.lr ?? 0.3;
  const d = X[0].length, n = X.length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of X) r.forEach((v, j) => (mu[j] += v / n));
  for (const r of X) r.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / n));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  // クラスの偏りを補正する重み
  const pos = y.filter((v) => v === 1).length, neg = n - pos;
  const cw = (t) => (t === 1 ? n / (2 * Math.max(pos, 1)) : n / (2 * Math.max(neg, 1)));
  let w = new Array(d).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const e = (xsaverSigmoid(z) - y[i]) * cw(y[i]);
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b, mu, sd };
}

function xsaverPredict(model, f) {
  let z = model.b;
  for (let j = 0; j < f.length; j++) z += model.w[j] * ((f[j] - model.mu[j]) / model.sd[j]);
  return xsaverSigmoid(z);
}

// k分割交差検証で「個人モデル」と「標準の判定」の正解率を比べる
function xsaverEvaluate(examples, settings, k = 5) {
  const n = examples.length;
  const order = examples.map((_, i) => i).sort((a, b) => ((a * 7919) % n) - ((b * 7919) % n));
  let okPersonal = 0, okBase = 0;
  for (let fold = 0; fold < k; fold++) {
    const test = order.filter((_, i) => i % k === fold);
    const train = order.filter((_, i) => i % k !== fold);
    const ys = train.map((i) => examples[i].y);
    if (!ys.includes(0) || !ys.includes(1)) return null;
    const m = xsaverTrain(train.map((i) => examples[i].f), ys);
    for (const i of test) {
      const ex = examples[i];
      if ((xsaverPredict(m, ex.f) >= 0.5 ? 1 : 0) === ex.y) okPersonal++;
      if ((ex.xs || xsaverBaseProb(ex.cls, settings) >= settings.threshold ? 1 : 0) === ex.y) okBase++;
    }
  }
  return { personal: okPersonal / n, base: okBase / n, n };
}

// 確認済みの画像から個人モデルを作る。標準の判定より良いときだけ有効にする
function xsaverBuildPersonal(examples, settings) {
  const pos = examples.filter((e) => e.y === 1).length, neg = examples.length - pos;
  const info = { n: examples.length, pos, neg, enabled: false, reason: "" };
  if (examples.length < 30 || pos < 5 || neg < 5) {
    info.reason = "学習には確認済みの画像が30枚以上（SFW・NSFWそれぞれ5枚以上）必要です";
    return info;
  }
  const ev = xsaverEvaluate(examples, settings);
  if (!ev) { info.reason = "評価できませんでした"; return info; }
  info.cv = ev;
  if (ev.personal + 1e-9 < ev.base) {
    info.reason = "今のところ標準の判定のほうが正確なので、学習結果は使っていません";
    return info;
  }
  info.model = xsaverTrain(examples.map((e) => e.f), examples.map((e) => e.y));
  info.enabled = true;
  return info;
}

if (typeof module !== "undefined") {
  module.exports = { XSAVER_FEATURES, xsaverFeatures, xsaverBaseProb, xsaverTrain, xsaverPredict, xsaverEvaluate, xsaverBuildPersonal, xsaverLogit, xsaverSigmoid };
}
