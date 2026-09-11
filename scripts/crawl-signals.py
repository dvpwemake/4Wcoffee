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


# Do not use ads? — that matches the letters "ad" inside "uploads".
AD_OR_CHROME_RE = re.compile(
    r"adserver|adservice|/ads/|advert|banner|sponsor|doubleclick|googlesyndication|"
    r"adnxs|taboola|outbrain|criteo|1x1|spacer|sprite|favicon|"
    r"logo[-_/]|[-_/]logo|icon[-_/]|[-_/]icon|avatar|emoji|sharethis|addthis|"
    r"badge|widget|promo|newsletter|popup|cookie|consent|facebook\.com/tr|"
    r"analytics|scorecard|blank\.gif|spacer\.gif|pixel\.gif|data:image/gif",
    re.I,
)


def is_ad_or_chrome(url: str, extra: str = "") -> bool:
    blob = f"{url} {extra}".lower()
    if AD_OR_CHROME_RE.search(blob):
        return True
    if re.search(r"[?&](w|width|h|height)=(1|[1-9]|[1-9][0-9]|1[0-1][0-9])(?:\D|$)", blob):
        return True
    return False


def abs_url(src: str, base: str) -> str:
    src = unescape((src or "").strip())
    if not src or src.startswith("data:"):
        return ""
    if src.startswith("//"):
        return "https:" + src
    if src.startswith("http"):
        return src
    if not base:
        return ""
    try:
        from urllib.parse import urljoin
        return urljoin(base, src)
    except Exception:
        return ""


def img_from(xml: str, desc: str) -> str:
    for pat in (
        r'<media:content[^>]+url=["\']([^"\']+)',
        r'<enclosure[^>]+url=["\']([^"\']+)',
        r'<img[^>]+src=["\']([^"\']+)',
    ):
        for m in re.finditer(pat, xml + " " + (desc or ""), re.I):
            url = unescape(m.group(1).strip())
            if url and not is_ad_or_chrome(url, m.group(0)):
                return url
    return ""


OG_PATTERNS = [
    re.compile(r'<meta[^>]+property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image(?::secure_url)?["\']', re.I),
    re.compile(r'<meta[^>]+name=["\']twitter:image(?::src)?["\'][^>]+content=["\']([^"\']+)["\']', re.I),
]


def og_image(html: str) -> str:
    for pat in OG_PATTERNS:
        m = pat.search(html or "")
        if m:
            url = unescape(m.group(1)).strip()
            if url and not is_ad_or_chrome(url):
                return url
    return ""


def content_images(html: str, page_url: str) -> list[str]:
    """Article-body images only. Skip ads, logos, banners, pixels."""
    body = html or ""
    body = re.sub(r"(?is)<script.*?>.*?</script>", " ", body)
    body = re.sub(r"(?is)<style.*?>.*?</style>", " ", body)
    body = re.sub(r"(?is)<(header|nav|footer|aside|form)[^>]*>.*?</\1>", " ", body)
    chunks = []
    for pat in (
        r"(?is)<article\b[^>]*>.*?</article>",
        r"(?is)<main\b[^>]*>.*?</main>",
        r'(?is)<div[^>]+class=["\'][^"\']*(?:entry-content|post-content|article-body|post-body|td-post-content|entry__content)[^"\']*["\'][^>]*>.*?</div>',
    ):
        chunks.extend(re.findall(pat, body))
    hay = "\n".join(chunks) if chunks else body
    out = []
    seen = set()
    for m in re.finditer(
        r'<img\b([^>]*)>',
        hay,
        re.I,
    ):
        tag = m.group(0)
        src = ""
        sm = re.search(r'(?:src|data-src|data-lazy-src)=["\']([^"\']+)["\']', tag, re.I)
        if sm:
            src = abs_url(sm.group(1), page_url)
        if (not src or src.startswith("data:")) and "srcset" in tag.lower():
            ss = re.search(r'srcset=["\']([^"\']+)["\']', tag, re.I)
            if ss:
                first = ss.group(1).split(",")[0].strip().split()[0]
                src = abs_url(first, page_url)
        if not src or is_ad_or_chrome(src, tag):
            continue
        cls = (re.search(r'class=["\']([^"\']+)', tag, re.I) or [None, ""])[1]
        alt = (re.search(r'alt=["\']([^"\']*)', tag, re.I) or [None, ""])[1]
        if is_ad_or_chrome(cls + " " + alt):
            continue
        key = src.split("?")[0].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(src)
    return out


def pick_cover(html: str, page_url: str, rss_img: str = "") -> str:
    if rss_img and not is_ad_or_chrome(rss_img):
        return rss_img
    og = og_image(html)
    if og:
        return og
    body = content_images(html, page_url)
    return body[0] if body else ""


def is_site_stock(url: str) -> bool:
    u = (url or "").lower()
    return "image/carosal" in u or "fourthwavecoffee.org/image/" in u or "encrypted-tbn" in u


