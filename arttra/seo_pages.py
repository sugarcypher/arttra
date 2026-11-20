#!/usr/bin/env python3
"""Static, crawlable pages for the gallery.

The gallery on the home page is drawn by JavaScript from data/artworks.json,
so its raw HTML names no artwork and a search engine sees one page. This
writes, from the same published list:

    art/<id>.html    one page per visible piece (title, image, description)
    art/index.html   every piece, linked — the crawl path from the home page
    sitemap.xml      the fixed pages plus every piece, with its image

The build calls write_site_pages() on each run; to regenerate by hand:
    arttra/.venv/bin/python -I arttra/seo_pages.py

Rules this file keeps:
  * Input is the published list only (what artworks.json holds): hidden
    pieces and print/source paths never reach it.
  * A page's URL is the 8-character file hash at the end of the piece's id.
    Not the title and not the style prefix — both can change, and GitHub
    Pages cannot redirect an old address.
  * Output depends only on the artwork data (no build dates), so a build
    with nothing new rewrites every file byte-for-byte and commits nothing.
  * art/ belongs to this generator: pages for pieces that are no longer
    visible are deleted.
"""
import html
import json
from pathlib import Path

SITE = "https://arttra.art"
ARTIST = "Briar Morgan Greenway"
ARTIST_ID = f"{SITE}/#artist"
WEB_MAX = 1600       # long edge of the web image (WEB_MAX_DIMENSION in the build)
THUMB_W = 400        # THUMB_WIDTH in the build
FONTS = ("https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,400"
         "&family=Manrope:wght@300;500&display=swap")

# Hand-written pages, as (path, changefreq, priority). "" is the home page.
STATIC_PAGES = [
    ("", "daily", "1.0"),
    ("art/", "daily", "0.9"),
    ("interactive.html", "monthly", "0.7"),
    ("residual-warmth.html", "monthly", "0.5"),
    ("ink-blooms.html", "monthly", "0.5"),
    ("umwelt.html", "monthly", "0.5"),
    ("philosophy/residual-warmth.html", "yearly", "0.4"),
    ("philosophy/the-accumulation-principle.html", "yearly", "0.4"),
    ("philosophy/umwelt.html", "yearly", "0.4"),
    # video-gallery.html is left out: it loads a stylesheet that doesn't exist
    # and nothing links to it. Add it back once the page is repaired.
]

HEAD = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>{title}</title>
  <meta name="description" content="{desc}" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; base-uri 'self'; form-action 'none'; object-src 'none'" />
  <meta name="referrer" content="strict-origin-when-cross-origin" />
  <meta name="theme-color" content="#0c0b09" />
  <meta name="color-scheme" content="dark" />
  <link rel="canonical" href="{url}" />
  <link rel="icon" type="image/svg+xml" href="../assets/images/favicon.svg" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="ARTTRA.ART" />
  <meta property="og:title" content="{og_title}" />
  <meta property="og:description" content="{desc}" />
  <meta property="og:url" content="{url}" />
  <meta property="og:image" content="{og_image}" />
  <meta property="og:image:width" content="{og_w}" />
  <meta property="og:image:height" content="{og_h}" />
  <meta property="og:image:alt" content="{og_alt}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{og_title}" />
  <meta name="twitter:description" content="{desc}" />
  <meta name="twitter:image" content="{og_image}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="../shared/works.css" />
  <link rel="stylesheet" href="../shared/art.css" />
  <link rel="stylesheet" href="{fonts}" />
  <script type="application/ld+json">{jsonld}</script>
  <script src="../shared/frame-guard.js"></script>
  <script src="../shared/art.js" defer></script>
</head>
<body class="w-page">
  <header class="w-top">
    <div class="w-top__in">
      <a class="w-brand" href="../">ARTTRA</a>
      <nav class="w-nav" aria-label="Site"><a href="../#shop">Gallery</a><a href="./"{works_current}>All works</a><a class="w-hide-s" href="../interactive.html">Interactive</a><a class="w-hide-s" href="../#contact">Contact</a></nav>
    </div>
  </header>
"""

FOOT = """  <footer class="w-foot">
    <div><div class="w-foot__t">ARTTRA.ART</div>Original and algorithmic art by <a href="../#artist">Briar Morgan Greenway</a>.</div>
    <div><div class="w-foot__t">Prints</div>Made to order as fine-art prints, canvas, framed and metal, and shipped worldwide.</div>
    <div><div class="w-foot__t">Contact</div><a href="mailto:help@arttra.art">help@arttra.art</a></div>
  </footer>
