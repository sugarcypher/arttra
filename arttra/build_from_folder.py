#!/usr/bin/env python3
"""
arttra enhanced pipeline — AI upscale + intelligent vectorization.

Drop images into gallery-source/, push, and this script:
  1. AI upscales each image (Real-ESRGAN 4x)
  2. Analyzes image characteristics
  3. Routes to optimal vectorization path
  4. Generates print-ready SVG + web-optimized versions
  5. Builds artworks.json with full metadata

Usage:
  python3 build_from_folder.py --source ../gallery-source --output ..
"""

import json
import os
import re
import math
import hashlib
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
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
# IMAGE ANALYSIS ENGINE
# ═══════════════════════════════════════════════════════════════════

class ImageProfile:
    def __init__(self):
        self.edge_density = 0.0
        self.color_complexity = 0
        self.gradient_ratio = 0.0
        self.detail_frequency = 0.0
        self.contrast_range = 0.0
        self.dominant_colors = []
        self.is_transparent = False
        self.route = "raster"
        self.route_reason = ""

    def to_dict(self):
        return {
            "edge_density": round(self.edge_density, 4),
            "color_complexity": self.color_complexity,
            "gradient_ratio": round(self.gradient_ratio, 4),
            "detail_frequency": round(self.detail_frequency, 4),
            "contrast_range": round(self.contrast_range, 4),
            "route": self.route,
            "route_reason": self.route_reason,
        }


def analyze_image(image_path: str) -> ImageProfile:
    profile = ImageProfile()
    try:
        with Image.open(image_path) as img:
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                profile.is_transparent = True

            rgb = img.convert("RGB")
            small = rgb.resize((300, 300), Image.LANCZOS)

            # Edge density
            edges = small.filter(ImageFilter.FIND_EDGES)
            edge_stat = ImageStat.Stat(edges)
            profile.edge_density = sum(edge_stat.mean) / (3 * 255)

            # Color complexity
            quantized = small.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
            profile.color_complexity = len(set(quantized.getdata()))

            # Gradient ratio
            pixels = list(small.getdata())
            posterized_pixels = [((r >> 5) << 5, (g >> 5) << 5, (b >> 5) << 5) for r, g, b in pixels]
            poster_img = Image.new("RGB", small.size)
            poster_img.putdata(posterized_pixels)
            diff_pixels = list(zip(small.getdata(), poster_img.getdata()))
            total_diff = sum(abs(r1-r2) + abs(g1-g2) + abs(b1-b2) for (r1,g1,b1),(r2,g2,b2) in diff_pixels)
            max_possible = len(diff_pixels) * 3 * 255
            profile.gradient_ratio = total_diff / max_possible if max_possible > 0 else 0

            # Detail frequency
            detail = small.filter(ImageFilter.Kernel(
                size=(3, 3), kernel=[-1,-1,-1,-1,8,-1,-1,-1,-1], scale=1, offset=128))
            profile.detail_frequency = ImageStat.Stat(detail).stddev[0] / 128.0

            # Contrast range
            stat = ImageStat.Stat(small)
            lum_min = min(stat.extrema[i][0] for i in range(3))
            lum_max = max(stat.extrema[i][1] for i in range(3))
            profile.contrast_range = (lum_max - lum_min) / 255.0

            profile.dominant_colors = extract_colors(image_path)

    except Exception as e:
        profile.route_reason = f"Analysis failed: {e}"
        return profile

    return route_vectorization(profile)


