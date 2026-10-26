#!/usr/bin/env python3
"""arttra ingest, Python edition: same rules as ingest.sh, no bash needed.

Claude Code sessions on this Mac can't run bash/sh scripts (denied in
~/.claude/settings.json), so Claude runs this instead:

    arttra/.venv/bin/python -I scripts/ingest.py --dry-run   # show the plan
    arttra/.venv/bin/python -I scripts/ingest.py             # do it + push

Config comes from the same env vars as ingest.sh. Unset ones default to
this Mac's launchd agent values.

Rules (keep in sync with ingest.sh):
  - only top-level image files whose size is stable for ARTTRA_STABLE_SECS
  - byte-identical to a file in REJECTED -> moved into REJECTED, not ingested
  - byte-identical to a gallery file      -> archived, not re-ingested
  - otherwise published under its own stem, or <stem>-<md5[:6]> when that
    stem is already used in gallery-source/ or the archive; HEIC -> JPEG
  - the original is archived under the same final name, never overwriting
  - only the files ingested this run are staged, then commit + push
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

ICLOUD = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs"
DROPS = Path(os.environ.get("ARTTRA_DROPS") or ICLOUD / "arttra-drops")
REPO = Path(os.environ.get("ARTTRA_REPO") or Path(__file__).resolve().parent.parent)
BRANCH = os.environ.get("ARTTRA_BRANCH", "main")
STABLE_SECS = int(os.environ.get("ARTTRA_STABLE_SECS", "5"))
REJECTED = Path(os.environ.get("ARTTRA_REJECTED") or DROPS.parent / "arttra-rejected")
DROPPED = Path(os.environ.get("ARTTRA_DROPPED") or DROPS / "artra-dropped")
GALLERY = REPO / "gallery-source"
PIDFILE = Path("/tmp/arttra-ingest.lock.pid")  # shared with ingest.sh
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp", ".heic"}
DRY = "--dry-run" in sys.argv


def log(msg):
    print(f"[arttra-ingest.py {datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}] {msg}", flush=True)


def git(*args, check=True):
    r = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r


def md5(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def identical_in(f, folder):
    """Name of a file in folder byte-identical to f (size checked first), else None."""
    if not folder.is_dir():
        return None
    size, digest = f.stat().st_size, None
    for cand in sorted(folder.iterdir()):
        if cand.is_file() and cand.stat().st_size == size:
            digest = digest or md5(f)
            if md5(cand) == digest:
                return cand.name
    return None


def taken_stems():
    return {p.stem.lower() for d in (GALLERY, DROPPED) if d.is_dir() for p in d.iterdir()}


def unique_stem(stem, f):
    taken = taken_stems()
    if stem.lower() not in taken:
        return stem
    h = md5(f)[:6]
    cand, n = f"{stem}-{h}", 2
    while cand.lower() in taken:
        cand, n = f"{stem}-{h}-{n}", n + 1
    return cand


def free_path(folder, name):
    """folder/name, or 'stem (2).ext', '(3)'… — never an existing path."""
    target, n = folder / name, 2
    while target.exists():
        target = folder / f"{Path(name).stem} ({n}){Path(name).suffix}"
        n += 1
    return target


def move(src, target):
    if DRY:
        return target.name
    shutil.move(str(src), str(target))
    if src.exists() or not target.is_file():
        raise RuntimeError(f"move did not complete: {src} -> {target}")
    return target.name


def ingest_one(src):
    """Handle one stable drop. Returns the gallery path it published, or None."""
    ext = src.suffix[1:]
    rej = identical_in(src, REJECTED)
    if rej:
        log(f"rejected (identical to rejected/{rej}) — moved to rejected/: {move(src, free_path(REJECTED, src.name))}")
        return None
    is_heic = ext.lower() == "heic"
    if is_heic:
        # The gallery holds the converted JPEG, so match re-drops against
        # archived HEIC originals whose stem is published.
        arch = identical_in(src, DROPPED)
        if arch and Path(arch).stem.lower() in {p.stem.lower() for p in GALLERY.iterdir()}:
            landed = move(src, free_path(DROPPED, f"{Path(arch).stem}.{ext}"))
            log(f"duplicate of published {Path(arch).stem} — not re-ingested, archived as: {landed}")
            return None
    else:
        dup = identical_in(src, GALLERY)
        if dup:
            landed = move(src, free_path(DROPPED, f"{Path(dup).stem}.{ext}"))
            log(f"duplicate of gallery-source/{dup} — not re-ingested, archived as: {landed}")
            return None

    new_stem = unique_stem(src.stem, src)
    dest = GALLERY / f"{new_stem}.{'jpg' if is_heic else ext}"
    archived = free_path(DROPPED, f"{new_stem}.{ext}")
    renamed = "" if new_stem == src.stem else f" (dropped as {src.name} — name was taken)"
    if DRY:
        log(f"would publish gallery-source/{dest.name}{renamed}, archive as {archived.name}")
        return dest

    if is_heic:
        tmp = Path(tempfile.mkdtemp(prefix="arttra-")) / "conv.jpg"
        r = subprocess.run(["sips", "-s", "format", "jpeg", str(src), "--out", str(tmp)], capture_output=True)
        if r.returncode != 0 or not tmp.is_file():
            log(f"sips conversion failed — leaving in drops: {src.name}")
            return None
        shutil.move(str(tmp), str(dest))
    else:
        # Plain streaming copy: clonefile-based copies deadlock on iCloud files.
        with open(src, "rb") as fi, open(dest, "xb") as fo:  # "x": never overwrite
            shutil.copyfileobj(fi, fo, 1 << 20)
        if dest.stat().st_size != src.stat().st_size:
            dest.unlink()
            log(f"copy incomplete — removed, leaving in drops: {src.name}")
            return None
    try:
        with Image.open(dest) as im:
            im.verify()
    except Exception as e:
        dest.unlink()
        log(f"not a valid image ({e}) — removed, leaving in drops: {src.name}")
        return None
    landed = move(src, archived)
    log(f"ingested as {dest.name}{renamed}, archived as: {landed}")
    return dest


def main():
    for d, what in ((DROPS, "drops folder"), (REPO / ".git", "repo checkout")):
        if not d.exists():
            log(f"{what} missing: {d}")
            return 2
    if PIDFILE.exists():
        try:
            os.kill(int(PIDFILE.read_text().strip()), 0)
            log(f"another ingest run is active (pid {PIDFILE.read_text().strip()}) — exiting")
            return 0
        except (ValueError, ProcessLookupError, PermissionError):
            pass
    PIDFILE.write_text(str(os.getpid()))
    try:
        DROPPED.mkdir(exist_ok=True)
        subprocess.run(["brctl", "download", str(DROPS)], capture_output=True)  # materialize iCloud files
        cands = sorted(p for p in DROPS.iterdir() if p.is_file() and p.suffix.lower() in EXTS)
        if not cands:
            log(f"no candidate files in {DROPS} — nothing to do")
            return 0
        sizes = {p: p.stat().st_size for p in cands}
        time.sleep(STABLE_SECS)
        stable = [p for p in cands if p.stat().st_size == sizes[p] and sizes[p] > 0]
        for p in sorted(set(cands) - set(stable)):
            log(f"skipping (still syncing): {p.name}")
        if not stable:
            return 0

        if not DRY:
            git("fetch", "origin", BRANCH, check=False)
            git("checkout", BRANCH)
            git("pull", "--rebase", "--autostash", "origin", BRANCH)
        added = [d for d in (ingest_one(p) for p in stable) if d]
        if DRY or not added:
            log("dry run — nothing changed" if DRY else "nothing new staged — exiting")
            return 0

        git("add", "--", *[str(d.relative_to(REPO)) for d in added])
        n = len(added)
        msg = f"ingest: add {n} image{'s' if n != 1 else ''} ({datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC})"
        git("-c", "user.name=arttra-ingest", "-c", "user.email=ingest@arttra.art", "commit", "-q", "-m", msg)
        delay = 2
        for attempt in range(1, 6):
            if git("push", "origin", BRANCH, check=False).returncode == 0:
                log(f"pushed: {msg}")
                return 0
            log(f"push attempt {attempt} failed — pulling and retrying in {delay}s")
            time.sleep(delay)
            git("pull", "--rebase", "--autostash", "origin", BRANCH, check=False)
            delay *= 2
        log("push failed after 5 attempts — commit is local; push it manually")
        return 1
    finally:
        PIDFILE.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
