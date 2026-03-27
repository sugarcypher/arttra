#!/usr/bin/env python3
"""
arttra fast pipeline — Pillow upscale + intelligent vectorization.

Drop images into gallery-source/, push, and this script:
  1. Upscales each image to print resolution (Pillow Lanczos)
  2. Analyzes image characteristics
  3. Routes to optimal vectorization path (true vector / hybrid / raster-in-SVG)
  4. Generates print-ready output + web-optimized versions
  5. Builds artworks.json with full metadata

Processes ~100 images in minutes, not hours.

Usage:
  python3 build_from_folder.py --source ../gallery-source --output ..
"""

import json
import os
import re
import hashlib
import shutil
import subprocess
import sys
import base64
from datetime import datetime
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Optional

try:
    from PIL import Image, ImageFilter, ImageEnhance, ImageStat
except ImportError:
    raise ImportError("Pillow is required: pip install Pillow")


# ── Config ──────────────────────────────────────────────────────────

PRINT_LONG_EDGE = 6000
THUMB_WIDTH = 400
WEB_MAX_DIMENSION = 2000
WEBP_QUALITY = 85
THUMB_QUALITY = 75
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp"}
MAX_WORKERS = 4

EDGE_DENSITY_THRESHOLD = 0.15
COLOR_COMPLEXITY_THRESHOLD = 64
GRADIENT_RATIO_THRESHOLD = 0.40

STYLE_KEYWORDS = {
    "Abstract": ["abstract", "expressionism", "gestural"],
    "Geometric": ["geometric", "geometry", "shapes", "pattern"],
    "Floral": ["floral", "botanical", "flower", "bloom", "plant"],
    "Minimal": ["minimal", "minimalist", "simple", "clean"],
    "Landscape": ["landscape", "scenery", "mountain", "ocean", "sky"],
    "Digital": ["digital", "generative", "glitch", "nft"],
    "Mixed Media": ["mixed", "collage", "assemblage"],
    "Photography": ["photo", "film", "street"],
    "Metal Art": ["metal", "steel", "iron", "laser", "cut"],
}

MOOD_MAP = {
    "Abstract": "Expressive / Bold",
    "Geometric": "Structured / Modern",
    "Floral": "Natural / Soft",
    "Minimal": "Calm / Clean",
    "Landscape": "Expansive / Serene",
    "Digital": "Futuristic / Dynamic",
    "Mixed Media": "Layered / Textural",
    "Photography": "Documentary / Raw",
    "Metal Art": "Industrial / Sculptural",
}

ROOM_MAP = {
    "Abstract": ["Living Room", "Office", "Bedroom"],
    "Geometric": ["Office", "Kitchen", "Entryway"],
    "Floral": ["Bedroom", "Bathroom", "Dining Room"],
    "Minimal": ["Office", "Hallway", "Living Room"],
    "Landscape": ["Living Room", "Bedroom", "Dining Room"],
    "Digital": ["Office", "Studio", "Living Room"],
    "Mixed Media": ["Living Room", "Studio", "Entryway"],
    "Photography": ["Hallway", "Office", "Living Room"],
    "Metal Art": ["Living Room", "Entryway", "Office"],
}

BEST_PRODUCTS = ["Framed Print", "Canvas", "Metal Print", "Acrylic", "Poster"]
DEFAULT_PRICE = {"startingPrice": 79}


# ═══════════════════════════════════════════════════════════════════
# IMAGE ANALYSIS — runs per-image, determines vector routing
# ═══════════════════════════════════════════════════════════════════

