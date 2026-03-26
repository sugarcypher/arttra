"""
Instagram scraper for arttra.art — pulls all images and videos from @skbriar.

Uses instaloader for the heavy lifting. Handles:
  - Full profile scrape (all posts, not just recent)
  - Incremental sync (only new posts since last run)
  - Carousel posts (multiple images per post)
  - Video posts (downloaded separately for NFT gallery)
  - Rate limiting and session persistence
  - Metadata extraction (caption, hashtags, timestamp, likes, location)

State is tracked in a JSON manifest so re-runs are incremental.
"""

import json
import os
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import instaloader


MANIFEST_FILE = "scrape_manifest.json"


class InstagramScraper:
    def __init__(
        self,
        username: str = "skbriar",
        data_dir: str = "./data/raw",
        session_file: Optional[str] = None,
        login_user: Optional[str] = None,
        login_pass: Optional[str] = None,
    ):
        self.target_username = username
        self.data_dir = Path(data_dir)
        self.images_dir = self.data_dir / "images"
        self.videos_dir = self.data_dir / "videos"
        self.meta_dir = self.data_dir / "meta"
        self.session_file = session_file
        self.login_user = login_user or os.getenv("INSTAGRAM_USERNAME")
        self.login_pass = login_pass or os.getenv("INSTAGRAM_PASSWORD")

        for d in [self.images_dir, self.videos_dir, self.meta_dir]:
            d.mkdir(parents=True, exist_ok=True)

        self._loader = None
        self.manifest = self._load_manifest()

    # ------------------------------------------------------------------
    # Instaloader setup
    # ------------------------------------------------------------------

    def _get_loader(self) -> instaloader.Instaloader:
        if self._loader is not None:
            return self._loader

        self._loader = instaloader.Instaloader(
            download_pictures=True,
            download_videos=True,
            download_video_thumbnails=True,
            download_geotags=False,
            download_comments=False,
            save_metadata=True,
            compress_json=False,
            post_metadata_txt_pattern="",
            filename_pattern="{shortcode}_{date_utc:%Y%m%d}",
            max_connection_attempts=5,
        )

        # Try session restore, then login, then anonymous
        if self.session_file and Path(self.session_file).exists() and self.login_user:
            try:
                self._loader.load_session_from_file(self.login_user, self.session_file)
                self._loader.test_login()
                print(f"[scraper] Restored session for @{self.login_user}")
                return self._loader
            except Exception as e:
                print(f"[scraper] Session restore failed: {e}")

        if self.login_user and self.login_pass:
            try:
                self._loader.login(self.login_user, self.login_pass)
                if self.session_file:
                    self._loader.save_session_to_file(self.session_file)
                print(f"[scraper] Logged in as @{self.login_user}")
                return self._loader
            except Exception as e:
                print(f"[scraper] Login failed, continuing anonymous: {e}")

        print("[scraper] Running in anonymous mode (public profiles only)")
        return self._loader

    # ------------------------------------------------------------------
    # Manifest (tracks what we've already downloaded)
    # ------------------------------------------------------------------

    def _manifest_path(self) -> Path:
        return self.data_dir / MANIFEST_FILE

    def _load_manifest(self) -> dict:
        p = self._manifest_path()
        if p.exists():
            with open(p) as f:
                return json.load(f)
        return {"posts": {}, "last_scrape": None, "total_downloaded": 0}

    def _save_manifest(self):
        with open(self._manifest_path(), "w") as f:
            json.dump(self.manifest, f, indent=2, default=str)

    # ------------------------------------------------------------------
    # Core scrape
    # ------------------------------------------------------------------

    def scrape(self, max_posts: int = 0, force: bool = False) -> dict:
        """
        Scrape @skbriar. Returns stats dict.

        max_posts=0 means all posts (full archive).
        force=True re-downloads even if shortcode is in manifest.
        """
        L = self._get_loader()
        profile = instaloader.Profile.from_username(L.context, self.target_username)

        stats = {
            "profile": self.target_username,
            "total_posts": profile.mediacount,
            "new_images": 0,
            "new_videos": 0,
            "skipped": 0,
            "errors": 0,
            "started_at": datetime.utcnow().isoformat(),
        }

        print(f"[scraper] @{self.target_username}: {profile.mediacount} posts total")

        tmp_dir = self.data_dir / "_tmp_scrape"
        tmp_dir.mkdir(exist_ok=True)

        try:
            posts = profile.get_posts()
            for i, post in enumerate(posts):
                if max_posts > 0 and i >= max_posts:
                    break

                sc = post.shortcode

                if not force and sc in self.manifest["posts"]:
                    stats["skipped"] += 1
                    continue

                try:
                    self._download_post(L, post, tmp_dir, stats)
                    self._save_manifest()  # incremental save
                except Exception as e:
                    print(f"[scraper] Error on {sc}: {e}")
                    stats["errors"] += 1

                # Rate limiting: ~1-2s between posts
                time.sleep(1.5)

                if (i + 1) % 50 == 0:
                    print(f"[scraper] Progress: {i+1} posts processed")

        except instaloader.exceptions.ProfileNotExistsException:
            print(f"[scraper] Profile @{self.target_username} not found or private")
        except instaloader.exceptions.LoginRequiredException:
            print("[scraper] Login required — profile may be private")
        except Exception as e:
            print(f"[scraper] Fatal error: {e}")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        stats["finished_at"] = datetime.utcnow().isoformat()
        self.manifest["last_scrape"] = stats["finished_at"]
        self.manifest["total_downloaded"] = len(self.manifest["posts"])
        self._save_manifest()

        print(f"[scraper] Done. Images: +{stats['new_images']}, "
              f"Videos: +{stats['new_videos']}, "
              f"Skipped: {stats['skipped']}, Errors: {stats['errors']}")

        return stats

    def _download_post(self, L: instaloader.Instaloader, post, tmp_dir: Path, stats: dict):
        """Download a single post (handles images, videos, carousels)."""
        sc = post.shortcode
        post_dir = tmp_dir / sc
        post_dir.mkdir(exist_ok=True)

        original_cwd = os.getcwd()
        try:
            os.chdir(post_dir)
            L.download_post(post, target=".")
        finally:
            os.chdir(original_cwd)

        # Collect metadata
        post_meta = {
            "shortcode": sc,
            "post_url": f"https://www.instagram.com/p/{sc}/",
            "caption": post.caption or "",
            "hashtags": list(post.caption_hashtags) if post.caption_hashtags else [],
            "timestamp": post.date_utc.isoformat(),
            "likes": post.likes,
            "is_video": post.is_video,
            "typename": post.typename,
            "location": str(post.location) if post.location else None,
            "media_files": [],
        }

        # Move downloaded files to permanent storage
        for f in sorted(post_dir.rglob("*")):
            if not f.is_file():
                continue

            ext = f.suffix.lower()

            if ext in (".jpg", ".jpeg", ".png", ".webp"):
                dest = self.images_dir / f"{sc}_{f.name}"
                shutil.move(str(f), str(dest))
                post_meta["media_files"].append({
                    "type": "image",
                    "filename": dest.name,
                    "path": str(dest),
                })
                stats["new_images"] += 1

            elif ext in (".mp4", ".mov", ".webm"):
                dest = self.videos_dir / f"{sc}_{f.name}"
                shutil.move(str(f), str(dest))
                post_meta["media_files"].append({
                    "type": "video",
                    "filename": dest.name,
                    "path": str(dest),
                })
                stats["new_videos"] += 1

            elif ext == ".json":
                # instaloader metadata sidecar
                dest = self.meta_dir / f"{sc}_meta.json"
                shutil.move(str(f), str(dest))

            # Skip .txt sidecars etc.

        self.manifest["posts"][sc] = post_meta

        media_summary = ", ".join(
            f"{m['type']}:{m['filename']}" for m in post_meta["media_files"]
        )
        print(f"[scraper] {sc} -> {media_summary}")

    # ------------------------------------------------------------------
    # Incremental sync helper
    # ------------------------------------------------------------------

    def sync_new(self, lookback: int = 50) -> dict:
        """
        Quick sync: only check the most recent `lookback` posts.
        Stops early if it hits a post we already have.
        """
        L = self._get_loader()
        profile = instaloader.Profile.from_username(L.context, self.target_username)

        stats = {"new_images": 0, "new_videos": 0, "skipped": 0, "errors": 0}
        tmp_dir = self.data_dir / "_tmp_sync"
        tmp_dir.mkdir(exist_ok=True)

        consecutive_known = 0

        try:
            for i, post in enumerate(profile.get_posts()):
                if i >= lookback:
                    break

                sc = post.shortcode
                if sc in self.manifest["posts"]:
                    consecutive_known += 1
                    stats["skipped"] += 1
                    # If we hit 10 consecutive known posts, we're caught up
                    if consecutive_known >= 10:
                        print(f"[scraper] 10 consecutive known posts — caught up")
                        break
                    continue

                consecutive_known = 0

                try:
                    self._download_post(L, post, tmp_dir, stats)
                    self._save_manifest()
                except Exception as e:
                    print(f"[scraper] Error on {sc}: {e}")
                    stats["errors"] += 1

                time.sleep(1.5)

        except Exception as e:
            print(f"[scraper] Sync error: {e}")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        self.manifest["last_scrape"] = datetime.utcnow().isoformat()
        self._save_manifest()
        return stats


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Scrape Instagram for arttra.art")
    parser.add_argument("--username", default="skbriar", help="Instagram username")
    parser.add_argument("--data-dir", default="./data/raw", help="Output directory")
    parser.add_argument("--max-posts", type=int, default=0, help="Max posts (0=all)")
    parser.add_argument("--sync", action="store_true", help="Quick incremental sync")
    parser.add_argument("--force", action="store_true", help="Re-download everything")
    parser.add_argument("--session", default="session.instaloader", help="Session file")

    args = parser.parse_args()

    scraper = InstagramScraper(
        username=args.username,
        data_dir=args.data_dir,
        session_file=args.session,
    )

    if args.sync:
        result = scraper.sync_new()
    else:
        result = scraper.scrape(max_posts=args.max_posts, force=args.force)

    print(json.dumps(result, indent=2))
