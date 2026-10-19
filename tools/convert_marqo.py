"""Marqo/nsfw-image-detection-384 (timm) を ONNX に変換して拡張機能に組み込む。

使い方:
  python3 tools/convert_marqo.py            # Hugging Face から本物の重みを取得して変換
  python3 tools/convert_marqo.py --dummy    # 同じ構造・ランダム重み（動作確認用。判定には使えない）

出力: extension/models/marqo/model.onnx と model.json（前処理とラベルの設定）
"""
import argparse, json, os, sys
import numpy as np
import torch, timm
import onnxruntime as ort

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "extension", "models", "marqo")
HUB_ID = "hf-hub:Marqo/nsfw-image-detection-384"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dummy", action="store_true")
    a = ap.parse_args()

    if a.dummy:
        model = timm.create_model("vit_tiny_patch16_384", pretrained=False, num_classes=2)
        torch.manual_seed(0)
        labels = ["NSFW", "SFW"]
    else:
        model = timm.create_model(HUB_ID, pretrained=True)
        labels = model.pretrained_cfg.get("label_names") or getattr(model, "label_names", None)
        if not labels:
            from huggingface_hub import hf_hub_download
            labels = json.load(open(hf_hub_download(HUB_ID.split(":", 1)[1], "config.json"))).get("label_names")
        if not labels:
            sys.exit("ラベル名がモデル設定にありません。pretrained_cfg を確認してください: %r" % model.pretrained_cfg)
    model.eval()

    cfg = timm.data.resolve_data_config({}, model=model)
    size = cfg["input_size"][1:]
    meta = {
        "name": "Marqo/nsfw-image-detection-384" + (" (DUMMY random weights)" if a.dummy else ""),
        "dummy": a.dummy,
        "input": [1, 3, size[0], size[1]],
        "mean": list(cfg["mean"]),
        "std": list(cfg["std"]),
        "interpolation": cfg.get("interpolation", "bicubic"),
        "crop_pct": cfg.get("crop_pct", 1.0),
        "labels": list(labels),
        "nsfw_label": next((l for l in labels if l.lower() in ("nsfw", "porn", "unsafe")), labels[0]),
    }

    os.makedirs(OUT, exist_ok=True)
    x = torch.rand(1, 3, *size)
    path = os.path.join(OUT, "model.onnx")
    torch.onnx.export(model, x, path, input_names=["pixel_values"], output_names=["logits"],
                      opset_version=17, dynamo=False)
    with open(os.path.join(OUT, "model.json"), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    # 変換の同等性チェック（PyTorch と ONNX Runtime の出力が一致するか）
    sess = ort.InferenceSession(path)
    for _ in range(3):
        x = torch.rand(1, 3, *size)
        with torch.no_grad():
            ref = model(x).numpy()
        got = sess.run(None, {"pixel_values": x.numpy()})[0]
        diff = float(np.abs(ref - got).max())
        assert diff < 1e-3, f"ONNX出力がずれています: {diff}"
    # テスト用の基準値：timm 本来の前処理でテスト画像を判定した結果を保存しておき、
    # 拡張機能（JavaScript の前処理 + ONNX Runtime Web）の結果と比べる
    from PIL import Image
    tf_eval = timm.data.create_transform(**cfg)
    nsfw_i = meta["labels"].index(meta["nsfw_label"])
    ref = {}
    fx = os.path.join(ROOT, "tests", "fixtures")
    for name in ("land.jpg", "shapes.png"):
        img = Image.open(os.path.join(fx, name)).convert("RGB")
        with torch.no_grad():
            prob = torch.softmax(model(tf_eval(img).unsqueeze(0)), dim=1)[0, nsfw_i].item()
        ref[name] = prob
    with open(os.path.join(fx, "marqo_reference.json"), "w") as f:
        json.dump({"dummy": a.dummy, "nsfw": ref}, f, indent=2)
    print("reference:", ref)

    print(json.dumps(meta, ensure_ascii=False))
    print(f"OK  {path}  {os.path.getsize(path)/1e6:.1f} MB  (max diff {diff:.2e})")


if __name__ == "__main__":
    main()