def analyze_image(image_path: str) -> dict:
    """Analyze image and return profile dict with routing decision."""
    profile = {
        "edge_density": 0.0, "color_complexity": 0,
        "gradient_ratio": 0.0, "detail_frequency": 0.0,
        "contrast_range": 0.0, "route": "raster", "route_reason": "",
    }
    try:
        with Image.open(image_path) as img:
            rgb = img.convert("RGB")
            small = rgb.resize((300, 300), Image.LANCZOS)

            edges = small.filter(ImageFilter.FIND_EDGES)
            edge_stat = ImageStat.Stat(edges)
            profile["edge_density"] = sum(edge_stat.mean) / (3 * 255)

            quantized = small.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
            profile["color_complexity"] = len(set(quantized.getdata()))

            pixels = list(small.getdata())
            posterized = [((r >> 5) << 5, (g >> 5) << 5, (b >> 5) << 5) for r, g, b in pixels]
            poster_img = Image.new("RGB", small.size)
            poster_img.putdata(posterized)
            diff_pixels = list(zip(small.getdata(), poster_img.getdata()))
            total_diff = sum(abs(r1-r2)+abs(g1-g2)+abs(b1-b2) for (r1,g1,b1),(r2,g2,b2) in diff_pixels)
            max_possible = len(diff_pixels) * 3 * 255
            profile["gradient_ratio"] = total_diff / max_possible if max_possible else 0

            detail = small.filter(ImageFilter.Kernel(
                size=(3,3), kernel=[-1,-1,-1,-1,8,-1,-1,-1,-1], scale=1, offset=128))
            profile["detail_frequency"] = ImageStat.Stat(detail).stddev[0] / 128.0

            stat = ImageStat.Stat(small)
            lum_min = min(stat.extrema[i][0] for i in range(3))
            lum_max = max(stat.extrema[i][1] for i in range(3))
            profile["contrast_range"] = (lum_max - lum_min) / 255.0

    except Exception as e:
        profile["route_reason"] = f"Analysis failed: {e}"
        return profile

    # Route decision
    he = profile["edge_density"] > EDGE_DENSITY_THRESHOLD
    lc = profile["color_complexity"] < COLOR_COMPLEXITY_THRESHOLD
    hg = profile["gradient_ratio"] > GRADIENT_RATIO_THRESHOLD
    hd = profile["detail_frequency"] > 0.5

    if he and lc and not hg:
        profile["route"] = "vector"
        profile["route_reason"] = f"Clean edges, low colors ({profile['color_complexity']})"
    elif he and not hg and not hd:
        profile["route"] = "vector"
        profile["route_reason"] = f"Strong edges, manageable detail"
    elif hg and hd:
        profile["route"] = "raster"
        profile["route_reason"] = f"Rich gradients + high detail"
    elif he and hg:
        profile["route"] = "hybrid"
        profile["route_reason"] = f"Edges + gradients mixed"
    elif lc:
        profile["route"] = "vector"
        profile["route_reason"] = f"Low palette ({profile['color_complexity']} colors)"
    else:
        profile["route"] = "raster"
        profile["route_reason"] = f"Complex image"

    for k in ["edge_density", "gradient_ratio", "detail_frequency", "contrast_range"]:
        profile[k] = round(profile[k], 4)

    return profile


def extract_colors(image_path: str, n: int = 4) -> list:
    try:
        with Image.open(image_path) as img:
            img = img.convert("RGB").resize((150, 150), Image.LANCZOS)
            q = img.quantize(colors=n, method=Image.Quantize.MEDIANCUT)
            pal = q.getpalette()
            return [f"#{pal[i*3]:02x}{pal[i*3+1]:02x}{pal[i*3+2]:02x}" for i in range(n)]
    except Exception:
        return ["#333333", "#666666", "#999999", "#cccccc"]


# ═══════════════════════════════════════════════════════════════════
# SINGLE IMAGE PROCESSOR — runs in parallel
# ═══════════════════════════════════════════════════════════════════

