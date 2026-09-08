#!/usr/bin/env python3
"""Generate static editorial permalinks e/YYYY-MM-DD.html + e/index.html + sitemap."""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
SITE = "https://fourthwavecoffee.org"
CSS_V = "20260908b"
FALLBACK_HERO = f"{SITE}/image/carosal/cafe-scene-6887.jpg"


def esc(s: str) -> str:
    return (
        str(s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def plain(s: str) -> str:
    t = re.sub(r"<[^>]+>", " ", str(s or ""))
    return re.sub(r"\s+", " ", t).strip()


def display_date(iso: str) -> str:
    raw = str(iso or "")[:10]
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})$", raw)
    if not m:
        return raw
    months = (
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    )
    return f"{months[int(m.group(2)) - 1]} {int(m.group(3))}, {m.group(1)}"


def brand_head(pfx: str) -> str:
    return (
        f'  <link rel="icon" href="{pfx}image/favicon.svg" type="image/svg+xml">\n'
        f'  <link rel="icon" href="{pfx}favicon.ico" sizes="any">\n'
        f'  <link rel="apple-touch-icon" href="{pfx}image/apple-touch-icon.png">\n'
        '  <meta name="theme-color" content="#181818">\n'
        '  <meta name="color-scheme" content="dark">\n'
        '  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">\n'
        f'  <link rel="alternate" type="text/plain" href="{SITE}/llms.txt" title="LLM summary">\n'
        f'  <link rel="manifest" href="{pfx}site.webmanifest">\n'
    )


def load_pack() -> dict:
    text = (ROOT / "editorial.data.js").read_text(encoding="utf-8")
    m = re.search(r"window\.EDITORIAL = (\{.*?\});", text, re.S)
    published = json.loads(m.group(1)) if m else {}
    hm = re.search(r"window\.EDITORIAL_HISTORY = (\[.*?\]);", text, re.S)
    history = json.loads(hm.group(1)) if hm else []
    return {"published": published, "history": history}


def paras(ed: dict) -> list[str]:
    if ed.get("paragraphs"):
        return [plain(p) for p in ed["paragraphs"] if plain(p)]
    return [plain(p) for p in str(ed.get("body") or "").split("\n\n") if plain(p)]


def collect(pack: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}

    def put(ed: dict) -> None:
        if not ed:
            return
        d = str(ed.get("publishDate") or "")[:10]
        if not re.match(r"\d{4}-\d{2}-\d{2}$", d):
            return
        if not paras(ed):
            return
        prev = out.get(d)
        if not prev or len(paras(ed)) >= len(paras(prev)):
            out[d] = ed

    put(pack.get("published") or {})
    for ed in pack.get("history") or []:
        put(ed)
    return out


SHARE_ICONS = {
    "x": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z"/></svg>',
    "li": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
    "fb": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M24 12.073C24 5.446 18.627.073 12 .073S0 5.446 0 12.073c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
    "rd": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.042l2.906.617a1.214 1.214 0 011.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 000-.463.33.33 0 00-.463 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 00-.204-.094z"/></svg>',
    "em": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>',
    "copy": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
}