def route_vectorization(profile: ImageProfile) -> ImageProfile:
    high_edges = profile.edge_density > EDGE_DENSITY_THRESHOLD
    low_colors = profile.color_complexity < COLOR_COMPLEXITY_THRESHOLD
    high_gradients = profile.gradient_ratio > GRADIENT_RATIO_THRESHOLD
    high_detail = profile.detail_frequency > 0.5

    if high_edges and low_colors and not high_gradients:
        profile.route = "vector"
        profile.route_reason = (
            f"Clean edges ({profile.edge_density:.3f}), "
            f"low colors ({profile.color_complexity}), "
            f"minimal gradients ({profile.gradient_ratio:.3f})")
    elif high_edges and not high_gradients and not high_detail:
        profile.route = "vector"
        profile.route_reason = (
            f"Strong edges ({profile.edge_density:.3f}) with manageable detail")
    elif high_gradients and high_detail:
        profile.route = "raster"
        profile.route_reason = (
            f"Rich gradients ({profile.gradient_ratio:.3f}), "
            f"high detail ({profile.detail_frequency:.3f})")
    elif high_edges and high_gradients:
        profile.route = "hybrid"
        profile.route_reason = (
            f"Mixed: edges ({profile.edge_density:.3f}) "
            f"+ gradients ({profile.gradient_ratio:.3f})")
    elif low_colors:
        profile.route = "vector"
        profile.route_reason = f"Low palette ({profile.color_complexity} colors)"
    else:
        profile.route = "raster"
        profile.route_reason = (
            f"Complex (colors={profile.color_complexity}, "
            f"gradient={profile.gradient_ratio:.3f})")

    return profile


# ═══════════════════════════════════════════════════════════════════
# AI UPSCALING
# ═══════════════════════════════════════════════════════════════════

def setup_realesrgan(bin_dir: str) -> Optional[str]:
    bin_path = Path(bin_dir)
    bin_path.mkdir(parents=True, exist_ok=True)
    executable = bin_path / "realesrgan-ncnn-vulkan"
    if executable.exists():
        return str(executable)

    import platform
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "linux" and machine in ("x86_64", "amd64"):
        url = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip"
    elif system == "darwin":
        url = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip"
    else:
        print(f"[upscale] No binary for {system}/{machine}")
        return None

    zip_path = bin_path / "realesrgan.zip"
    print(f"[upscale] Downloading Real-ESRGAN...")
    try:
        import urllib.request
        urllib.request.urlretrieve(url, str(zip_path))
        import zipfile
        with zipfile.ZipFile(str(zip_path), 'r') as z:
            z.extractall(str(bin_path))
        for f in bin_path.rglob("realesrgan-ncnn-vulkan"):
            os.chmod(str(f), 0o755)
            model_dir = f.parent / "models"
            if model_dir.exists():
                target_models = bin_path / "models"
                if not target_models.exists():
                    shutil.copytree(str(model_dir), str(target_models))
            if f != executable:
                shutil.copy2(str(f), str(executable))
                os.chmod(str(executable), 0o755)
            print(f"[upscale] Real-ESRGAN ready")
            return str(executable)
    except Exception as e:
        print(f"[upscale] Download failed: {e}")
    return None


def upscale_image(executable: str, input_path: str, output_path: str, scale: int = 4) -> bool:
    try:
        models_dir = str(Path(executable).parent / "models")
        cmd = [executable, "-i", input_path, "-o", output_path, "-s", str(scale), "-n", "realesrgan-x4plus"]
        if os.path.isdir(models_dir):
            cmd.extend(["-m", models_dir])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            print(f"  [upscale] stderr: {result.stderr[:200]}")
            return False
        return os.path.exists(output_path)
    except Exception as e:
        print(f"  [upscale] Error: {e}")
        return False


def upscale_with_pillow(input_path: str, output_path: str, target_long_edge: int) -> bool:
    try:
        with Image.open(input_path) as img:
            img = img.convert("RGB")
            w, h = img.size
            current_long = max(w, h)
            if current_long >= target_long_edge:
                enhanced = img.copy()
            else:
                ratio = target_long_edge / current_long
                enhanced = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
            enhanced = enhanced.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=3))
            enhanced = ImageEnhance.Contrast(enhanced).enhance(1.03)
            enhanced = ImageEnhance.Sharpness(enhanced).enhance(1.1)
            enhanced.save(output_path, "PNG", optimize=True)
            return True
    except Exception as e:
        print(f"  [upscale-fallback] Error: {e}")
        return False


# ═══════════════════════════════════════════════════════════════════
# VECTORIZATION
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
        except Exception as e:
            print(f"[vector] vtracer install failed: {e}")
            return False


def vectorize_true(input_path: str, output_path: str, color_precision: int = 6) -> bool:
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
    except Exception as e:
        print(f"  [vector] vtracer failed: {e}")
        return False


