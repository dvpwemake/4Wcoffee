#!/usr/bin/env python3
"""Resize catalog product shots to 800px WebP + JPEG thumbs for coffee.html."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "catalog.data.js"
OUT_DIR = ROOT / "image" / "catalog-thumbs"
MAX_EDGE = 800
WEBP_QUALITY = 80
JPEG_QUALITY = 82
CANVAS = (17, 17, 17)  # matches .card__shot background #111


def catalog_images(text: str) -> list[str]:
    return re.findall(r'"image":\s*"([^"]+)"', text)


def stem_of(image_path: str) -> str:
    return Path(image_path).stem


def thumb_paths(image_path: str, out_dir: Path = OUT_DIR) -> tuple[Path, Path]:
    stem = stem_of(image_path)
    return out_dir / f"{stem}.webp", out_dir / f"{stem}.jpg"


def prepare(im: Image.Image) -> Image.Image:
    im = ImageOps.exif_transpose(im) or im
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGB", rgba.size, CANVAS)
        bg.paste(rgba, mask=rgba.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    w, h = im.size
    longest = max(w, h)
    if longest > MAX_EDGE:
        scale = MAX_EDGE / longest
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
    return im


def encode(src: Path, webp: Path, jpg: Path) -> dict:
    with Image.open(src) as im:
        out = prepare(im)
    webp.parent.mkdir(parents=True, exist_ok=True)
    out.save(webp, "WEBP", quality=WEBP_QUALITY, method=6)
    out.save(jpg, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return {
        "src": str(src.relative_to(ROOT)),
        "src_bytes": src.stat().st_size,
        "webp_bytes": webp.stat().st_size,
        "jpg_bytes": jpg.stat().st_size,
        "size": list(out.size),
    }


def generate(root: Path = ROOT) -> dict:
    catalog = root / "catalog.data.js"
    out_dir = root / "image" / "catalog-thumbs"
    images = catalog_images(catalog.read_text(encoding="utf-8"))
    rows = []
    missing = []
    for rel in images:
        src = root / rel
        if not src.is_file():
            missing.append(rel)
            continue
        webp, jpg = thumb_paths(rel, out_dir)
        rows.append(encode(src, webp, jpg))
    summary = {
        "count": len(rows),
        "missing": missing,
        "src_bytes": sum(r["src_bytes"] for r in rows),
        "webp_bytes": sum(r["webp_bytes"] for r in rows),
        "jpg_bytes": sum(r["jpg_bytes"] for r in rows),
        "out_dir": str(out_dir.relative_to(root)),
    }
    (out_dir / "manifest.json").write_text(json.dumps({"summary": summary, "files": rows}, indent=2) + "\n")
    return summary


def main() -> int:
    summary = generate()
    print(json.dumps(summary, indent=2))
    if summary["missing"]:
        print("missing originals:", summary["missing"], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