def page_html(ed: dict, date: str) -> str:
    title = plain(ed.get("title") or "Daily editorial")
    dek = plain(ed.get("dek") or "")
    author = plain(ed.get("authorName") or "Dr. Wallace Lynch")
    role = plain(ed.get("authorTitle") or "Editor in Chief")
    body = paras(ed)
    wc = ed.get("wordCount") or len(" ".join(body).split())
    hero = plain(ed.get("heroImage") or "")
    credit = plain(ed.get("heroCredit") or ed.get("heroSource") or "")
    url = f"{SITE}/e/{date}.html"
    og = hero or f"{SITE}/image/carosal/cafe-scene-6887.jpg"
    desc = dek or (body[0] if body else "Fourth Wave Coffee daily editorial")
    prose = "\n".join(f"<p>{esc(p)}</p>" for p in body)
    share_t = f"{title} — Fourth Wave Coffee"
    su = quote(url, safe="")
    st = quote(share_t, safe="")
    sb = quote(share_t + "\n\n" + url, safe="")
    hero_block = (
        f'<div class="ed-hero"><img src="{esc(hero)}" alt="" width="1280" height="720" fetchpriority="high" decoding="async" referrerpolicy="no-referrer"></div>'
        if hero
        else ""
    )
    credit_block = f'<p class="ed-credit">Photo: {esc(credit)}</p>' if credit else ""
    ld = json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "NewsArticle",
            "headline": title,
            "description": desc,
            "datePublished": date,
            "author": {"@type": "Person", "name": author, "jobTitle": role},
            "publisher": {
                "@type": "NewsMediaOrganization",
                "name": "Fourth Wave Coffee",
                "url": SITE + "/",
                "logo": {
                    "@type": "ImageObject",
                    "url": SITE + "/image/icon-512.png",
                },
            },
            "mainEntityOfPage": {"@type": "WebPage", "@id": url},
            "image": [hero] if hero else None,
            "isAccessibleForFree": True,
            "inLanguage": "en-US",
            "wordCount": wc,
        },
        ensure_ascii=False,
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{esc(title)} | Fourth Wave Coffee</title>
  <meta name="description" content="{esc(desc)}">
  <meta name="author" content="{esc(author)}">
  <link rel="canonical" href="{esc(url)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Fourth Wave Coffee">
  <meta property="og:url" content="{esc(url)}">
  <meta property="og:title" content="{esc(title)}">
  <meta property="og:description" content="{esc(desc)}">
  <meta property="og:image" content="{esc(og)}">
  <meta property="article:published_time" content="{esc(date)}">
  <meta property="article:author" content="{esc(author)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{esc(title)}">
  <meta name="twitter:description" content="{esc(desc)}">
  <meta name="twitter:image" content="{esc(og)}">
  <script type="application/ld+json">{ld}</script>
  <meta property="og:image:alt" content="{esc(title)}">
  <meta name="twitter:image:alt" content="{esc(title)}">
  <meta property="og:locale" content="en_US">
{brand_head('../')}  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../site.css?v={CSS_V}">
</head>
<body>
  <div data-nav></div>
  <main class="wrap ed-permalink">
    <div class="ed-kicker">Daily editorial · {esc(display_date(date))}</div>
    <article class="ed-card">
      {hero_block}
      {credit_block}
      <div class="ed-body">
        <h2>{esc(title)}</h2>
        {f'<p class="ed-dek">{esc(dek)}</p>' if dek else ''}
        <div class="ed-byline-row">
          <p class="ed-byline">By {esc(author)}<span class="ed-role"> {esc(role)}</span></p>
          <p class="ed-meta"><time datetime="{esc(date)}" itemprop="datePublished">{esc(display_date(date))}</time></p>
        </div>
        <div class="ed-prose">
{prose}
        </div>
        <div class="ed-share-wrap">
          <span class="ed-share-label">Share</span>
          <div class="ed-share" role="group" aria-label="Share this editorial">
            <a class="ed-share-btn ed-share-x" href="https://twitter.com/intent/tweet?url={su}&amp;text={st}" target="_blank" rel="noopener noreferrer" aria-label="Share on X">{SHARE_ICONS['x']}</a>
            <a class="ed-share-btn ed-share-li" href="https://www.linkedin.com/sharing/share-offsite/?url={su}" target="_blank" rel="noopener noreferrer" aria-label="Share on LinkedIn">{SHARE_ICONS['li']}</a>
            <a class="ed-share-btn ed-share-fb" href="https://www.facebook.com/sharer/sharer.php?u={su}" target="_blank" rel="noopener noreferrer" aria-label="Share on Facebook">{SHARE_ICONS['fb']}</a>
            <a class="ed-share-btn ed-share-rd" href="https://www.reddit.com/submit?url={su}&amp;title={st}" target="_blank" rel="noopener noreferrer" aria-label="Share on Reddit">{SHARE_ICONS['rd']}</a>
            <a class="ed-share-btn ed-share-em" href="mailto:?subject={st}&amp;body={sb}" aria-label="Share by email">{SHARE_ICONS['em']}</a>
            <button type="button" class="ed-share-btn ed-share-link" data-copy-share="{esc(url)}" aria-label="Copy link">{SHARE_ICONS['copy']}</button>
          </div>
        </div>
        <p class="ed-footer-links">
          <a href="../latestbeat.html#editorial">← Today’s desk</a>
          <a href="../latestbeat.html">Latest Beat</a>
          <a href="./">All editorials</a>
        </p>
      </div>
    </article>
  </main>
  <footer data-footer></footer>
  <script src="../site.js?v={CSS_V}"></script>