def process_single(args: tuple) -> Optional[dict]:
    """Process one image end-to-end. Designed for ProcessPoolExecutor."""
    img_path_str, thumb_dir, web_dir, print_dir, vector_dir, has_vtracer = args
    img_path = Path(img_path_str)
    stem = img_path.stem
    stable_id = hashlib.md5(img_path.name.encode()).hexdigest()[:8].upper()

    try:
        # ── Analyze ──
        profile = analyze_image(str(img_path))
        colors = extract_colors(str(img_path))

        # ── Upscale + optimize + standardize (single pass) ──
        with Image.open(str(img_path)) as img:
            img = img.convert("RGB")
            w, h = img.size
            current_long = max(w, h)

            # Upscale to print resolution
            if current_long < PRINT_LONG_EDGE:
                ratio = PRINT_LONG_EDGE / current_long
                img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
            elif current_long > PRINT_LONG_EDGE:
                ratio = PRINT_LONG_EDGE / current_long
                img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

            # Art optimization
            img = img.filter(ImageFilter.UnsharpMask(radius=1.5, percent=120, threshold=3))
            img = ImageEnhance.Contrast(img).enhance(1.04)
            img = ImageEnhance.Color(img).enhance(1.05)

            pw, ph = img.size

            # Save print version
            print_path = Path(print_dir) / f"{stem}.png"
            img.save(str(print_path), "PNG", optimize=True)

            # ── Thumbnail ──
            th = int(ph * (THUMB_WIDTH / pw))
            thumb = img.resize((THUMB_WIDTH, th), Image.LANCZOS)
            thumb = thumb.filter(ImageFilter.UnsharpMask(radius=0.5, percent=80, threshold=3))
            thumb_path = Path(thumb_dir) / f"thumb_{stem}.webp"
            thumb.save(str(thumb_path), "WEBP", quality=THUMB_QUALITY, optimize=True)

            # ── Web version ──
            if max(pw, ph) > WEB_MAX_DIMENSION:
                ratio = WEB_MAX_DIMENSION / max(pw, ph)
                web = img.resize((int(pw * ratio), int(ph * ratio)), Image.LANCZOS)
            else:
                web = img.copy()
            web_webp = Path(web_dir) / f"{stem}.webp"
            web.save(str(web_webp), "WEBP", quality=WEBP_QUALITY, optimize=True)
            web_jpg = Path(web_dir) / f"{stem}.jpg"
            web.save(str(web_jpg), "JPEG", quality=WEBP_QUALITY, optimize=True)

        # ── Vectorize ──
        svg_path = str(Path(vector_dir) / f"{stem}.svg")
        route = profile["route"]

        if route == "vector" and has_vtracer:
            if not _vectorize_true(str(print_path), svg_path):
                _vectorize_raster_svg(str(print_path), svg_path, pw, ph)
        elif route == "hybrid" and has_vtracer:
            if not _vectorize_true(str(print_path), svg_path, color_precision=4):
                _vectorize_raster_svg(str(print_path), svg_path, pw, ph)
        else:
            _vectorize_raster_svg(str(print_path), svg_path, pw, ph)

        # ── Metadata ──
        style = _infer_style(stem)
        title = _filename_to_title(stem)
        sku = f"ART-{stable_id}"

        return {
            "id": sku, "sku": sku,
            "title": title, "description": "",
            "style": style,
            "mood": MOOD_MAP.get(style, "Contemporary"),
            "roomFit": ROOM_MAP.get(style, ["Living Room"]),
            "colorPalette": colors,
            "bestProducts": BEST_PRODUCTS[:3],
            "seoKeywords": ["arttra", style.lower(), "wall art", "contemporary", "handmade", "original art"],
            "priceTiers": DEFAULT_PRICE.copy(),
            "thumb": f"./assets/images/gallery/thumbs/thumb_{stem}.webp",
            "image": f"./assets/images/gallery/web/{stem}.webp",
            "printFile": f"./assets/images/gallery/print/{stem}.png",
            "vectorFile": f"./assets/images/gallery/vector/{stem}.svg",
            "printDimensions": {
                "widthInches": round(pw / 300, 1),
                "heightInches": round(ph / 300, 1),
                "dpi": 300, "pixelWidth": pw, "pixelHeight": ph,
            },
            "vectorRoute": route,
            "imageProfile": profile,
            "buyUrl": "#",
            "sourceFile": img_path.name,
            "timestamp": datetime.fromtimestamp(img_path.stat().st_mtime).isoformat(),
            "_hash": hashlib.md5(open(str(img_path), "rb").read()).hexdigest(),
            "_stem": stem,
        }

    except Exception as e:
        print(f"  [FAIL] {stem}: {e}")
        return None


def _vectorize_true(input_path: str, output_path: str, color_precision: int = 6) -> bool:
    try:
        import vtracer
        vtracer.convert_image_to_svg_py(
            input_path, output_path,
            colormode="color", hierarchical="stacked", mode="spline",
            filter_speckle=4, color_precision=color_precision,
            layer_difference=16, corner_threshold=60,
            length_threshold=4.0, max_iterations=10,
            splice_threshold=45, path_precision=3)
        return os.path.exists(output_path)
    except Exception:
        return False


def _vectorize_raster_svg(input_path: str, svg_output: str, w: int, h: int) -> bool:
    try:
        with open(input_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()
        ext = Path(input_path).suffix.lower().lstrip(".")
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "webp": "image/webp"}.get(ext, "image/png")
        wi, hi = w / 300, h / 300
        svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{wi:.2f}in" height="{hi:.2f}in">
  <desc>{w}x{h}px @ 300dpi = {wi:.1f}x{hi:.1f}in</desc>
  <image width="{w}" height="{h}" href="data:{mime};base64,{img_b64}"
         preserveAspectRatio="xMidYMid meet" image-rendering="optimizeQuality" />
