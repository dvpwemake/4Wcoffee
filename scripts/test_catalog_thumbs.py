#!/usr/bin/env python3
"""Assert every catalog product has an 800px WebP+JPEG thumb under size caps."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "generate_catalog_thumbs", ROOT / "scripts" / "generate-catalog-thumbs.py"
)
_gen = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_gen)
catalog_images = _gen.catalog_images
thumb_paths = _gen.thumb_paths

MAX_WEBP = 150_000
MAX_TOTAL_WEBP = 3_000_000


def main() -> int:
    errors: list[str] = []
    catalog = (ROOT / "catalog.data.js").read_text(encoding="utf-8")
    images = catalog_images(catalog)
    if len(images) < 80:
        errors.append(f"expected 80+ catalog images, got {len(images)}")
    total = 0
    missing = 0
    for rel in images:
        webp, jpg = thumb_paths(rel)
        if not webp.is_file() or not jpg.is_file():
            errors.append(f"missing thumbs for {rel}")
            missing += 1
            continue
        size = webp.stat().st_size
        total += size
        if size > MAX_WEBP:
            errors.append(f"{webp.name} webp {size} exceeds {MAX_WEBP}")
        if jpg.stat().st_size < 1000:
            errors.append(f"{jpg.name} jpeg too small")
    if total > MAX_TOTAL_WEBP:
        errors.append(f"total webp {total} exceeds {MAX_TOTAL_WEBP}")

    js = (ROOT / "catalog.js").read_text(encoding="utf-8")
    for needle in (
        "image/catalog-thumbs/",
        "<picture>",
        'type="image/webp"',
        'fetchpriority="high"',
        "EAGER_COUNT",
        "productImageMarkup",
    ):
        if needle not in js:
            errors.append(f"catalog.js missing {needle!r}")
    if 'src="' + " + CatalogView.escape(product.image)" in js.replace("\n", ""):
        errors.append("catalog.js still paints original product.image as img src")

    html = (ROOT / "coffee.html").read_text(encoding="utf-8")
    if "image/catalog-thumbs/coffeecol-01-cold-brew-whiskey-aged.webp" not in html:
        errors.append("coffee.html missing LCP webp preload")
    if "catalog.js?v=20260918a" not in html:
        errors.append("coffee.html missing catalog.js cache bust")
    if 'rel="stylesheet" href="site.css?v=20260918a"' not in html:
        errors.append("coffee.html missing site.css cache bust")

    print(
        f"images={len(images)} thumbs_ok={len(images) - missing} "
        f"webp_total={total} errors={len(errors)}"
    )
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