</body>
</html>
"""


def index_html(by_date: dict[str, dict]) -> str:
    rows = []
    items_ld = []
    for i, d in enumerate(sorted(by_date.keys(), reverse=True), 1):
        ed = by_date[d]
        title = plain(ed.get("title") or "Editorial")
        dek = plain(ed.get("dek") or "")
        hero = plain(ed.get("heroImage") or "") or FALLBACK_HERO
        rows.append(
            f'<a class="ed-archive-card" href="{d}.html">'
            f'<div class="n-img"><img src="{esc(hero)}" alt="" width="640" height="400" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>'
            f'<div class="ed-archive-body"><time datetime="{d}">{esc(display_date(d))}</time>'
            f"<strong>{esc(title)}</strong>"
            + (f"<span>{esc(dek)}</span>" if dek else "")
            + "</div></a>"
        )
        items_ld.append(
            {
                "@type": "ListItem",
                "position": i,
                "url": f"{SITE}/e/{d}.html",
                "name": title,
            }
        )
    ld = json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": "Editorials",
            "url": f"{SITE}/e/",
            "isPartOf": {"@type": "WebSite", "name": "Fourth Wave Coffee", "url": SITE + "/"},
            "mainEntity": {"@type": "ItemList", "itemListElement": items_ld},
        },
        ensure_ascii=False,
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Editorials | Fourth Wave Coffee</title>
  <meta name="description" content="Archive of Fourth Wave Coffee daily editorials.">
  <link rel="canonical" href="{SITE}/e/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Fourth Wave Coffee">
  <meta property="og:url" content="{SITE}/e/">
  <meta property="og:title" content="Editorials | Fourth Wave Coffee">
  <meta property="og:description" content="Archive of Fourth Wave Coffee daily editorials.">
  <meta property="og:image" content="{FALLBACK_HERO}">
  <meta name="twitter:card" content="summary_large_image">
{brand_head('../')}  <script type="application/ld+json">{ld}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../site.css?v={CSS_V}">
</head>
<body>
  <div data-nav></div>
  <header class="page-hero wrap">
    <h1>Editorials.</h1>
    <p>Daily desk archive. Newest first.</p>
  </header>
  <main class="wrap">
    <div class="ed-archive-list">
      {''.join(rows)}
    </div>
  </main>
  <footer data-footer></footer>
  <script src="../site.js?v={CSS_V}"></script>
</body>
</html>
"""


def patch_sitemap(dates: list[str]) -> None:
    path = ROOT / "sitemap.xml"
    text = path.read_text(encoding="utf-8") if path.exists() else '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n'
    for loc in [f"{SITE}/e/"] + [f"{SITE}/e/{d}.html" for d in dates]:
        if loc in text:
            continue
        last = dates[0] if dates else "2026-09-08"
        block = (
            f"  <url>\n    <loc>{loc}</loc>\n    <lastmod>{last}</lastmod>\n"
            f"    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>\n"
        )
        text = text.replace("</urlset>", block + "</urlset>")
    if f"{SITE}/latestbeat.html" in text:
        text = re.sub(
            r"(<loc>https://fourthwavecoffee.org/latestbeat.html</loc>\s*<lastmod>)[^<]+",
            r"\g<1>2026-09-08",
            text,
        )
    path.write_text(text, encoding="utf-8")


def main() -> None:
    pack = load_pack()
    by_date = collect(pack)
    out = ROOT / "e"
    out.mkdir(exist_ok=True)
    for d, ed in by_date.items():
        (out / f"{d}.html").write_text(page_html(ed, d), encoding="utf-8")
        print("wrote e/" + d + ".html")
    (out / "index.html").write_text(index_html(by_date), encoding="utf-8")
    print("wrote e/index.html")
    patch_sitemap(sorted(by_date.keys(), reverse=True))
    print("patched sitemap.xml")


if __name__ == "__main__":
    main()