</body>
</html>
"""

PIECE = """  <main class="a-piece">
    <a class="w-back" href="./">&larr; All works</a>
    <div class="a-piece__grid">
      <figure class="a-piece__fig">
        <img src="{img}" width="{w}" height="{h}" alt="{alt}" decoding="async" draggable="false" />
      </figure>
      <div class="a-piece__text">
        <p class="w-kicker">{kicker}</p>
        <h1 class="a-piece__title">{title}</h1>
        <p class="a-piece__by">by <a href="../#artist">Briar Morgan Greenway</a></p>
        <p class="a-piece__desc">{desc}</p>
        <dl class="a-facts">
{facts}        </dl>
        <div class="a-piece__cta">
          <a class="w-btn w-btn--gold" href="../#art={hash_id}">See it on a wall &middot; sizes and prices</a>
        </div>
      </div>
    </div>
    <nav class="a-pager" aria-label="More works">
      {prev}
      {next}
    </nav>
  </main>
"""

INDEX = """  <main class="a-index">
    <p class="w-kicker">The collection</p>
    <h1 class="w-h1">All works</h1>
    <p class="w-lead">{lead}</p>
    <ul class="a-grid">
{items}    </ul>
  </main>
"""


def page_slug(art):
    """The stable part of the id: an 8-hex hash of the source file name."""
    return art["id"].rsplit("-", 1)[-1].lower()


def _e(text):
    return html.escape(str(text or ""), quote=True)


def _jsonld(data):
    # "</" would end the <script> element early; "<\/" is the same JSON string.
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def _abs(rel):
    """./assets/x.webp -> https://arttra.art/assets/x.webp (path URL-encoded)."""
    from urllib.parse import quote
    return f"{SITE}/{quote(str(rel).lstrip('./'))}"


def _rel(rel):
    """./assets/x.webp -> ../assets/x.webp, for a page inside art/."""
    from urllib.parse import quote
    return "../" + quote(str(rel).lstrip("./"))


def _dims(art, long_edge=None, width=None):
    pd = art.get("printDimensions") or {}
    pw, ph = int(pd.get("pixelWidth") or 0), int(pd.get("pixelHeight") or 0)
    if pw <= 0 or ph <= 0:
        return 0, 0
    if width:
        return width, int(ph * (width / pw))
    if max(pw, ph) > long_edge:
        r = long_edge / max(pw, ph)
        return int(pw * r), int(ph * r)
    return pw, ph


def _orientation(art):
    w, h = _dims(art, long_edge=WEB_MAX)
    if not w:
        return ""
    if abs(w - h) / max(w, h) < 0.04:
        return "Square"
    return "Wide" if w > h else "Tall"


def _alt(art):
    return art.get("description") or art.get("title") or ""


def _meta_desc(art):
    d = f"“{art['title']}” by {ARTIST}. {art.get('description') or ''}".strip()
    return d if len(d) <= 300 else d[:297].rsplit(" ", 1)[0] + "…"


def _piece_page(art, prev_art, next_art):
    slug = page_slug(art)
    url = f"{SITE}/art/{slug}.html"
    w, h = _dims(art, long_edge=WEB_MAX)
    jpg = str(art["image"]).rsplit(".", 1)[0] + ".jpg"   # scrapers read JPEG more reliably than WebP
    title = art["title"]
    # Only facts the build is sure of. No medium, no colour names (the palette
    # classifier's names are approximate) and no per-piece material list (which
    # sizes and materials a piece can take depends on its resolution).
    facts = []
    if _orientation(art):
        facts.append(("Format", _orientation(art)))
    if art.get("style"):
        facts.append(("Style", art["style"]))
    facts.append(("Catalogue no.", art["id"]))
    facts.append(("Prints", "Made to order, shipped worldwide"))
    data = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "VisualArtwork",
                "@id": url + "#artwork",
                "name": title,
                "url": url,
                "image": _abs(jpg),
                "description": art.get("description") or "",
                "identifier": art["id"],
                "creator": {"@type": "Person", "@id": ARTIST_ID, "name": ARTIST, "url": ARTIST_ID},
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "ARTTRA.ART", "item": SITE + "/"},
                    {"@type": "ListItem", "position": 2, "name": "All works", "item": SITE + "/art/"},
                    {"@type": "ListItem", "position": 3, "name": title, "item": url},
                ],
            },
        ],
    }

    def pager(other, cls, label):
        if not other:
            return f'<span class="a-pager__l {cls}"></span>'
        return (f'<a class="a-pager__l {cls}" href="{page_slug(other)}.html">'
                f'<span class="a-pager__k">{label}</span><span class="a-pager__t">{_e(other["title"])}</span></a>')

    head = HEAD.format(
        title=_e(f"{title} — {ARTIST} | ARTTRA.ART"), desc=_e(_meta_desc(art)), url=url,
        og_title=_e(f"{title} — {ARTIST}"), og_image=_abs(jpg), og_w=w, og_h=h, og_alt=_e(_alt(art)),
        fonts=FONTS, jsonld=_jsonld(data), works_current="")
    body = PIECE.format(
        img=_rel(art["image"]), w=w, h=h, alt=_e(_alt(art)),
        kicker="Original art", title=_e(title),
        desc=_e(art.get("description") or ""),
        facts="".join(f"          <div><dt>{_e(k)}</dt><dd>{_e(v)}</dd></div>\n" for k, v in facts),
        hash_id=_e(art["id"]),
        prev=pager(prev_art, "a-pager__l--prev", "&larr; Previous"),
        next=pager(next_art, "a-pager__l--next", "Next &rarr;"))
    return head + body + FOOT


