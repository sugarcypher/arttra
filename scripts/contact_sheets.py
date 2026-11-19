#!/usr/bin/env python3
"""Contact sheets of gallery thumbnails, for titling pieces by eye.

The build can only invent a title from colour statistics; a fitting title needs
someone to look at the piece. This lays the published thumbnails out in numbered
grids and writes an index (number -> artwork id) so titles can be written back
into data/overrides.json, where a "title" always wins over the generated one.

    arttra/.venv/bin/python -I scripts/contact_sheets.py --out <dir>             # pieces with no hand title
    arttra/.venv/bin/python -I scripts/contact_sheets.py --out <dir> --all       # every visible piece

Reads data/artworks.json, data/overrides.json and the thumbs; writes only to --out.
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
COLS, ROWS = 4, 2
CELL_W, CELL_H, LABEL_H, GAP = 380, 500, 34, 10


def _font(size):
    for path in ("/System/Library/Fonts/Helvetica.ttc",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True, help="directory for the sheets and index.json")
    ap.add_argument("--all", action="store_true", help="include pieces that already have a hand title")
    args = ap.parse_args()

    artworks = json.loads((REPO / "data" / "artworks.json").read_text())
    overrides = json.loads((REPO / "data" / "overrides.json").read_text())
    if not args.all:
        artworks = [a for a in artworks if not (overrides.get(a["id"]) or {}).get("titled")]

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    font = _font(24)
    per = COLS * ROWS
    index = []
    for start in range(0, len(artworks), per):
        chunk = artworks[start:start + per]
        sheet = Image.new("RGB", (COLS * (CELL_W + GAP) + GAP, ROWS * (CELL_H + LABEL_H + GAP) + GAP), (24, 24, 24))
        draw = ImageDraw.Draw(sheet)
        for i, art in enumerate(chunk):
            n = start + i + 1
            x = GAP + (i % COLS) * (CELL_W + GAP)
            y = GAP + (i // COLS) * (CELL_H + LABEL_H + GAP)
            thumb = REPO / art["thumb"].lstrip("./")
            try:
                with Image.open(thumb) as im:
                    im = im.convert("RGB")
                    im.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
                    sheet.paste(im, (x + (CELL_W - im.width) // 2, y + (CELL_H - im.height) // 2))
            except OSError as e:
                draw.text((x + 8, y + 8), f"missing: {e}", font=font, fill=(255, 90, 90))
            draw.text((x + 4, y + CELL_H + 4), f"#{n}", font=font, fill=(255, 255, 255))
            index.append({"n": n, "id": art["id"], "title": art.get("title", ""), "sourceFile": art.get("sourceFile", "")})
        name = f"sheet_{start // per + 1:02d}.jpg"
        sheet.save(out / name, quality=88)
    (out / "index.json").write_text(json.dumps(index, indent=1))
    print(f"{len(artworks)} piece(s) -> {-(-len(artworks) // per)} sheet(s) in {out}")


if __name__ == "__main__":
    main()