def enrich_image(item: dict) -> dict:
    url = item.get("sourceUrl") or ""
    rss = item.get("image") or ""
    if rss and (is_site_stock(rss) or is_ad_or_chrome(rss)):
        rss = ""
        item["image"] = ""
    if rss and not is_ad_or_chrome(rss) and not is_site_stock(rss):
        return item
    if not url.startswith("http"):
        if rss and is_ad_or_chrome(rss):
            item["image"] = ""
        return item
    try:
        html = fetch(url, timeout=12)
        img = pick_cover(html, url, rss)
        if img:
            item["image"] = img
            print("  cover", (item.get("title") or "")[:48])
        elif rss and is_ad_or_chrome(rss):
            item["image"] = ""
            print("  cover skip-ad", (item.get("title") or "")[:48])
        else:
            print("  cover none", (item.get("title") or "")[:48])
    except Exception as e:
        print("  cover fail", url, e)
        if rss and is_ad_or_chrome(rss):
            item["image"] = ""
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
        "items": [
            dict(it, rank=i)
            for i, it in enumerate(
                (it for cat in SRC["categories"] for it in picked.get(cat, [])),
                start=1,
            )
        ],
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


CAT_LABEL = {
    "industry": "Industry",
    "science": "Science",
    "reviews": "Reviews",
    "origin": "Origin",
    "editorial": "Editorial",
}


def key_points(summary: str, max_points: int = 4) -> list[str]:
    text = strip_html(summary or "")
    if not text:
        return []
    skip = re.compile(r"subscribe|sign up|click here|read more|the post .+ appeared first", re.I)
    parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if len(s.strip()) > 25]
    out = [p for p in parts if not skip.search(p)][:max_points]
    if out:
        return out
    if skip.search(text) and len(text) < 120:
        return []
    return [text[:160] + ("…" if len(text) > 160 else "")]


def build_editorial_draft(batch: dict) -> dict:
    """CoC-shaped outline brief. Not live. Scan never writes editorial.data.js."""
    day = pacific_now()
    date_str = day.strftime("%Y-%m-%d")
    items = batch.get("items") or []
    headlines = []
    lines = [
        "EDITORIAL BRIEF (outline only — not for publication as-is)",
        "Publish date: " + date_str,
        "Instruction: Use the titles and key points below to write the final ~300-word Fourth Wave editorial. Replace this entire brief with your finished prose before publishing.",
        "",
        "— Selected articles of the day (" + str(len(items)) + ") —",
        "",
    ]
    if not items:
        lines.append("(No articles available. Run Scan feeds first, then re-run Editorial Draft.)")
        lines.append("")
    for i, it in enumerate(items, 1):
        cat = CAT_LABEL.get(it.get("category") or "", it.get("categoryLabel") or "General")
        title = str(it.get("title") or "").strip()
        source = str(it.get("source") or "").strip()
        url = str(it.get("sourceUrl") or "").strip()
        summary = str(it.get("summary") or "")
        kps = key_points(summary)
        headlines.append(
            {
                "title": title,
                "source": source,
                "category": it.get("category") or "",
                "sourceUrl": url,
                "summary": strip_html(summary)[:280],
                "image": it.get("image") or "",
                "keyPoints": kps,
            }
        )
        lines.append(f"{i}. [{cat}] {title}")
        if source:
            lines.append("   Source: " + source)
        if url:
            lines.append("   URL: " + url)
        lines.append("   Key points:")
        if kps:
            for kp in kps:
                lines.append("   • " + kp)
        else:
            lines.append("   • (No summary on file — open URL and note 2–3 facts before writing.)")
        lines.append("")
    cats = []
    for h in headlines:
        lb = CAT_LABEL.get(h["category"], h["category"] or "General")
        if lb not in cats:
            cats.append(lb)
    if cats:
        lines.append("— Categories present —")
        lines.append(" · ".join(cats))
        lines.append("")
    lines.append("— Admin checklist —")
    lines.append("• Draft original title + dek (vary form: not always What… / Convergence of…)")
    lines.append("• Write body (~280–320 words) in Fourth Wave voice")
    lines.append("• Select hero from selected-article head image thumbnails (or paste URL)")
    lines.append("• Mark published when ready")
    body = "\n".join(lines)
    paras = [p.strip() for p in re.split(r"\n\n+", body) if p.strip()]
    first_img = next((h for h in headlines if h.get("image")), {})
    return {
        "id": "ed_" + date_str,
        "publishDate": date_str,
        "status": "draft",
        "draftKind": "outline",
        "formId": "outline_brief",
        "themeId": "outline",
        "title": "Editorial brief — " + date_str,
        "dek": "Outline of selected article titles and key points for admin to write the final editorial.",
        "heroImage": first_img.get("image") or "",
        "heroCredit": first_img.get("source") or "",
        "heroSource": first_img.get("source") or "",
        "heroSourceUrl": first_img.get("sourceUrl") or "",
        "authorName": "Dr. Wallace Lynch",
        "authorTitle": "Editor in Chief",
        "paragraphs": paras,
        "body": body,
        "wordCount": len(body.split()),
        "headlines": headlines,
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
