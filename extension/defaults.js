// 設定の初期値（background / content / options で共有）
const XSAVER_DEFAULTS = {
  mode: "hover",          // "hover" = マウスを止めると自動保存 / "key" = ホバー中にキーで保存
  hoverDelay: 800,        // 自動保存までの静止時間(ms)
  saveKey: "s",           // ホバー中に押すと即保存するキー
  sfwKey: "1",            // ホバー中に押すと「SFWとして保存／SFWに直す」
  nsfwKey: "2",           // ホバー中に押すと「NSFWとして保存／NSFWに直す」
  baseFolder: "X_Saver",  // ダウンロードフォルダ内の保存先
  sfwFolder: "SFW",
  nsfwFolder: "NSFW",
  reviewFolder: "要確認",
  perUserFolder: false,   // フォルダ内をさらにユーザー名で分ける
  threshold: 0.5,         // NSFW判定のしきい値
  useReview: true,        // 判定が微妙な画像は「要確認」に入れる
  reviewBand: 0.2,        // しきい値±この幅を「微妙」とみなす
  countSexy: true,        // 「Sexy（きわどい）」もNSFWに含める
  learn: true,            // 直した結果から自分の基準を覚える
  skipSaved: true,        // 保存済みの画像は再保存しない
  showBadge: true         // 保存結果を画像上に表示
};

const XSAVER_LABEL_TEXT = { SFW: "SFW", NSFW: "NSFW", Review: "要確認", Unsorted: "未判定" };