def vectorize_hybrid(input_path: str, svg_output: str) -> bool:
    try:
        import vtracer
        import base64

        # Aggressive vector pass
        vector_svg = svg_output + ".tmp.svg"
        vtracer.convert_image_to_svg_py(
            input_path, vector_svg,
            colormode="color", hierarchical="stacked", mode="spline",
            filter_speckle=8, color_precision=4, layer_difference=32,
            corner_threshold=60, length_threshold=6.0, max_iterations=10,
            splice_threshold=45, path_precision=2)

        with Image.open(input_path) as img:
            w, h = img.size

        with open(input_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()

        ext = Path(input_path).suffix.lower().lstrip(".")
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "webp": "image/webp"}.get(ext, "image/png")

        # Read vector paths
        with open(vector_svg) as f:
            vec_content = f.read()
        # Extract just the path elements
        import re as _re
        paths = _re.findall(r'<path[^>]*/?>', vec_content)
        paths_str = "\n    ".join(paths[:500])  # cap to avoid massive files

        hybrid_svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 {w} {h}" width="{w}" height="{h}">
  <title>arttra.art hybrid vector/raster</title>
  <image width="{w}" height="{h}" href="data:{mime};base64,{img_b64}"
         preserveAspectRatio="xMidYMid meet" />
  <g id="vector-paths" opacity="0">
    {paths_str}
  </g>
</svg>'''

        with open(svg_output, "w") as f:
            f.write(hybrid_svg)

        os.remove(vector_svg)
        return True
    except Exception as e:
        print(f"  [hybrid] Failed: {e}")
        return vectorize_raster_svg(input_path, svg_output)


def vectorize_raster_svg(input_path: str, svg_output: str) -> bool:
    try:
        import base64
        with Image.open(input_path) as img:
            w, h = img.size

        with open(input_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()

        ext = Path(input_path).suffix.lower().lstrip(".")
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "webp": "image/webp"}.get(ext, "image/png")

        width_in = w / 300
        height_in = h / 300

        svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 {w} {h}" width="{width_in:.2f}in" height="{height_in:.2f}in">
  <title>arttra.art print-ready</title>
  <desc>{w}x{h}px @ 300dpi = {width_in:.1f}x{height_in:.1f}in</desc>
  <image width="{w}" height="{h}" href="data:{mime};base64,{img_b64}"
         preserveAspectRatio="xMidYMid meet" image-rendering="optimizeQuality" />
</svg>'''

        with open(svg_output, "w") as f:
            f.write(svg)
        return True
    except Exception as e:
        print(f"  [raster-svg] Failed: {e}")
        return False


# ═══════════════════════════════════════════════════════════════════
# ART OPTIMIZATION + SIZE STANDARDIZATION
# ═══════════════════════════════════════════════════════════════════

def optimize_for_art(image_path: str, output_path: str) -> bool:
    try:
        with Image.open(image_path) as img:
            img = img.convert("RGB")
            img = img.filter(ImageFilter.UnsharpMask(radius=1.5, percent=120, threshold=3))
            img = ImageEnhance.Contrast(img).enhance(1.04)
            img = ImageEnhance.Color(img).enhance(1.05)
            img.save(output_path, "PNG", optimize=True)
            return True
    except Exception as e:
        print(f"  [optimize] Error: {e}")
        return False


def standardize_size(image_path: str, output_path: str, long_edge: int = PRINT_LONG_EDGE) -> bool:
    try:
        with Image.open(image_path) as img:
            img = img.convert("RGB")
            w, h = img.size
            if max(w, h) == long_edge:
                shutil.copy2(image_path, output_path)
                return True
            ratio = long_edge / max(w, h)
            resized = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
            resized.save(output_path, "PNG", optimize=True)
            return True
    except Exception as e:
        print(f"  [standardize] Error: {e}")
        return False


# ═══════════════════════════════════════════════════════════════════
# COLOR + METADATA
# ═══════════════════════════════════════════════════════════════════

