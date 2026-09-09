#!/usr/bin/env python3
"""Crawl coffee RSS sources; pick 2 most recent items per category."""
from __future__ import annotations

import json
import re
import ssl
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SRC = json.loads((ROOT / "data" / "sources.json").read_text())
CTX = ssl.create_default_context()
UA = "FourthWaveCoffee/1.0 (+https://fourthwavecoffee.org/)"


def fetch(url: str, timeout: int = 18) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as res:
        return res.read().decode("utf-8", "replace")


def strip_html(s: str) -> str:
    s = unescape(re.sub(r"(?is)<script.*?>.*?</script>", " ", s or ""))
    s = re.sub(r"(?is)<style.*?>.*?</style>", " ", s)
    s = re.sub(r"(?is)<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def img_from(xml: str, desc: str) -> str:
    m = re.search(r'<media:content[^>]+url=["\']([^"\']+)', xml)
    if m:
        return m.group(1)
    m = re.search(r'<enclosure[^>]+url=["\']([^"\']+)', xml)
    if m:
        return m.group(1)
    m = re.search(r'<img[^>]+src=["\']([^"\']+)', desc or "", re.I)
    return m.group(1) if m else ""


OG_PATTERNS = [
    re.compile(r'<meta[^>]+property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image(?::secure_url)?["\']', re.I),
    re.compile(r'<meta[^>]+name=["\']twitter:image(?::src)?["\'][^>]+content=["\']([^"\']+)["\']', re.I),
]


def og_image(html: str) -> str:
    for pat in OG_PATTERNS:
        m = pat.search(html or "")
        if m:
            return unescape(m.group(1)).strip()
    return ""


def enrich_image(item: dict) -> dict:
    if item.get("image"):
        return item
    url = item.get("sourceUrl") or ""
    if not url.startswith("http"):
        return item
    try:
        html = fetch(url, timeout=12)
        img = og_image(html)
        if img:
            item["image"] = img
            print("  og:image", item.get("title", "")[:48])
    except Exception as e:
        print("  og fail", url, e)
    return item


def parse_date(raw: str) -> datetime:
    raw = (raw or "").strip()
    if not raw:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        pass
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return datetime.min.replace(tzinfo=timezone.utc)


def local(tag: str) -> str:
    return tag.split("}", 1)[-1].lower()


def text(el) -> str:
    if el is None:
        return ""
    return "".join(el.itertext()).strip()


def parse_feed(xml: str, source: str) -> list[dict]:
    items = []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return items
    nodes = list(root.iter())
    entries = [n for n in nodes if local(n.tag) in {"item", "entry"}]
    for node in entries:
        title = link = desc = date_raw = enc = ""
        for child in list(node):
            t = local(child.tag)
            if t == "title" and not title:
                title = text(child)
            elif t == "link":
                href = child.attrib.get("href") or text(child)
                if href and not link:
                    link = href
            elif t in {"description", "summary", "content"} and not desc:
                desc = text(child)
            elif t in {"pubdate", "published", "updated", "date"} and not date_raw:
                date_raw = text(child)
            elif t in {"encoded"} and not desc:
                desc = text(child)
        raw = ET.tostring(node, encoding="unicode")
        image = img_from(raw, desc)
        title = strip_html(title)
        summary = strip_html(desc)[:280]
        if not title or not link:
            continue
        if not link.startswith("http"):
            continue
        items.append(
            {
                "title": title,
                "source": source,
                "sourceUrl": link.split("?")[0],
                "summary": summary,
                "image": image,
                "publishedAt": parse_date(date_raw).isoformat(),
                "_ts": parse_date(date_raw).timestamp(),
            }
        )
    return items


def load_deleted(path: Path) -> list:
    if not path.exists():
        return []
    try:
        prev = json.loads(path.read_text())
        return prev.get("deleted") or []
    except Exception:
        return []


def host_of(url: str) -> str:
    from urllib.parse import urlparse
    try:
        return (urlparse(url).hostname or "").lower().replace("www.", "", 1)
    except Exception:
        return ""


def is_blacklisted(item: dict, blacklist: list) -> bool:
    host = host_of(item.get("sourceUrl") or "")
    blocked = {(h or "").lower().replace("www.", "", 1) for h in (blacklist or []) if h}
    return bool(host and host in blocked)


def is_blocked(item: dict, deleted: list) -> bool:
    url = str(item.get("sourceUrl") or "").split("?")[0].rstrip("/").lower()
    title = str(item.get("title") or "").lower()[:80]
    for d in deleted:
        du = str((d or {}).get("url") or (d or {}).get("sourceUrl") or "").split("?")[0].rstrip("/").lower()
        dt = str((d or {}).get("title") or "").lower()[:80]
        if url and du and url == du:
            return True
        if title and dt and title == dt:
            return True
    return False


def url_key(url: str) -> str:
    return str(url or "").split("?")[0].rstrip("/").lower()


def known_archive_urls() -> set[str]:
    path = ROOT / "data" / "archive.json"
    out: set[str] = set()
    if not path.exists():
        return out
    try:
        prev = json.loads(path.read_text())
    except Exception:
        return out
    for batch in prev.get("batches") or []:
        for it in batch.get("items") or []:
            k = url_key(it.get("sourceUrl") or "")
            if k:
                out.add(k)
    return out


def paged_url(url: str, page: int) -> str:
    if page <= 1:
        return url
    low = url.lower()
    if "paged=" in low or "/page/" in low:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}paged={page}"


