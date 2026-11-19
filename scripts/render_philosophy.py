#!/usr/bin/env python3
"""Render the philosophy texts (*.md at the repo root) as styled HTML pages in
philosophy/<name>.html, in the gallery's design (shared/works.css).

The .md files stay the source of truth: edit them, then re-run
    arttra/.venv/bin/python -I scripts/render_philosophy.py
(needs the `markdown` package: pip install markdown) and commit both.
"""
import html
import re
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "philosophy"

# source .md -> (page title, the interactive work it belongs to)
PAGES = {
    "residual-warmth.md": ("Residual Warmth", [("Open Residual Warmth", "../residual-warmth.html")]),
    "the-accumulation-principle.md": ("The Accumulation Principle", [("Open Ink Blooms", "../ink-blooms.html"), ("Open Residual Warmth", "../residual-warmth.html")]),
    "umwelt.md": ("Umwelt", [("Open Umwelt", "../umwelt.html")]),
}

FONTS = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,400&family=Manrope:wght@300;500&display=swap"

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>{title} — Philosophy — ARTTRA.ART</title>
  <meta name="description" content="{desc}" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; base-uri 'self'; form-action 'none'; object-src 'none'" />
  <meta name="referrer" content="strict-origin-when-cross-origin" />
  <meta name="theme-color" content="#0c0b09" />
  <meta name="color-scheme" content="dark" />
  <link rel="canonical" href="https://arttra.art/philosophy/{slug}.html" />
  <link rel="icon" type="image/svg+xml" href="../assets/images/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="../shared/works.css" />
  <link rel="stylesheet" href="{fonts}" />
  <script src="../shared/frame-guard.js"></script>
</head>
<body class="w-page">
  <header class="w-top">
    <div class="w-top__in">
      <a class="w-brand" href="../">ARTTRA</a>
      <nav class="w-nav" aria-label="Site"><a href="../#shop">Gallery</a><a href="../interactive.html">Interactive</a><a class="w-hide-s" href="../#commissions">Commissions</a><a href="../#contact">Contact</a></nav>
    </div>
  </header>
  <main class="w-doc">
    <a class="w-back w-doc__back" href="../interactive.html">&larr; Interactive works</a>
    <p class="w-kicker">Philosophy</p>
{body}
    <div class="w-doc__cta">{ctas}<a class="w-btn" href="../interactive.html">All interactive works</a><a class="w-btn" href="../#shop">Back to the gallery</a></div>
  </main>
  <footer class="w-foot">
    <div><div class="w-foot__t">ARTTRA.ART</div>Original and algorithmic art by Briar Morgan Greenway.</div>
    <div><div class="w-foot__t">Interactive</div>Generative works written in p5.js; any state can be made into a print.</div>
    <div><div class="w-foot__t">Contact</div><a href="mailto:help@arttra.art">help@arttra.art</a></div>
  </footer>
</body>
</html>
"""


def first_paragraph(md_text: str) -> str:
    for block in md_text.split("\n\n"):
        b = block.strip()
        if b and not b.startswith("#"):
            plain = re.sub(r"[*_`]", "", b)
            return (plain[:155].rsplit(" ", 1)[0] + "…") if len(plain) > 158 else plain
    return ""


def main():
    OUT.mkdir(exist_ok=True)
    for src, (title, links) in PAGES.items():
        text = (ROOT / src).read_text(encoding="utf-8")
        body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"], output_format="html5")
        # Wide tables scroll inside their own box on phones.
        body = body.replace("<table>", '<div class="w-table"><table>').replace("</table>", "</table></div>")
        body = "\n".join("    " + line if line else line for line in body.splitlines())
        slug = Path(src).stem
        ctas = "".join(f'<a class="w-btn w-btn--gold" href="{href}">{html.escape(label)}</a>' for label, href in links[:1])
        ctas += "".join(f'<a class="w-btn" href="{href}">{html.escape(label)}</a>' for label, href in links[1:])
        page = TEMPLATE.format(title=html.escape(title), desc=html.escape(first_paragraph(text), quote=True),
                               slug=slug, fonts=FONTS, body=body, ctas=ctas)
        (OUT / f"{slug}.html").write_text(page, encoding="utf-8")
        print(f"wrote philosophy/{slug}.html")


if __name__ == "__main__":
    main()