def extract_colors(image_path: str, n: int = 4) -> list:
    try:
        with Image.open(image_path) as img:
            img = img.convert("RGB").resize((150, 150), Image.LANCZOS)
            q = img.quantize(colors=n, method=Image.Quantize.MEDIANCUT)
            pal = q.getpalette()
            return [f"#{pal[i*3]:02x}{pal[i*3+1]:02x}{pal[i*3+2]:02x}" for i in range(n)]
    except Exception:
        return ["#333333", "#666666", "#999999", "#cccccc"]


def infer_style(filename: str) -> str:
    text = filename.lower().replace("-", " ").replace("_", " ")
    scores = {}
    for style, keywords in STYLE_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in text)
        if score > 0:
            scores[style] = score
    return max(scores, key=scores.get) if scores else "Metal Art"


def filename_to_title(stem: str) -> str:
    clean = re.sub(r'^(IMG|DSC|DCIM|Photo|Screenshot|Screen Shot)[-_ ]?', '', stem, flags=re.IGNORECASE)
    clean = re.sub(r'[-_]+', ' ', clean)
    clean = re.sub(r'^\d+$', '', clean).strip()
    return clean.title() if len(clean) >= 2 else f"Untitled ({stem[:12]})"


def generate_web_versions(print_path: str, thumb_dir: str, web_dir: str, stem: str) -> dict:
    result = {"thumb": None, "web": None, "error": None}
    try:
        with Image.open(print_path) as img:
            img = img.convert("RGB")
            w, h = img.size

            th = int(h * (THUMB_WIDTH / w))
            thumb = img.resize((THUMB_WIDTH, th), Image.LANCZOS)
            thumb = thumb.filter(ImageFilter.UnsharpMask(radius=0.5, percent=80, threshold=3))
            thumb_path = Path(thumb_dir) / f"thumb_{stem}.webp"
            thumb.save(str(thumb_path), "WEBP", quality=THUMB_QUALITY, optimize=True)
            result["thumb"] = thumb_path.name

            if max(w, h) > WEB_MAX_DIMENSION:
                ratio = WEB_MAX_DIMENSION / max(w, h)
                web = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
            else:
                web = img.copy()
            web_path = Path(web_dir) / f"{stem}.webp"
            web.save(str(web_path), "WEBP", quality=WEBP_QUALITY, optimize=True)
            result["web"] = web_path.name

            jpg_path = Path(web_dir) / f"{stem}.jpg"
            web.save(str(jpg_path), "JPEG", quality=WEBP_QUALITY, optimize=True)
    except Exception as e:
        result["error"] = str(e)
    return result


# ═══════════════════════════════════════════════════════════════════
# MAIN PIPELINE
# ═══════════════════════════════════════════════════════════════════

