#!/bin/bash
# arttra ingest — pull dropped images into gallery-source/ and push.
#
# Designed to be invoked by launchd on a polling interval (StartInterval),
# NOT WatchPaths — FSEvents is unreliable on iCloud Drive and network mounts.
#
# Required env vars (set by the launchd plist, or export before running manually):
#   ARTTRA_DROPS   — folder where images are dropped (often inside iCloud Drive)
#   ARTTRA_REPO    — absolute path to the local clone of the arttra repo
#   ARTTRA_BRANCH  — branch to push to (default: main)
#
# Optional:
#   ARTTRA_STABLE_SECS — seconds a file size must be stable before ingesting (default: 5)
#   ARTTRA_REJECTED    — folder of basenames to skip (default: $(dirname DROPS)/arttra-rejected)
#                        if a candidate's basename matches anything here, ingest skips it and
#                        moves the candidate from DROPS into this folder (sticky memory).
#   ARTTRA_DROPPED     — archive folder for successfully-handled originals
#                        (default: $DROPS/artra-dropped). Each successful ingest moves the
#                        source file out of DROPS into here, so DROPS empties itself.

set -u

DROPS="${ARTTRA_DROPS:-}"
REPO="${ARTTRA_REPO:-}"
BRANCH="${ARTTRA_BRANCH:-main}"
STABLE_SECS="${ARTTRA_STABLE_SECS:-5}"
LOCK="/tmp/arttra-ingest.lock"
LOG_TAG="[arttra-ingest $(date -u '+%Y-%m-%dT%H:%M:%SZ')]"

log() { echo "$LOG_TAG $*"; }

# Portable file size — BSD stat (macOS) uses -f, GNU stat (Linux) uses -c.
file_size() {
  /usr/bin/stat -f%z "$1" 2>/dev/null || /usr/bin/stat -c%s "$1" 2>/dev/null || echo ""
}

# True if basename "$1" exists in the rejected folder (sticky memory of skips).
in_rejected() {
  [[ -n "${REJECTED:-}" && -d "$REJECTED" && -e "$REJECTED/$1" ]]
}

if [[ -z "$DROPS" || -z "$REPO" ]]; then
  log "ARTTRA_DROPS and ARTTRA_REPO must be set"
  exit 2
fi

if [[ ! -d "$DROPS" ]]; then
  log "drops folder does not exist: $DROPS"
  exit 2
fi

if [[ ! -d "$REPO/.git" ]]; then
  log "repo is not a git checkout: $REPO"
  exit 2
fi

