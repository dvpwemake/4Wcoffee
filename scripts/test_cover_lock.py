"""Admin cover and hero links stay after a later scan."""
import json
import tempfile
from pathlib import Path

import importlib.util

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("crawl_signals", ROOT / "scripts" / "crawl-signals.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_new_google_url_keeps_admin_cover():
    prev = [{
        "title": "Arabica crosses three dollars",
        "sourceUrl": "https://news.google.com/rss/articles/OLDTOKEN",
        "image": "https://example.com/admin.jpg",
    }]
    overrides = {"https://news.google.com/rss/articles/OLDTOKEN": "https://example.com/admin.jpg"}
    locked = mod.index_locked_covers(prev, overrides)
    item = {
        "title": "Arabica crosses three dollars",
        "sourceUrl": "https://news.google.com/rss/articles/NEWTOKEN",
        "image": "https://example.com/original.jpg",
    }
    assert mod.locked_cover(item, locked) == "https://example.com/admin.jpg"
    mod.enrich_image(item, locked)
    assert item["image"] == "https://example.com/admin.jpg"
    assert item["imageLocked"] is True


def test_unrelated_story_is_not_locked():
    locked = mod.index_locked_covers(
        [{"title": "Arabica crosses three dollars", "sourceUrl": "https://news.google.com/rss/articles/OLD", "image": "https://example.com/admin.jpg"}],
        {"https://news.google.com/rss/articles/OLD": "https://example.com/admin.jpg"},
    )
    other = {"title": "A different roaster opens", "sourceUrl": "https://example.com/other", "image": "https://example.com/original.jpg"}
    assert mod.locked_cover(other, locked) == ""
    assert other["image"] == "https://example.com/original.jpg"


def test_published_hero_survives_same_day_draft():
    tmp = Path(tempfile.mkdtemp())
    (tmp / "data").mkdir()
    (tmp / "editorial.data.js").write_text(
        "window.EDITORIAL = "
        + json.dumps({
            "publishDate": "2026-10-21",
            "heroImage": "https://example.com/admin-hero.jpg",
            "heroCredit": "Admin",
            "heroSource": "Shop",
            "heroSourceUrl": "https://example.com/story",
        })
        + ";\n"
    )
    old = mod.ROOT
    mod.ROOT = tmp
    try:
        same_day = mod.keep_admin_hero({
            "publishDate": "2026-10-21",
            "heroImage": "https://example.com/original.jpg",
            "heroCredit": "Scan",
            "heroSource": "Scan",
            "heroSourceUrl": "https://news.google.com/old",
        })
        assert same_day["heroImage"] == "https://example.com/admin-hero.jpg"
        assert same_day["heroLocked"] is True
        next_day = mod.keep_admin_hero({
            "publishDate": "2026-10-22",
            "heroImage": "https://example.com/original.jpg",
            "heroCredit": "Scan",
            "heroSource": "Scan",
            "heroSourceUrl": "https://news.google.com/new",
        })
        assert next_day["heroImage"] == "https://example.com/original.jpg"
        assert next_day.get("heroLocked") is not True
    finally:
        mod.ROOT = old


if __name__ == "__main__":
    test_new_google_url_keeps_admin_cover()
    test_unrelated_story_is_not_locked()
    test_published_hero_survives_same_day_draft()
    print("cover lock tests passed")
