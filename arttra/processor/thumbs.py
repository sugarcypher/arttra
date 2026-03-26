"""
Thumbnail & image optimization pipeline.

Processes raw scraped images into web-ready formats:
  - Gallery thumbnails (400px wide, WebP, ~30KB)
  - Full-size optimized (max 2000px, WebP, quality 85)
  - Optional: enhanced versions via Pillow Lanczos + sharpening

Runs incrementally — skips images that already have processed versions.
"""

import json
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

try:
    from PIL import Image, ImageFilter, ImageEnhance
except ImportError:
    raise ImportError("Pillow is required: pip install Pillow")


THUMB_WIDTH = 400
FULL_MAX_DIMENSION = 2000
WEBP_QUALITY = 85
THUMB_QUALITY = 75


def process_single_image(
    src_path: str,
    thumb_dir: str,
    full_dir: str,
    filename_stem: str,
) -> dict:
    """Process one image: generate thumbnail + optimized full-size."""
    src = Path(src_path)
    result = {"source": src.name, "thumb": None, "full": None, "error": None}

    try:
        with Image.open(src) as img:
            img = img.convert("RGB")
            orig_w, orig_h = img.size

            # --- Thumbnail ---
            thumb_h = int(orig_h * (THUMB_WIDTH / orig_w))
            thumb = img.resize((THUMB_WIDTH, thumb_h), Image.LANCZOS)
            # Light sharpening for thumbnails
            thumb = thumb.filter(ImageFilter.UnsharpMask(radius=0.5, percent=80, threshold=3))

            thumb_path = Path(thumb_dir) / f"thumb_{filename_stem}.webp"
            thumb.save(str(thumb_path), "WEBP", quality=THUMB_QUALITY, optimize=True)
            result["thumb"] = thumb_path.name

            # --- Full-size optimized ---
            if max(orig_w, orig_h) > FULL_MAX_DIMENSION:
                ratio = FULL_MAX_DIMENSION / max(orig_w, orig_h)
                new_w = int(orig_w * ratio)
                new_h = int(orig_h * ratio)
                full = img.resize((new_w, new_h), Image.LANCZOS)
            else:
                full = img.copy()

            # Subtle enhancement
            full = full.filter(ImageFilter.UnsharpMask(radius=1, percent=100, threshold=3))
            full = ImageEnhance.Contrast(full).enhance(1.02)

            full_path = Path(full_dir) / f"{filename_stem}.webp"
            full.save(str(full_path), "WEBP", quality=WEBP_QUALITY, optimize=True)
            result["full"] = full_path.name

            # Also save a JPEG fallback for older browsers
            jpg_path = Path(full_dir) / f"{filename_stem}.jpg"
            full.save(str(jpg_path), "JPEG", quality=WEBP_QUALITY, optimize=True)

    except Exception as e:
        result["error"] = str(e)

    return result


class ThumbnailProcessor:
    def __init__(
        self,
        raw_images_dir: str = "./data/raw/images",
        output_dir: str = "./site/assets/images/gallery",
        workers: int = 4,
    ):
        self.raw_dir = Path(raw_images_dir)
        self.thumb_dir = Path(output_dir) / "thumbs"
        self.full_dir = Path(output_dir) / "full"
        self.workers = workers

        self.thumb_dir.mkdir(parents=True, exist_ok=True)
        self.full_dir.mkdir(parents=True, exist_ok=True)

        # Track what's already processed
        self.manifest_path = Path(output_dir) / "image_manifest.json"
        self.manifest = self._load_manifest()

    def _load_manifest(self) -> dict:
        if self.manifest_path.exists():
            with open(self.manifest_path) as f:
                return json.load(f)
        return {"processed": {}}

    def _save_manifest(self):
        with open(self.manifest_path, "w") as f:
            json.dump(self.manifest, f, indent=2)

    def process_all(self, force: bool = False) -> dict:
        """Process all raw images. Returns stats."""
        sources = list(self.raw_dir.glob("*.jpg")) + \
                  list(self.raw_dir.glob("*.jpeg")) + \
                  list(self.raw_dir.glob("*.png")) + \
                  list(self.raw_dir.glob("*.webp"))

        stats = {"total": len(sources), "processed": 0, "skipped": 0, "errors": 0}

        tasks = []
        for src in sources:
            stem = src.stem
            if not force and stem in self.manifest["processed"]:
                stats["skipped"] += 1
                continue
            tasks.append((str(src), str(self.thumb_dir), str(self.full_dir), stem))

        if not tasks:
            print(f"[thumbs] Nothing to process ({stats['skipped']} already done)")
            return stats

        print(f"[thumbs] Processing {len(tasks)} images with {self.workers} workers...")

        with ProcessPoolExecutor(max_workers=self.workers) as executor:
            futures = {
                executor.submit(process_single_image, *t): t[3]
                for t in tasks
            }

            for future in as_completed(futures):
                stem = futures[future]
                try:
                    result = future.result()
                    if result["error"]:
                        print(f"[thumbs] Error {stem}: {result['error']}")
                        stats["errors"] += 1
                    else:
                        self.manifest["processed"][stem] = result
                        stats["processed"] += 1

                        if stats["processed"] % 100 == 0:
                            print(f"[thumbs] Progress: {stats['processed']}/{len(tasks)}")
                            self._save_manifest()

                except Exception as e:
                    print(f"[thumbs] Worker error {stem}: {e}")
                    stats["errors"] += 1

        self._save_manifest()
        print(f"[thumbs] Done. Processed: {stats['processed']}, "
              f"Skipped: {stats['skipped']}, Errors: {stats['errors']}")
        return stats


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Generate thumbnails and optimized images")
    parser.add_argument("--raw-dir", default="./data/raw/images")
    parser.add_argument("--output-dir", default="./site/assets/images/gallery")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--force", action="store_true")

    args = parser.parse_args()

    processor = ThumbnailProcessor(
        raw_images_dir=args.raw_dir,
        output_dir=args.output_dir,
        workers=args.workers,
    )
    processor.process_all(force=args.force)