# Single-instance lock — launchd can fire overlapping runs while a previous
# push is still in flight. PID file with liveness check is good enough.
PIDFILE="${LOCK}.pid"
if [[ -e "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  log "another ingest run is active (pid $(cat "$PIDFILE")) — exiting"
  exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

GALLERY_SRC="$REPO/gallery-source"
mkdir -p "$GALLERY_SRC"

# Defaults for the sibling folders. The rejected folder lives next to DROPS;
# the dropped (archive) folder is a subfolder of DROPS so it travels with it.
REJECTED="${ARTTRA_REJECTED:-$(/usr/bin/dirname "$DROPS")/arttra-rejected}"
DROPPED="${ARTTRA_DROPPED:-$DROPS/artra-dropped}"
mkdir -p "$DROPPED"

# Force iCloud to materialize any dataless / placeholder files in the drops folder.
# brctl is the macOS CLI for iCloud; on non-mac systems this is a no-op.
if command -v brctl >/dev/null 2>&1; then
  /usr/bin/find "$DROPS" -type f \( -name "*.icloud" -o -name ".*.icloud" \) -print0 \
    | xargs -0 -I{} brctl download "{}" >/dev/null 2>&1 || true
  brctl download "$DROPS" >/dev/null 2>&1 || true
fi

shopt -s nullglob nocaseglob

# Collect candidate files. Only image extensions the python pipeline accepts.
candidates=()
for f in "$DROPS"/*.{jpg,jpeg,png,webp,tiff,bmp,heic}; do
  [[ -f "$f" ]] || continue
  candidates+=("$f")
done

if (( ${#candidates[@]} == 0 )); then
  log "no candidate files in $DROPS — nothing to do"
  exit 0
fi

log "found ${#candidates[@]} candidate file(s) in $DROPS"

# Filter to files whose size has been stable for at least STABLE_SECS.
# This avoids ingesting half-synced iCloud files or in-flight AirDrop transfers.
stable=()
for f in "${candidates[@]}"; do
  s1=$(file_size "$f")
  [[ -z "$s1" ]] && continue
  /bin/sleep "$STABLE_SECS"
  s2=$(file_size "$f")
  if [[ "$s1" == "$s2" && "$s1" != "0" ]]; then
    stable+=("$f")
  else
    log "skipping (still syncing): $(basename "$f")"
  fi
done

if (( ${#stable[@]} == 0 )); then
  log "no stable files this round — exiting"
  exit 0
fi

cd "$REPO" || { log "cd to repo failed"; exit 1; }

# Get latest before staging — push --force-with-lease later relies on this.
/usr/bin/git fetch origin "$BRANCH" --quiet || true
/usr/bin/git checkout "$BRANCH" --quiet 2>/dev/null || /usr/bin/git checkout -B "$BRANCH" --quiet
/usr/bin/git pull --rebase origin "$BRANCH" --quiet || {
  log "git pull --rebase failed; aborting this run"
  exit 1
}

# Per-file processing. Three buckets per source file:
#   1) basename in REJECTED  → move source from DROPS into REJECTED, no ingest
#   2) basename already in GALLERY_SRC → archive source into DROPPED, no re-ingest
#   3) new file → cp into GALLERY_SRC, then move source into DROPPED
# Net effect: DROPS empties itself every run; DROPPED is the archive of originals;
# REJECTED is sticky memory of "do not ingest this basename ever".
moved=()
for src in "${stable[@]}"; do
  base="$(basename "$src")"
  ext_lc="$(echo "${base##*.}" | /usr/bin/tr '[:upper:]' '[:lower:]')"
  stem="${base%.*}"

  if in_rejected "$base"; then
    # mv-with-overwrite back into REJECTED; if mv fails for any reason, just rm
    # the source so the file doesn't keep triggering this branch every poll.
    if /bin/mv -f "$src" "$REJECTED/$base" 2>/dev/null; then
      log "rejected (matched $REJECTED/$base) — moved source back to rejected/: $base"
    else
      /bin/rm -f "$src"
      log "rejected (matched $REJECTED/$base) — removed source from drops/: $base"
    fi
    continue
  fi

  if [[ "$ext_lc" == "heic" ]]; then
    if ! command -v sips >/dev/null 2>&1; then
      log "HEIC found but sips not available — leaving in drops: $base"
      continue
    fi
    dest="$GALLERY_SRC/${stem}.jpg"
    if [[ -e "$dest" ]]; then
      /bin/mv "$src" "$DROPPED/$base"
      log "already in gallery as ${stem}.jpg — archived HEIC to dropped/: $base"
      continue
    fi
    tmp_jpg="$(/usr/bin/mktemp -t arttra).jpg"
    if ! sips -s format jpeg "$src" --out "$tmp_jpg" >/dev/null 2>&1; then
      /bin/rm -f "$tmp_jpg"
      log "sips conversion failed — leaving in drops: $base"
      continue
    fi
    /bin/mv "$tmp_jpg" "$dest"
    /bin/mv "$src" "$DROPPED/$base"
    moved+=("$dest")
    log "converted HEIC → JPEG (original archived): ${stem}.jpg"
    continue
  fi

  dest="$GALLERY_SRC/$base"
  if [[ -e "$dest" ]]; then
    /bin/mv "$src" "$DROPPED/$base"
    log "already in gallery — archived to dropped/: $base"
    continue
  fi
  if ! /bin/cp "$src" "$dest"; then
    log "cp to gallery-source failed — leaving in drops: $base"
    continue
  fi
  /bin/mv "$src" "$DROPPED/$base"
  moved+=("$dest")
  log "ingested + archived: $base"
done

if (( ${#moved[@]} == 0 )); then
  log "nothing new staged — exiting"
  exit 0
fi

/usr/bin/git add gallery-source
if /usr/bin/git diff --staged --quiet; then
  log "git sees no staged changes after add — exiting"
  exit 0
fi

count=${#moved[@]}
msg="ingest: add ${count} image$([[ $count -ne 1 ]] && echo s) ($(date -u '+%Y-%m-%d %H:%M UTC'))"
/usr/bin/git -c user.name="arttra-ingest" -c user.email="ingest@arttra.art" commit -m "$msg"

# Up to 5 push attempts with backoff — the build workflow does its own
# auto-commit + force push, so a non-fast-forward race is normal.
delay=2
for attempt in 1 2 3 4 5; do
  if /usr/bin/git push origin "$BRANCH"; then
    log "push succeeded on attempt $attempt"
    exit 0
  fi
  log "push attempt $attempt failed — pulling and retrying in ${delay}s"
  /bin/sleep "$delay"
  /usr/bin/git pull --rebase origin "$BRANCH" --quiet || true
  delay=$(( delay * 2 ))
done

log "push failed after 5 attempts — staged commit is local; will retry next run"
exit 1
