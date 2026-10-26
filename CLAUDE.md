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

## Pipeline in one line

Drop images in iCloud `arttra-drops/` → ingest copies them into
`gallery-source/` and pushes → GitHub Actions runs
`arttra/build_from_folder.py` → R2 upload + `data/artworks.json`.
`data/overrides.json` is the only hand-edited data file. Hidden pieces stay
hidden unless the owner says otherwise.
