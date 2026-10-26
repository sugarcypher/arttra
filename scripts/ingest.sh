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
#   ARTTRA_REJECTED    — folder of files to never ingest (default: $(dirname DROPS)/arttra-rejected)
#                        a candidate byte-identical to a file here is moved into this folder
#                        instead of being ingested. Matched by content, not by name.
#   ARTTRA_DROPPED     — archive folder for successfully-handled originals
#                        (default: $DROPS/artra-dropped). Each successful ingest moves the
#                        source file out of DROPS into here, so DROPS empties itself.
#
# Naming: a drop keeps its filename unless that stem is already used in
# gallery-source/ or the archive (generic names like "PNG image.png" and
# IMG_1234 recur constantly). Then it becomes <stem>-<first 6 of its md5>.
# The archived original is renamed to the same name, so archive, gallery
# and site (image URLs, artwork ID) all line up. Only byte-identical
# re-drops are skipped; nothing in the archive is ever overwritten.

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

lower() { echo "$1" | /usr/bin/tr '[:upper:]' '[:lower:]'; }

# Print the basename of a file in dir "$2" byte-identical to "$1"; fail if none.
# Sizes are compared first so only same-size files get hashed.
identical_in() {
  local f="$1" dir="$2" sz h="" cand
  [[ -d "$dir" ]] || return 1
  sz="$(file_size "$f")"
  for cand in "$dir"/*; do
    [[ -f "$cand" && "$(file_size "$cand")" == "$sz" ]] || continue
    [[ -n "$h" ]] || h="$(/sbin/md5 -q "$f")"
    if [[ "$(/sbin/md5 -q "$cand")" == "$h" ]]; then
      basename "$cand"
      return 0
    fi
  done
  return 1
}

# True if stem "$1" (any extension, any case) is used in the gallery or archive.
stem_taken() {
  { /bin/ls -1 "$GALLERY_SRC"; /bin/ls -1 "$DROPPED"; } 2>/dev/null \
    | /usr/bin/sed -E 's/\.[^.]*$//' | /usr/bin/tr '[:upper:]' '[:lower:]' \
    | /usr/bin/grep -Fxq -- "$(lower "$1")"
}

# Gallery stem for new file "$2" dropped as stem "$1": unchanged when free,
# else <stem>-<md5 prefix> (plus -2, -3… in the vanishingly rare tie).
unique_stem() {
  local stem="$1" h candidate n=2
  if ! stem_taken "$stem"; then
    echo "$stem"
    return
  fi
  h="$(/sbin/md5 -q "$2" | /usr/bin/cut -c1-6)"
  candidate="${stem}-${h}"
  while stem_taken "$candidate"; do
    candidate="${stem}-${h}-${n}"
    n=$((n + 1))
  done
  echo "$candidate"
}

# Move "$1" into dir "$2" as name "$3", never overwriting: a taken name
# becomes "<stem> (2).<ext>", "(3)"… Prints the basename it landed as.
safe_mv() {
  local src="$1" dir="$2" name="$3" stem ext target n=2
  stem="${name%.*}"
  ext="${name##*.}"
  target="$dir/$name"
  while [[ -e "$target" ]]; do
    target="$dir/$stem ($n).$ext"
    n=$((n + 1))
  done
  /bin/mv -n "$src" "$target" && [[ -e "$target" && ! -e "$src" ]] && basename "$target"
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
# --autostash: uncommitted edits elsewhere in the checkout (worker/, data/)
# would otherwise make every pull --rebase refuse and stall ingest entirely.
/usr/bin/git fetch origin "$BRANCH" --quiet || true
/usr/bin/git checkout "$BRANCH" --quiet 2>/dev/null || /usr/bin/git checkout -B "$BRANCH" --quiet
/usr/bin/git pull --rebase --autostash origin "$BRANCH" --quiet || {
  log "git pull --rebase failed; aborting this run"
  exit 1
}

# Per-file processing. Four buckets per source file:
#   1) byte-identical to a file in REJECTED → move into REJECTED, no ingest
#   2) byte-identical to something already published → archive, no re-ingest
#   3) HEIC → convert to JPEG under a unique stem, archive original under it
#   4) anything else → copy into GALLERY_SRC under a unique name, archive
#      the original under that same name
# Net effect: DROPS empties itself every run; DROPPED is the archive of
# originals, named exactly as they appear in the gallery and on the site.
moved=()
for src in "${stable[@]}"; do
  base="$(basename "$src")"
  ext="${base##*.}"
  ext_lc="$(lower "$ext")"
  stem="${base%.*}"

  if rej="$(identical_in "$src" "$REJECTED")"; then
    landed="$(safe_mv "$src" "$REJECTED" "$base")" || landed="(move failed, left in drops)"
    log "rejected (identical to rejected/$rej) — moved to rejected/: $landed"
    continue
  fi

  if [[ "$ext_lc" == "heic" ]]; then
    if ! command -v sips >/dev/null 2>&1; then
      log "HEIC found but sips not available — leaving in drops: $base"
      continue
    fi
    # The gallery holds the converted JPEG, so match re-drops against the
    # archived HEIC originals whose stem is published.
    if arch="$(identical_in "$src" "$DROPPED")" \
        && /bin/ls -1 "$GALLERY_SRC" | /usr/bin/sed -E 's/\.[^.]*$//' \
           | /usr/bin/grep -Fxiq -- "${arch%.*}"; then
      landed="$(safe_mv "$src" "$DROPPED" "${arch%.*}.${ext}")" || landed="(move failed)"
      log "duplicate of published ${arch%.*} — not re-ingested, archived as: $landed"
      continue
    fi
    new_stem="$(unique_stem "$stem" "$src")"
    dest="$GALLERY_SRC/${new_stem}.jpg"
    tmp_jpg="$(/usr/bin/mktemp -t arttra).jpg"
    if ! sips -s format jpeg "$src" --out "$tmp_jpg" >/dev/null 2>&1; then
      /bin/rm -f "$tmp_jpg"
      log "sips conversion failed — leaving in drops: $base"
      continue
    fi
    /bin/mv "$tmp_jpg" "$dest"
    landed="$(safe_mv "$src" "$DROPPED" "${new_stem}.${ext}")" || landed="(archive move failed, still in drops)"
    moved+=("$dest")
    log "converted HEIC → ${new_stem}.jpg (dropped as $base, original archived as $landed)"
    continue
  fi

  if dup="$(identical_in "$src" "$GALLERY_SRC")"; then
    landed="$(safe_mv "$src" "$DROPPED" "${dup%.*}.${ext}")" || landed="(move failed)"
    log "duplicate of gallery-source/$dup — not re-ingested, archived as: $landed"
    continue
  fi

  new_stem="$(unique_stem "$stem" "$src")"
  dest="$GALLERY_SRC/${new_stem}.${ext}"
  # Plain streaming copy. /bin/cp uses fcopyfile/clonefile, which deadlocks
  # on iCloud-backed sources ("Resource deadlock avoided") and can leave a
  # zero-byte file behind. cat does a plain read->write: no clone, and the
  # read itself forces iCloud to materialize a dataless placeholder.
  if ! /bin/cat "$src" > "$dest" 2>/dev/null; then
    /bin/rm -f "$dest"
    log "copy failed — removed partial, leaving in drops: $base"
    continue
  fi
  # Verify the copy: byte-complete vs the source, and an actual image.
  # A truncated or bogus file must never reach the gallery or the build.
  src_sz="$(file_size "$src")"
  dest_sz="$(file_size "$dest")"
  if [[ -z "$dest_sz" || "$dest_sz" == "0" || "$dest_sz" != "$src_sz" ]]; then
    /bin/rm -f "$dest"
    log "copy incomplete (${dest_sz:-?}/${src_sz:-?} bytes) — removed, leaving in drops: $base"
    continue
  fi
  if ! /usr/bin/file --brief --mime-type "$dest" 2>/dev/null | /usr/bin/grep -q '^image/'; then
    /bin/rm -f "$dest"
    log "copied file is not a valid image — removed, leaving in drops: $base"
    continue
  fi
  landed="$(safe_mv "$src" "$DROPPED" "${new_stem}.${ext}")" || landed="(archive move failed, still in drops)"
  moved+=("$dest")
  if [[ "$new_stem" == "$stem" ]]; then
    log "ingested + archived: $base"
  else
    log "ingested as $(basename "$dest") (dropped as $base — name was taken), archived as: $landed"
  fi
done

if (( ${#moved[@]} == 0 )); then
  log "nothing new staged — exiting"
  exit 0
fi

# Stage only what this run ingested — never unrelated edits or stray files
# that happen to be sitting in gallery-source/.
/usr/bin/git add -- "${moved[@]}"
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
  /usr/bin/git pull --rebase --autostash origin "$BRANCH" --quiet || true
  delay=$(( delay * 2 ))
done

log "push failed after 5 attempts — staged commit is local; will retry next run"
exit 1