def fetch_feed_pages(url: str, name: str, pages: int = 3) -> list[dict]:
    """Page 1 is the live feed. Extra pages pull unused older items from the same source."""
    out: list[dict] = []
    seen: set[str] = set()
    for page in range(1, max(1, pages) + 1):
        u = paged_url(url, page)
        try:
            got = parse_feed(fetch(u), name)
        except Exception:
            if page == 1:
                raise
            break
        added = 0
        for it in got:
            k = url_key(it.get("sourceUrl") or "")
            if not k or k in seen:
                continue
            seen.add(k)
            out.append(it)
            added += 1
        if page == 1:
            print(f"OK {name:24} {len(got):3}  {url}")
        elif added:
            print(f"OK {name:24} +{added:<2} older p{page}")
        if not got or (page > 1 and added == 0):
            break
    return out


def crawl(deleted: list | None = None) -> dict:
    deleted = deleted or []
    blacklist = SRC.get("blacklist") or []
    known = known_archive_urls()
    extra_pages = int(SRC.get("olderPages", 3) or 3)
    picked = {}
    log = []
    for cat_id, cat in SRC["categories"].items():
        pool = []
        for feed in cat["feeds"]:
            url = feed["url"]
            name = feed["name"]
            if host_of(url) and host_of(url) in {
                (h or "").lower().replace("www.", "", 1) for h in blacklist if h
            }:
                log.append({"ok": False, "source": name, "error": "blacklist", "url": url})
                print(f"SKIP {name:22} blacklist  {url}")
                continue
            try:
                got = fetch_feed_pages(url, name, extra_pages)
                pool.extend(got)
                log.append({"ok": True, "source": name, "n": len(got), "url": url})
            except Exception as e:
                log.append({"ok": False, "source": name, "error": str(e)[:160], "url": url})
                print(f"FAIL {name:22} {e}")
        pool.sort(key=lambda x: x["_ts"], reverse=True)
        seen = set()
        unused = []
        skip = ("shipping update", "check your email", "sponsored")
        pick_n = SRC.get("pickCount", 2)
        for it in pool:
            key = it["title"].lower()[:80]
            if key in seen:
                continue
            if any(s in key for s in skip):
                continue
            if is_blocked(it, deleted):
                continue
            if is_blacklisted(it, blacklist):
                continue
            if url_key(it.get("sourceUrl") or "") in known:
                continue
            seen.add(key)
            item = {k: v for k, v in it.items() if k != "_ts"}
            item["category"] = cat_id
            item["categoryLabel"] = cat["label"]
            unused.append(item)
            if len(unused) >= pick_n:
                break
        top = []
        for item in unused:
            if len(top) >= pick_n:
                break
            item["id"] = f"{cat_id}-{len(top)+1}"
            top.append(enrich_image(item))
        picked[cat_id] = top
    batch = {
        "scannedAt": datetime.now(timezone.utc).isoformat(),
        "categories": {k: v["label"] for k, v in SRC["categories"].items()},
        "items": [it for cat in SRC["categories"] for it in picked.get(cat, [])],
        "byCategory": picked,
        "deleted": deleted,
        "log": log,
    }
    return batch


def pacific_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:
        return datetime.now(timezone.utc)