</svg>'''
        with open(svg_output, "w") as f:
            f.write(svg)
        return True
    except Exception:
        return False


def _infer_style(filename: str) -> str:
    text = filename.lower().replace("-", " ").replace("_", " ")
    scores = {}
    for style, keywords in STYLE_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in text)
        if score > 0:
            scores[style] = score
    return max(scores, key=scores.get) if scores else "Metal Art"


def _filename_to_title(stem: str) -> str:
    clean = re.sub(r'^(IMG|DSC|DCIM|Photo|Screenshot|Screen Shot)[-_ ]?', '', stem, flags=re.IGNORECASE)
    clean = re.sub(r'[-_]+', ' ', clean)
    clean = re.sub(r'^\d+$', '', clean).strip()
    return clean.title() if len(clean) >= 2 else f"Untitled ({stem[:12]})"


# ═══════════════════════════════════════════════════════════════════
# VTRACER SETUP
# ═══════════════════════════════════════════════════════════════════

def setup_vtracer() -> bool:
    try:
        import vtracer as _
        return True
    except ImportError:
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "vtracer", "--break-system-packages"],
                capture_output=True, check=True)
            return True
        except Exception:
            return False


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def build(source_dir: str, output_root: str, workers: int = MAX_WORKERS):
    source = Path(source_dir)
    output = Path(output_root)

    if not source.exists():
        print(f"[build] Source folder not found: {source}")
        return

    images = sorted([
        f for f in source.iterdir()
        if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS
    ])

    if not images:
        print(f"[build] No images found in {source}")
        return

    # Output directories
    gallery_dir = output / "assets" / "images" / "gallery"
    thumb_dir = gallery_dir / "thumbs"
    web_dir = gallery_dir / "web"
    print_dir = gallery_dir / "print"
    vector_dir = gallery_dir / "vector"
    data_dir = output / "data"

    for d in [thumb_dir, web_dir, print_dir, vector_dir, data_dir]:
        d.mkdir(parents=True, exist_ok=True)

    # Load manifest for caching
    manifest_path = data_dir / "build_manifest.json"
    manifest = {}
    if manifest_path.exists():
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}

    # Filter to only new/changed images
    to_process = []
    cached_artworks = []
    for img_path in images:
        stem = img_path.stem
        file_hash = hashlib.md5(open(img_path, "rb").read()).hexdigest()
        if stem in manifest and manifest[stem].get("hash") == file_hash:
            if "artwork" in manifest[stem]:
                cached_artworks.append(manifest[stem]["artwork"])
            continue
        to_process.append(img_path)

    print(f"[build] {len(images)} total images, {len(cached_artworks)} cached, {len(to_process)} to process")

    if not to_process and cached_artworks:
        # Nothing new — just write existing artworks.json
        cached_artworks.sort(key=lambda a: a.get("timestamp", ""), reverse=True)
        with open(data_dir / "artworks.json", "w") as f:
            json.dump(cached_artworks, f, indent=2)
        print(f"[build] No new images. artworks.json up to date.")
        return

    has_vtracer = setup_vtracer()
    print(f"[build] vtracer: {'yes' if has_vtracer else 'no (raster-in-SVG fallback)'}")
    print(f"[build] Processing {len(to_process)} images with {workers} workers...")

    # Parallel processing
    tasks = [
        (str(p), str(thumb_dir), str(web_dir), str(print_dir), str(vector_dir), has_vtracer)
        for p in to_process
    ]

    new_artworks = []
    with ProcessPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(process_single, t): t[0] for t in tasks}
        done = 0
        for future in as_completed(futures):
            done += 1
            src = Path(futures[future]).name
            try:
                result = future.result()
                if result:
                    stem = result.pop("_stem")
                    file_hash = result.pop("_hash")
                    new_artworks.append(result)
                    manifest[stem] = {"hash": file_hash, "artwork": result, "route": result["vectorRoute"]}
                    print(f"  [{done}/{len(to_process)}] {src} — {result['vectorRoute']}")
                else:
                    print(f"  [{done}/{len(to_process)}] {src} — FAILED")
            except Exception as e:
                print(f"  [{done}/{len(to_process)}] {src} — ERROR: {e}")

    # Combine cached + new
    all_artworks = cached_artworks + new_artworks
    all_artworks.sort(key=lambda a: a.get("timestamp", ""), reverse=True)

    with open(data_dir / "artworks.json", "w") as f:
        json.dump(all_artworks, f, indent=2)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\n{'='*60}")
    print(f"[build] Complete: {len(all_artworks)} artworks ({len(new_artworks)} new, {len(cached_artworks)} cached)")
    print(f"{'='*60}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="arttra.art fast build pipeline")
    parser.add_argument("--source", default="../gallery-source", help="Source images folder")
    parser.add_argument("--output", default="..", help="Output root (repo root)")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = parser.parse_args()
    build(args.source, args.output, args.workers)