def build(source_dir: str, output_root: str, workers: int = 4):
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

    print(f"[build] Found {len(images)} images")
    print("=" * 60)

    gallery_dir = output / "assets" / "images" / "gallery"
    thumb_dir = gallery_dir / "thumbs"
    web_dir = gallery_dir / "web"
    print_dir = gallery_dir / "print"
    vector_dir = gallery_dir / "vector"
    work_dir = output / ".arttra-work"
    data_dir = output / "data"

    for d in [thumb_dir, web_dir, print_dir, vector_dir, work_dir, data_dir]:
        d.mkdir(parents=True, exist_ok=True)

    manifest_path = data_dir / "build_manifest.json"
    manifest = {}
    if manifest_path.exists():
        with open(manifest_path) as f:
            manifest = json.load(f)

    esrgan_path = setup_realesrgan(str(work_dir / "realesrgan"))
    has_vtracer = setup_vtracer()

    artworks = []

    for i, img_path in enumerate(images):
        stem = img_path.stem
        stable_id = hashlib.md5(img_path.name.encode()).hexdigest()[:8].upper()
        file_hash = hashlib.md5(open(img_path, "rb").read()).hexdigest()

        if stem in manifest and manifest[stem].get("hash") == file_hash:
            print(f"\n[{i+1}/{len(images)}] {img_path.name} — cached")
            if "artwork" in manifest[stem]:
                artworks.append(manifest[stem]["artwork"])
            continue

        print(f"\n[{i+1}/{len(images)}] {img_path.name}")

        # Analyze
        profile = analyze_image(str(img_path))
        print(f"  Route: {profile.route} — {profile.route_reason}")

        # Upscale
        upscaled_path = str(work_dir / f"{stem}_up.png")
        up_ok = False
        if esrgan_path:
            print(f"  AI upscaling (Real-ESRGAN 4x)...")
            up_ok = upscale_image(esrgan_path, str(img_path), upscaled_path)
        if not up_ok:
            print(f"  Pillow upscale fallback...")
            up_ok = upscale_with_pillow(str(img_path), upscaled_path, PRINT_LONG_EDGE)
        if not up_ok:
            print(f"  SKIP — upscale failed")
            continue

        # Optimize
        opt_path = str(work_dir / f"{stem}_opt.png")
        if not optimize_for_art(upscaled_path, opt_path):
            opt_path = upscaled_path

        # Standardize
        print_path = str(print_dir / f"{stem}.png")
        if not standardize_size(opt_path, print_path):
            continue

        # Vectorize
        svg_path = str(vector_dir / f"{stem}.svg")
        print(f"  Vectorizing ({profile.route})...")
        if profile.route == "vector" and has_vtracer:
            if not vectorize_true(print_path, svg_path):
                vectorize_raster_svg(print_path, svg_path)
        elif profile.route == "hybrid" and has_vtracer:
            if not vectorize_hybrid(print_path, svg_path):
                vectorize_raster_svg(print_path, svg_path)
        else:
            vectorize_raster_svg(print_path, svg_path)

        # Web versions
        web_result = generate_web_versions(print_path, str(thumb_dir), str(web_dir), stem)

        # Metadata
        style = infer_style(stem)
        colors = profile.dominant_colors or extract_colors(str(img_path))
        title = filename_to_title(stem)
        sku = f"ART-{stable_id}"

        try:
            with Image.open(print_path) as pimg:
                pw, ph = pimg.size
        except Exception:
            pw = ph = 0

        artwork = {
            "id": sku,
            "sku": sku,
            "title": title,
            "description": "",
            "style": style,
            "mood": MOOD_MAP.get(style, "Contemporary"),
            "roomFit": ROOM_MAP.get(style, ["Living Room"]),
            "colorPalette": colors,
            "bestProducts": BEST_PRODUCTS[:3],
            "seoKeywords": ["arttra", style.lower(), "wall art", "contemporary", "handmade", "original art"],
            "priceTiers": DEFAULT_PRICE.copy(),
            "thumb": f"./assets/images/gallery/thumbs/{web_result['thumb']}" if web_result["thumb"] else "",
            "image": f"./assets/images/gallery/web/{web_result['web']}" if web_result["web"] else "",
            "printFile": f"./assets/images/gallery/print/{stem}.png",
            "vectorFile": f"./assets/images/gallery/vector/{stem}.svg",
            "printDimensions": {
                "widthInches": round(pw / 300, 1) if pw else 0,
                "heightInches": round(ph / 300, 1) if ph else 0,
                "dpi": 300, "pixelWidth": pw, "pixelHeight": ph,
            },
            "vectorRoute": profile.route,
            "imageProfile": profile.to_dict(),
            "buyUrl": "#",
            "sourceFile": img_path.name,
            "timestamp": datetime.fromtimestamp(img_path.stat().st_mtime).isoformat(),
        }

        artworks.append(artwork)
        manifest[stem] = {
            "hash": file_hash, "route": profile.route,
            "artwork": artwork, "processed_at": datetime.utcnow().isoformat(),
        }

        print(f"  Done — {profile.route} | {pw}x{ph}px | {pw/300:.1f}x{ph/300:.1f}in")

    artworks.sort(key=lambda a: a.get("timestamp", ""), reverse=True)

    with open(data_dir / "artworks.json", "w") as f:
        json.dump(artworks, f, indent=2)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    shutil.rmtree(str(work_dir), ignore_errors=True)

    print(f"\n{'='*60}")
    print(f"[build] Complete: {len(artworks)} artworks")
    print(f"{'='*60}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="arttra.art enhanced build pipeline")
    parser.add_argument("--source", default="../gallery-source", help="Source images folder")
    parser.add_argument("--output", default="..", help="Output root (repo root)")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    build(args.source, args.output, args.workers)
