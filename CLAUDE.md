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

## Pipeline in one line

Drop images in iCloud `arttra-drops/` → ingest copies them into
`gallery-source/` and pushes → GitHub Actions runs
`arttra/build_from_folder.py` → R2 upload + `data/artworks.json`.
`data/overrides.json` is the only hand-edited data file. Hidden pieces stay
hidden unless the owner says otherwise.
