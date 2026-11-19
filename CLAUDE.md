# arttra.art

## Use Python, not bash

This Mac's Claude Code settings deny `bash` and `sh` (and `cp`/`mv`/`tee`,
`python -c`). Don't try to run shell scripts. Use the Python equivalents:

- **Publish dropped art** (the ingest pipeline):
  `arttra/.venv/bin/python -I scripts/ingest.py --dry-run`, then without
  `--dry-run`. It does what `scripts/ingest.sh` does (the launchd agent runs
  that one), including commit + push. See `scripts/README.md`.
- For file copies/moves, write a small Python script and run it with a venv
  Python. Git commands themselves are fine to run directly.

## Titles are written by eye, not generated

The build can only invent a title from colour statistics ("Prefix Suffix"),
and the artist loathes those. After publishing new pieces, title them yourself:

1. `arttra/.venv/bin/python -I scripts/contact_sheets.py --out <scratch dir>`
   lays out every piece without a hand title (after the build has produced
   its thumbnail — `git pull` first).
2. Look at each piece and write a title that fits what is in it — any length,
   in Briar's voice (cerebral, poetic, odd), unique across the gallery.
3. Put it in `data/overrides.json` under the piece's id as
   `"title": "...", "titled": true`. Pushing that file rebuilds the site.

## Signature

The build stamps every piece bottom-right with the BRIAR tag + "© year"
(`arttra/assets/signatures/sig-a-tag.png`), on the thumb, web and print files.
A piece that already carries a hand signature must opt out with
`"sign": false` in `data/overrides.json` — check new pieces for one when
titling them.

## Screenshots must not look like screenshots

Some drops are screenshots: the art with a status bar, an app toolbar, an
Instagram/Reddit frame or an export watermark around it. The owner wants each
one edited so it reads as the artwork alone, or hidden. Check new pieces for
this when titling them (look at the edges at full size, not just the thumb).

Fix it in `data/overrides.json`, never by changing the file in
`gallery-source/`. Coordinates are pixels of the original file:

- `"crop": [left, top, right, bottom]` keeps only that box.
- `"erase": [[left, top, right, bottom], ...]` paints over a small mark from
  the pixels around it (a thin guide line, an icon on calm ground). It cannot
  rebuild detail, so crop instead when the mark sits on busy artwork.

The build applies them before everything else, keeps the piece's id, and
re-processes only that piece. If the chrome can't be cropped or erased
cleanly, hide the piece (`"hidden": true` + `"hiddenReason"`).

## Pipeline in one line

Drop images in iCloud `arttra-drops/` → ingest copies them into
`gallery-source/` and pushes → GitHub Actions runs
`arttra/build_from_folder.py` → R2 upload + `data/artworks.json`.
`data/overrides.json` is the only hand-edited data file. Hidden pieces stay
hidden unless the owner says otherwise.

## Public data vs. private print files

`data/artworks.json` is public, so the build strips `printUrl`, `printFile`,
`vectorFile` and `sourceFile` from it. The SKU -> print-file map is written to
`.arttra-work/print-map.json` (gitignored) and CI uploads it to R2 at
`private/print-map.json`; the checkout Worker reads it through its bucket
binding (falling back to `data/build_manifest.json`). Don't add print or
source paths back into artworks.json.

The build also writes a short plain description for any piece without one
(used as alt text). A hand-written `"description"` in overrides.json wins.
Duplicates are hidden with `"hidden": true` plus a `"hiddenReason"`.

## Philosophy pages

`residual-warmth.md`, `umwelt.md` and `the-accumulation-principle.md` are the
source texts. After editing one, run
`arttra/.venv/bin/python -I scripts/render_philosophy.py` (needs `markdown`)
to rebuild `philosophy/*.html`, and commit both.
