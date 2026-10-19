// 設定の初期値（background / content / options で共有）
const XSAVER_DEFAULTS = {
  mode: "hover",          // "hover" = マウスを止めると自動保存 / "key" = ホバー中にキーで保存
  hoverDelay: 800,        // 自動保存までの静止時間(ms)
  saveKey: "s",           // ホバー中に押すと即保存するキー
  baseFolder: "X_Saver",  // ダウンロードフォルダ内の保存先
  sfwFolder: "SFW",
  nsfwFolder: "NSFW",
  perUserFolder: false,   // フォルダ内をさらにユーザー名で分ける
  threshold: 0.5,         // NSFW判定のしきい値
  countSexy: true,        // 「Sexy（きわどい）」もNSFWに含める
  skipSaved: true,        // 保存済みの画像は再保存しない
  showBadge: true         // 保存結果を画像上に表示
};
