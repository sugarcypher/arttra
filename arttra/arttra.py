#!/usr/bin/env python3
"""
arttra — unified CLI for the arttra.art pipeline.

Commands:
  scrape       Full archive scrape from @skbriar
  sync         Incremental sync (recent posts only)
  process      Generate artworks.json + videos.json from scraped data
  thumbs       Generate thumbnails and optimized images
  build        Run full pipeline: sync -> process -> thumbs
  deploy       Copy videos to site/assets/videos for serving
  serve        Start local dev server

Usage:
  python arttra.py build           # full pipeline
  python arttra.py scrape --max 50 # scrape first 50 posts
  python arttra.py sync            # quick daily sync
  python arttra.py serve           # preview locally
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


# Resolve project root
ROOT = Path(__file__).parent.resolve()
DATA_RAW = ROOT / "data" / "raw"
SITE_DIR = ROOT / "site"
SITE_DATA = SITE_DIR / "data"
SITE_IMAGES = SITE_DIR / "assets" / "images" / "gallery"
SITE_VIDEOS = SITE_DIR / "assets" / "videos"


def cmd_scrape(args):
    from scraper.instagram import InstagramScraper

    scraper = InstagramScraper(
        username=args.username,
        data_dir=str(DATA_RAW),
        session_file=str(ROOT / "session.instaloader"),
    )
    stats = scraper.scrape(max_posts=args.max, force=args.force)
    print(json.dumps(stats, indent=2))


def cmd_sync(args):
    from scraper.instagram import InstagramScraper

    scraper = InstagramScraper(
        username=args.username,
        data_dir=str(DATA_RAW),
        session_file=str(ROOT / "session.instaloader"),
    )
    stats = scraper.sync_new(lookback=args.lookback)
    print(json.dumps(stats, indent=2))


def cmd_process(args):
    from processor.metadata import MetadataProcessor

    processor = MetadataProcessor(
        data_dir=str(DATA_RAW),
        output_dir=str(SITE_DATA),
    )
    # Use relative paths for GitHub Pages
    artworks, videos = processor.process(base_image_url="./assets/images/gallery")
    print(f"Processed: {len(artworks)} artworks, {len(videos)} videos")


def cmd_thumbs(args):
    from processor.thumbs import ThumbnailProcessor

    processor = ThumbnailProcessor(
        raw_images_dir=str(DATA_RAW / "images"),
        output_dir=str(SITE_IMAGES),
        workers=args.workers,
    )
    stats = processor.process_all(force=args.force)
    print(json.dumps(stats, indent=2))


def cmd_deploy_videos(args):
    """Copy scraped videos to the site assets folder."""
    src = DATA_RAW / "videos"
    SITE_VIDEOS.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        print("[deploy] No videos directory found")
        return

    count = 0
    for f in src.iterdir():
        if f.suffix.lower() in (".mp4", ".mov", ".webm"):
            dest = SITE_VIDEOS / f.name
            if not dest.exists():
                shutil.copy2(str(f), str(dest))
                count += 1

    print(f"[deploy] Copied {count} new videos to site/assets/videos/")


def cmd_build(args):
    """Full pipeline: sync -> process -> thumbs -> deploy videos."""
    print("=" * 60)
    print("ARTTRA.ART — Full Build Pipeline")
    print("=" * 60)

    print("\n[1/4] Syncing from Instagram...")
    try:
        cmd_sync(args)
    except Exception as e:
        print(f"[build] Sync failed: {e}")
        if not (DATA_RAW / "scrape_manifest.json").exists():
            print("[build] No existing data — cannot continue")
            sys.exit(1)
        print("[build] Continuing with existing data...")

    print("\n[2/4] Processing metadata...")
    cmd_process(args)

    print("\n[3/4] Generating thumbnails...")
    cmd_thumbs(args)

    print("\n[4/4] Deploying videos...")
    cmd_deploy_videos(args)

    print("\n" + "=" * 60)
    print("Build complete. Site ready at: site/")
    print("=" * 60)


def cmd_serve(args):
    """Start a local HTTP server for previewing the site."""
    import http.server
    import functools

    port = args.port
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SITE_DIR))
    server = http.server.HTTPServer(("0.0.0.0", port), handler)

    print(f"Serving arttra.art at http://localhost:{port}")
    print(f"  Gallery:  http://localhost:{port}/")
    print(f"  Videos:   http://localhost:{port}/video-gallery.html")
    print(f"  Admin:    http://localhost:{port}/admin.html")
    print("Press Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


def main():
    parser = argparse.ArgumentParser(
        description="arttra.art — Instagram art gallery pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command")

    # scrape
    p = sub.add_parser("scrape", help="Full archive scrape")
    p.add_argument("--username", default="skbriar")
    p.add_argument("--max", type=int, default=0, help="Max posts (0=all)")
    p.add_argument("--force", action="store_true")

    # sync
    p = sub.add_parser("sync", help="Incremental sync")
    p.add_argument("--username", default="skbriar")
    p.add_argument("--lookback", type=int, default=50)

    # process
    sub.add_parser("process", help="Generate artworks.json + videos.json")

    # thumbs
    p = sub.add_parser("thumbs", help="Generate thumbnails")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--force", action="store_true")

    # build
    p = sub.add_parser("build", help="Full pipeline: sync+process+thumbs+deploy")
    p.add_argument("--username", default="skbriar")
    p.add_argument("--lookback", type=int, default=50)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--force", action="store_true")

    # deploy-videos
    sub.add_parser("deploy-videos", help="Copy videos to site folder")

    # serve
    p = sub.add_parser("serve", help="Local preview server")
    p.add_argument("--port", type=int, default=8000)

    args = parser.parse_args()

    if args.command == "scrape":
        cmd_scrape(args)
    elif args.command == "sync":
        cmd_sync(args)
    elif args.command == "process":
        cmd_process(args)
    elif args.command == "thumbs":
        cmd_thumbs(args)
    elif args.command == "build":
        cmd_build(args)
    elif args.command == "deploy-videos":
        cmd_deploy_videos(args)
    elif args.command == "serve":
        cmd_serve(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