def already_scanned_today(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        prev = json.loads(path.read_text())
        raw = prev.get("scannedAt") or ""
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        today = pacific_now().date()
        dt = dt.astimezone(timezone.utc)
        try:
            from zoneinfo import ZoneInfo
            dt = dt.astimezone(ZoneInfo("America/Los_Angeles"))
        except Exception:
            pass
        return dt.date() == today
    except Exception:
        return False


def build_editorial_draft(batch: dict) -> dict:
    """Desk packet for admin review. Not live. Public site still uses editorial.data.js."""
    day = pacific_now()
    items = batch.get("items") or []
    first = items[0] if items else {}
    second = items[1] if len(items) > 1 else {}
    title = str(first.get("title") or "Daily beat").strip()
    if len(title) > 72:
        title = title[:69].rstrip() + "…"
    dek_bits = []
    if first.get("source"):
        dek_bits.append(str(first["source"]))
    if second.get("title"):
        hook = str(second["title"]).strip()
        dek_bits.append(hook[:70] + ("…" if len(hook) > 70 else ""))
    dek = ". ".join(dek_bits) if dek_bits else "Morning coffee signals for the desk."
    weekday = day.strftime("%A, %B ") + str(day.day) + day.strftime(", %Y")
    paras = [
        "DRAFT — not live. Rewrite before Publish. On "
        + weekday
        + ", the desk holds these beats.",
    ]
    for it in items:
        summary = str(it.get("summary") or "").strip()
        if len(summary) > 280:
            summary = summary[:277].rstrip() + "…"
        cat = it.get("categoryLabel") or it.get("category") or ""
        line = f"{cat}: {it.get('title')} ({it.get('source')}). {summary}".strip()
        paras.append(line)
    paras.append("Edit title, dek, and body. Then Publish to Latest Beat.")
    body = "\n\n".join(paras)
    return {
        "id": "ed_" + day.strftime("%Y-%m-%d"),
        "publishDate": day.strftime("%Y-%m-%d"),
        "status": "draft",
        "title": title,
        "dek": dek,
        "heroImage": first.get("image") or "",
        "heroCredit": first.get("source") or "",
        "heroSource": first.get("source") or "",
        "heroSourceUrl": first.get("sourceUrl") or "",
        "authorName": "Dr. Wallace Lynch",
        "authorTitle": "Editor in Chief",
        "paragraphs": paras,
        "body": body,
        "wordCount": len(body.split()),
        "fromScan": batch.get("scannedAt"),
    }


ARCHIVE_MAX = 45


def merge_archive(batch: dict) -> None:
    """Append today's live batch to data/archive.json. Scan never writes editorial.data.js."""
    path = ROOT / "data" / "archive.json"
    prev = {"batches": []}
    if path.exists():
        try:
            prev = json.loads(path.read_text())
        except Exception:
            prev = {"batches": []}
    slim = []
    for it in batch.get("items") or []:
        slim.append(
            {
                "id": it.get("id"),
                "title": it.get("title"),
                "source": it.get("source"),
                "sourceUrl": it.get("sourceUrl"),
                "summary": it.get("summary"),
                "image": it.get("image") or "",
                "publishedAt": it.get("publishedAt"),
                "category": it.get("category"),
                "categoryLabel": it.get("categoryLabel"),
            }
        )
    scanned = batch.get("scannedAt") or ""
    batch_id = "auto_" + scanned.replace(":", "-")[:19]
    entry = {"batchId": batch_id, "scannedAt": scanned, "items": slim}
    batches = [b for b in (prev.get("batches") or []) if b.get("batchId") != batch_id]
    batches.insert(0, entry)
    path.write_text(
        json.dumps({"batches": batches[:ARCHIVE_MAX]}, indent=2, ensure_ascii=False) + "\n"
    )


def write_editorial_draft(draft: dict) -> None:
    path = ROOT / "data" / "editorial-draft.json"
    path.write_text(json.dumps(draft, indent=2, ensure_ascii=False) + "\n")
    js = (
        "window.EDITORIAL_DRAFT = "
        + json.dumps(draft, ensure_ascii=False)
        + ";\n"
    )
    (ROOT / "editorial.draft.js").write_text(js)


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--once-a-day", action="store_true", help="Skip if already scanned today in Pacific time")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    out_json = ROOT / "data" / "signals.json"
    if args.once_a_day and not args.force and already_scanned_today(out_json):
        print("already scanned today (America/Los_Angeles); skip")
        return
    batch = crawl(load_deleted(out_json))
    (ROOT / "data").mkdir(exist_ok=True)
    out_json.write_text(json.dumps(batch, indent=2, ensure_ascii=False) + "\n")
    js = "window.SIGNALS = " + json.dumps(batch, ensure_ascii=False) + ";\n"
    (ROOT / "signals.data.js").write_text(js)
    merge_archive(batch)
    draft = build_editorial_draft(batch)
    write_editorial_draft(draft)
    print("wrote", len(batch["items"]), "items; draft", draft["id"])


if __name__ == "__main__":
    main()