def _index_page(artworks):
    url = f"{SITE}/art/"
    n = len(artworks)
    lead = (f"Every piece in the collection by {ARTIST} — {n} works, newest first. "
            "Open one to read about it, then hang it on a wall at its real printed size.")
    items = []
    for art in artworks:
        tw, th = _dims(art, width=THUMB_W)
        items.append(
            f'      <li><a href="{page_slug(art)}.html"><img src="{_rel(art["thumb"])}" width="{tw}" height="{th}" '
            f'alt="{_e(_alt(art))}" loading="lazy" decoding="async" draggable="false" />'
            f'<span class="a-grid__t">{_e(art["title"])}</span></a></li>\n')
    first = artworks[0] if artworks else None
    og = _abs(str(first["image"]).rsplit(".", 1)[0] + ".jpg") if first else f"{SITE}/assets/images/about-dancer.jpg"
    ow, oh = _dims(first, long_edge=WEB_MAX) if first else (1074, 1600)
    data = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "@id": url + "#collection",
        "url": url,
        "name": f"All works by {ARTIST}",
        "isPartOf": {"@id": SITE + "/#site"},
        "about": {"@id": ARTIST_ID},
        "mainEntity": {
            "@type": "ItemList",
            "numberOfItems": n,
            "itemListElement": [
                {"@type": "ListItem", "position": i + 1, "name": a["title"],
                 "url": f"{SITE}/art/{page_slug(a)}.html"}
                for i, a in enumerate(artworks)
            ],
        },
    }
    head = HEAD.format(
        title=_e(f"All works — {ARTIST} | ARTTRA.ART"), desc=_e(lead), url=url,
        og_title=_e(f"All works — {ARTIST}"), og_image=og, og_w=ow, og_h=oh,
        og_alt=_e(_alt(first) if first else ""), fonts=FONTS, jsonld=_jsonld(data),
        works_current=' aria-current="page"')
    return head + INDEX.format(lead=_e(lead), items="".join(items)) + FOOT


def _sitemap(artworks):
    newest = max((str(a.get("timestamp") or "")[:10] for a in artworks), default="")
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
           'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">']
    for path, freq, prio in STATIC_PAGES:
        lastmod = f"<lastmod>{newest}</lastmod>" if newest and path in ("", "art/") else ""
        out.append(f"  <url><loc>{SITE}/{path}</loc>{lastmod}<changefreq>{freq}</changefreq><priority>{prio}</priority></url>")
    for art in artworks:
        stamp = str(art.get("timestamp") or "")[:10]
        lastmod = f"<lastmod>{stamp}</lastmod>" if stamp else ""
        jpg = str(art["image"]).rsplit(".", 1)[0] + ".jpg"
        out.append(
            f"  <url><loc>{SITE}/art/{page_slug(art)}.html</loc>{lastmod}<priority>0.6</priority>"
            f"<image:image><image:loc>{html.escape(_abs(jpg))}</image:loc></image:image></url>")
    out.append("</urlset>")
    return "\n".join(out) + "\n"


def write_site_pages(artworks, root):
    """Write art/*.html, art/index.html and sitemap.xml under `root` from the
    published artwork list. Returns the number of artwork pages written."""
    root = Path(root)
    art_dir = root / "art"
    art_dir.mkdir(exist_ok=True)
    slugs = [page_slug(a) for a in artworks]
    if len(set(slugs)) != len(slugs):
        raise ValueError("two visible artworks share a page id")
    # Prune first: if rendering fails part-way, a removed or hidden piece's
    # page must already be gone.
    wanted = {"index.html"} | {f"{s}.html" for s in slugs}
    for old in art_dir.glob("*.html"):
        if old.name not in wanted:
            old.unlink()
    for i, art in enumerate(artworks):
        prev_art = artworks[i - 1] if i > 0 else None
        next_art = artworks[i + 1] if i + 1 < len(artworks) else None
        (art_dir / f"{slugs[i]}.html").write_text(_piece_page(art, prev_art, next_art), encoding="utf-8")
    (art_dir / "index.html").write_text(_index_page(artworks), encoding="utf-8")
    (root / "sitemap.xml").write_text(_sitemap(artworks), encoding="utf-8")
    return len(artworks)


if __name__ == "__main__":
    repo = Path(__file__).resolve().parent.parent
    published = json.loads((repo / "data" / "artworks.json").read_text())
    print(f"[seo] wrote {write_site_pages(published, repo)} artwork pages, art/index.html and sitemap.xml")
