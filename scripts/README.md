# arttra ingest

Local ingestion layer that watches a drops folder, stages images into
`gallery-source/`, commits, and pushes — which triggers the GitHub Actions
build workflow defined in `.github/workflows/build.yml`.

## Why this exists

The previous setup used a `launchctl` agent with `WatchPaths` pointed at an
iCloud Drive folder. That combination is broken for three reasons:

1. **FSEvents is unreliable on iCloud.** Files synced from another device
   arrive as dataless placeholders, and the metadata events that fire don't
   match what `WatchPaths` expects.
2. **Placeholders aren't readable.** Even when Finder shows the file, the
   bytes may not be on disk until something explicitly requests them.
   `sips`, `rembg`, and `magick` all fail on placeholders.
3. **iCloud sync is asynchronous.** The Mac doing the watching may not see
   files for seconds-to-minutes after they appear on the source machine.

The fix is polling instead of watching, plus `brctl download` to force
materialization, plus a file-size-stability check to avoid ingesting a
half-synced file.

## Files

- `ingest.sh` — the polling worker. Materializes iCloud placeholders,
  filters to stable files, optionally converts HEIC -> JPEG with `sips`,
  moves into `gallery-source/`, commits, and pushes with retry.
- `com.arttra.pipeline.plist.template` — launchd plist template. Polls
  every 60s, runs at load, logs to `~/Library/Logs/arttra-ingest.{out,err}.log`.
- `install-agent.sh` — renders the template with this Mac's paths and
  bootstraps the agent.

## Install on a new Mac

```bash
git clone git@github.com:sugarcypher/arttra.git
cd arttra
scripts/install-agent.sh
# prompts for the drops folder; default is iCloud Drive/arttra-drops
```

To use a non-iCloud drops folder (recommended — see "Better than iCloud"
below), pass it as the first argument:

```bash
scripts/install-agent.sh ~/arttra-drops-local
```

## Run once, manually

Useful for debugging or processing a backlog before installing the agent:

```bash
ARTTRA_DROPS="$HOME/Library/Mobile Documents/com~apple~CloudDocs/arttra-drops" \
ARTTRA_REPO="$(pwd)" \
ARTTRA_BRANCH=main \
bash -x scripts/ingest.sh
```

## Logs

```bash
tail -f ~/Library/Logs/arttra-ingest.out.log ~/Library/Logs/arttra-ingest.err.log
launchctl list | grep arttra            # confirm the agent is loaded
launchctl print gui/$(id -u)/com.arttra.pipeline | head -40
```

The second column of `launchctl list` is the last exit code. `0` is healthy;
anything else means the script ran and failed — check the err log.

## Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.arttra.pipeline.plist
rm ~/Library/LaunchAgents/com.arttra.pipeline.plist
```

## Better than iCloud

iCloud will keep biting you forever. If you have two Macs that both need to
see the drops folder, replace iCloud with [Syncthing][syncthing]:

```bash
brew install syncthing
brew services start syncthing
```

Add a folder shared between both machines, point `ARTTRA_DROPS` at the
local path on each Mac, and the polling worker will pick up files as soon
as Syncthing lands them on disk — no placeholders, no waiting.

[syncthing]: https://syncthing.net
