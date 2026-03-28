#!/usr/bin/env python3
"""
arttra enhanced pipeline v2 — image analysis, archaic naming, intelligent classification.

Drop images into gallery-source/, push, GitHub Actions processes everything.
"""

import json
import os
import re
import hashlib
import shutil
import subprocess
import sys
import base64
import random
import colorsys
from datetime import datetime
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Optional

try:
    from PIL import Image, ImageFilter, ImageEnhance, ImageStat, ImageDraw, ImageFont
    from PIL.ExifTags import Base as ExifBase
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

BEST_PRODUCTS = ["Framed Print", "Canvas", "Metal Print", "Acrylic", "Poster"]
DEFAULT_PRICE = {"startingPrice": 79}


# ═══════════════════════════════════════════════════════════════════
# ARCHAIC NAMING ENGINE
# ═══════════════════════════════════════════════════════════════════

# Word pools organized by image temperature/mood
DARK_PREFIX = [
    "Nyx", "Umbra", "Vesper", "Corvid", "Wraith", "Grimshaw", "Dirge",
    "Morrigan", "Tenebris", "Nocturne", "Obsidian", "Stygian", "Erebus",
    "Cimmerian", "Phantasm", "Revenant", "Sepulchre", "Eventide",
    "Gloaming", "Penumbral", "Hollowmere", "Ashgrove", "Duskfall",
]

LIGHT_PREFIX = [
    "Lumen", "Aether", "Solace", "Aurelius", "Meridian", "Zenith",
    "Alabast", "Gossamer", "Silvaine", "Ichor", "Halcyon", "Seraphine",
    "Opaline", "Pearlescent", "Glintmere", "Dawnspar", "Lucent",
    "Eidolon", "Luminesce", "Chandral", "Etherveil", "Starhollow",
]

WARM_PREFIX = [
    "Ember", "Forge", "Cinnabar", "Pyralis", "Scoria", "Crucible",
    "Vulcan", "Amaranth", "Carnelian", "Sanguine", "Russet", "Titian",
    "Briarclaw", "Ironbloom", "Copperwynd", "Hearthstone", "Flamecrest",
    "Burnveil", "Ashenmoor", "Blazemark", "Scorchfield", "Kindlemere",
]

COOL_PREFIX = [
    "Glacier", "Boreal", "Fjord", "Rime", "Crysthene", "Cerulean",
    "Lapis", "Cobalt", "Aquiline", "Tidewater", "Northveil", "Frostholme",
    "Wintermere", "Deepcurrent", "Slatewind", "Mistral", "Stormglass",
    "Bluevein", "Shorelight", "Pelagic", "Abyssen", "Harborglass",
]

# Suffix pools organized by structural character
GEOMETRIC_SUFFIX = [
    "Lattice", "Tessera", "Facet", "Shard", "Matrix", "Prism",
    "Axis", "Meridian", "Parallax", "Vertex", "Polygon", "Tangent",
    "Bisect", "Fulcrum", "Keystone", "Capstone", "Lintel",
]

ORGANIC_SUFFIX = [
    "Bloom", "Tendril", "Helix", "Gyre", "Frond", "Rhizome",
    "Mycelium", "Canopy", "Thicket", "Undergrowth", "Lichen",
    "Petalwork", "Branchweave", "Roothold", "Seedvault", "Thornset",
]

MINIMAL_SUFFIX = [
    "Void", "Monolith", "Stele", "Cipher", "Null", "Vestige",
    "Fragment", "Remnant", "Trace", "Echo", "Silhouette", "Outline",
    "Husk", "Threshold", "Margin", "Plane", "Expanse",
]

COMPLEX_SUFFIX = [
    "Labyrinth", "Nexus", "Vortex", "Tangle", "Weave", "Tapestry",
    "Confluence", "Maelstrom", "Chronicle", "Palimpsest", "Mosaic",
    "Kaleidoscope", "Assemblage", "Compendium", "Phantasmagoria",
]


def generate_name(profile: dict, colors: list, seed_str: str) -> str:
    """Generate an archaic/unusual artwork name from image characteristics."""
    rng = random.Random(seed_str)  # deterministic per image

    # Determine temperature from dominant colors
    warmth = _color_warmth(colors)
    brightness = profile.get("contrast_range", 0.5)
    avg_lum = profile.get("avg_luminance", 0.5)

    # Select prefix pool
    if avg_lum < 0.35:
        pool = DARK_PREFIX
    elif warmth > 0.6:
        pool = WARM_PREFIX
    elif warmth < 0.4:
        pool = COOL_PREFIX
    else:
        pool = LIGHT_PREFIX

    # Select suffix pool
    edge = profile.get("edge_density", 0)
    detail = profile.get("detail_frequency", 0)
    cc = profile.get("color_complexity", 128)

    if edge > 0.15 and cc < 80:
        spool = GEOMETRIC_SUFFIX
    elif detail > 0.5 and cc > 150:
        spool = COMPLEX_SUFFIX
    elif cc < 50:
        spool = MINIMAL_SUFFIX
    else:
        spool = ORGANIC_SUFFIX

    prefix = rng.choice(pool)
    suffix = rng.choice(spool)

    return f"{prefix} {suffix}"


def _color_warmth(hex_colors: list) -> float:
    """0.0 = cool, 1.0 = warm. Average across palette."""
    if not hex_colors:
        return 0.5
    warmths = []
    for hx in hex_colors:
        try:
            hx = hx.lstrip("#")
            r, g, b = int(hx[:2], 16), int(hx[2:4], 16), int(hx[4:], 16)
            # Warm = red/yellow dominant, cool = blue/green dominant
            warmth = (r * 1.2 + g * 0.5) / (r + g + b + 1) if (r + g + b) > 0 else 0.5
            warmths.append(min(warmth, 1.0))
        except Exception:
            warmths.append(0.5)
    return sum(warmths) / len(warmths)


# ═══════════════════════════════════════════════════════════════════
# COLOR NAMING SYSTEM
# ═══════════════════════════════════════════════════════════════════

# Named color families with archaic names, organized by hue
COLOR_FAMILIES = [
    # (name, designation, h_min, h_max, s_min, l_min, l_max)
    ("Obsidian",    "OBS", 0, 360, 0.0, 0.00, 0.12),    # near-black
    ("Alabaster",   "ALB", 0, 360, 0.0, 0.88, 1.00),    # near-white
    ("Cinder",      "CIN", 0, 360, 0.0, 0.12, 0.35),    # dark gray
    ("Pewter",      "PEW", 0, 360, 0.0, 0.35, 0.55),    # mid gray
    ("Ash",         "ASH", 0, 360, 0.0, 0.55, 0.75),    # light gray
    ("Bone",        "BON", 0, 360, 0.0, 0.75, 0.88),    # off-white
    ("Vermillion",  "VRM", 0, 15, 0.25, 0.15, 0.70),    # red
    ("Carmine",     "CRM", 345, 360, 0.25, 0.15, 0.70), # red (wrap)
    ("Cinnabar",    "CNB", 15, 30, 0.25, 0.15, 0.70),   # red-orange
    ("Russet",      "RSS", 15, 35, 0.20, 0.15, 0.45),   # dark orange/brown
    ("Titian",      "TTN", 25, 45, 0.30, 0.30, 0.70),   # orange
    ("Aureate",     "AUR", 45, 60, 0.30, 0.30, 0.75),   # gold/yellow
    ("Saffron",     "SFF", 50, 65, 0.40, 0.45, 0.80),   # bright yellow
    ("Ochre",       "OCH", 35, 50, 0.20, 0.20, 0.55),   # earthy yellow
    ("Viridian",    "VRD", 120, 170, 0.20, 0.20, 0.60),  # green
    ("Verdigris",   "VDG", 150, 185, 0.20, 0.30, 0.65),  # blue-green
    ("Malachite",   "MLC", 100, 140, 0.25, 0.25, 0.55),  # deep green
    ("Cerulean",    "CRL", 185, 220, 0.25, 0.30, 0.70),  # blue
    ("Lapis",       "LAP", 220, 250, 0.25, 0.15, 0.50),  # deep blue
    ("Cobalt",      "CBT", 210, 240, 0.35, 0.25, 0.60),  # rich blue
    ("Tyrian",      "TYR", 280, 320, 0.25, 0.15, 0.55),  # purple
    ("Amethyst",    "AMT", 260, 290, 0.20, 0.30, 0.65),  # violet
    ("Porphyry",    "PRP", 290, 330, 0.20, 0.20, 0.50),  # deep purple
    ("Damask",      "DMK", 330, 350, 0.25, 0.40, 0.75),  # pink
    ("Sienna",      "SNA", 20, 40, 0.20, 0.15, 0.40),    # brown
    ("Umber",       "UMB", 25, 45, 0.10, 0.10, 0.30),    # dark brown
    ("Sepia",       "SEP", 30, 50, 0.15, 0.20, 0.45),    # warm brown
]


def classify_color(hex_color: str) -> dict:
    """Map a hex color to its named family."""
    try:
        hx = hex_color.lstrip("#")
        r, g, b = int(hx[:2], 16) / 255, int(hx[2:4], 16) / 255, int(hx[4:], 16) / 255
        h, l, s = colorsys.rgb_to_hls(r, g, b)
        h_deg = h * 360
    except Exception:
        return {"name": "Unknown", "code": "UNK", "hex": hex_color}

    best = None
    best_score = -1

    for name, code, h_min, h_max, s_min, l_min, l_max in COLOR_FAMILIES:
        # Check saturation threshold for chromatic vs achromatic
        if s_min == 0.0 and l_min <= l <= l_max and s < 0.15:
            # Achromatic match
            score = 10  # prefer achromatic matches when saturation is low
            if best_score < score:
                best = {"name": name, "code": code, "hex": hex_color}
                best_score = score
        elif s >= s_min and l_min <= l <= l_max:
            # Hue match (handle wrap-around for reds)
            if h_min <= h_max:
                if h_min <= h_deg <= h_max:
                    score = 5
                    if best_score < score:
                        best = {"name": name, "code": code, "hex": hex_color}
                        best_score = score
            else:
                if h_deg >= h_min or h_deg <= h_max:
                    score = 5
                    if best_score < score:
                        best = {"name": name, "code": code, "hex": hex_color}
                        best_score = score

    if best:
        return best

    # Fallback: closest by luminance
    if l < 0.2:
        return {"name": "Obsidian", "code": "OBS", "hex": hex_color}
    elif l > 0.8:
        return {"name": "Alabaster", "code": "ALB", "hex": hex_color}
    else:
        return {"name": "Pewter", "code": "PEW", "hex": hex_color}


def classify_palette(hex_colors: list) -> list:
    """Classify all colors in a palette, deduplicate by family name."""
    seen = set()
    result = []
    for hx in hex_colors:
        info = classify_color(hx)
        if info["name"] not in seen:
            seen.add(info["name"])
            result.append(info)
    return result


# ═══════════════════════════════════════════════════════════════════
# STYLE CLASSIFICATION (from image analysis, not filename)
# ═══════════════════════════════════════════════════════════════════

STYLES = {
    "Ironwork":    {"desc": "Hard edges, bold geometry, metal-ready"},
    "Chromata":    {"desc": "Rich color, painterly expression"},
    "Starkform":   {"desc": "High contrast, minimal palette"},
    "Naturalis":   {"desc": "Organic textures, natural tones"},
    "Luminos":     {"desc": "Light-dominant, ethereal quality"},
    "Tenebrae":    {"desc": "Shadow-heavy, deep atmosphere"},
    "Intricata":   {"desc": "Dense detail, complex composition"},
    "Photography": {"desc": "Camera-captured, documentary"},
}


def classify_style(profile: dict, has_exif: bool) -> str:
    """Determine style from image analysis."""
    if has_exif:
        return "Photography"

    edge = profile.get("edge_density", 0)
    cc = profile.get("color_complexity", 128)
    grad = profile.get("gradient_ratio", 0)
    detail = profile.get("detail_frequency", 0)
    lum = profile.get("avg_luminance", 0.5)

    # High edge + low color = geometric/metal-friendly
    if edge > 0.15 and cc < 80:
        return "Ironwork"

    # Very low color complexity, high contrast
    if cc < 50 and profile.get("contrast_range", 0) > 0.7:
        return "Starkform"

    # Very high detail + high color = intricate
    if detail > 0.6 and cc > 180:
        return "Intricata"

    # Low luminance, high gradients
    if lum < 0.3 and grad > 0.3:
        return "Tenebrae"

    # High luminance, low detail
    if lum > 0.65 and detail < 0.4:
        return "Luminos"

    # High gradients + moderate/high color = painterly
    if grad > 0.35 and cc > 100:
        return "Chromata"

    # Default organic
    return "Naturalis"


def detect_exif(image_path: str) -> bool:
    """Check if image has camera EXIF data (= photograph)."""
    try:
        with Image.open(image_path) as img:
            exif = img.getexif()
            if not exif:
                return False
            # Look for camera-specific tags
            camera_tags = {271, 272, 33434, 33437, 34855, 37386}  # Make, Model, ExposureTime, FNumber, ISO, FocalLength
            return bool(camera_tags & set(exif.keys()))
    except Exception:
        return False


# ═══════════════════════════════════════════════════════════════════
# CATEGORY ASSIGNMENT
# ═══════════════════════════════════════════════════════════════════

def assign_category(style: str, vector_route: str) -> str:
    """Assign to Metal Art, Photography, or Art Prints."""
    if style == "Photography":
        return "Photography"
    if vector_route == "vector" and style in ("Ironwork", "Starkform"):
        return "Metal Art"
    return "Art Prints"


# ═══════════════════════════════════════════════════════════════════
# IMAGE ANALYSIS
# ═══════════════════════════════════════════════════════════════════

def analyze_image(image_path: str) -> dict:
    profile = {
        "edge_density": 0.0, "color_complexity": 0,
        "gradient_ratio": 0.0, "detail_frequency": 0.0,
        "contrast_range": 0.0, "avg_luminance": 0.5,
        "route": "raster", "route_reason": "",
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
            profile["avg_luminance"] = sum(stat.mean) / (3 * 255)

    except Exception as e:
        profile["route_reason"] = f"Analysis failed: {e}"
        return profile

    # Vector routing
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

    for k in ["edge_density", "gradient_ratio", "detail_frequency", "contrast_range", "avg_luminance"]:
        profile[k] = round(profile[k], 4)

    return profile


def extract_colors(image_path: str, n: int = 6) -> list:
    try:
        with Image.open(image_path) as img:
            img = img.convert("RGB").resize((150, 150), Image.LANCZOS)
            q = img.quantize(colors=n, method=Image.Quantize.MEDIANCUT)
            pal = q.getpalette()
            return [f"#{pal[i*3]:02x}{pal[i*3+1]:02x}{pal[i*3+2]:02x}" for i in range(n)]
    except Exception:
        return ["#333333", "#666666", "#999999", "#cccccc"]


# ═══════════════════════════════════════════════════════════════════
# SINGLE IMAGE PROCESSOR
# ═══════════════════════════════════════════════════════════════════

def process_single(args: tuple) -> Optional[dict]:
    img_path_str, thumb_dir, web_dir, print_dir, vector_dir, has_vtracer = args
    img_path = Path(img_path_str)
    stem = img_path.stem
    stable_id = hashlib.md5(img_path.name.encode()).hexdigest()[:8].upper()

    try:
        profile = analyze_image(str(img_path))
        raw_colors = extract_colors(str(img_path))
        named_colors = classify_palette(raw_colors)
        has_exif = detect_exif(str(img_path))
        style = classify_style(profile, has_exif)
        category = assign_category(style, profile["route"])
        title = generate_name(profile, raw_colors, img_path.name)

        # Designation code: BRC-[STYLE_3]-[ID]
        style_code = style[:3].upper()
        designation = f"BRC-{style_code}-{stable_id}"

        # ── Process image ──
        with Image.open(str(img_path)) as img:
            img = img.convert("RGB")
            w, h = img.size
            current_long = max(w, h)

            if current_long != PRINT_LONG_EDGE:
                ratio = PRINT_LONG_EDGE / current_long
                img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

            img = img.filter(ImageFilter.UnsharpMask(radius=1.5, percent=120, threshold=3))
            img = ImageEnhance.Contrast(img).enhance(1.04)
            img = ImageEnhance.Color(img).enhance(1.05)

            pw, ph = img.size
            print_path = Path(print_dir) / f"{stem}.png"
            img.save(str(print_path), "PNG", optimize=True)

            # Thumbnail
            th = int(ph * (THUMB_WIDTH / pw))
            thumb = img.resize((THUMB_WIDTH, th), Image.LANCZOS)
            thumb = thumb.filter(ImageFilter.UnsharpMask(radius=0.5, percent=80, threshold=3))
            thumb_path = Path(thumb_dir) / f"thumb_{stem}.webp"
            thumb.save(str(thumb_path), "WEBP", quality=THUMB_QUALITY, optimize=True)

            # Web version
            if max(pw, ph) > WEB_MAX_DIMENSION:
                ratio = WEB_MAX_DIMENSION / max(pw, ph)
                web = img.resize((int(pw * ratio), int(ph * ratio)), Image.LANCZOS)
            else:
                web = img.copy()
            # Watermark web images (print files stay clean)
            web = _apply_watermark(web)

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

        # Determine available products by category
        if category == "Metal Art":
            products = ["Laser-Cut Metal", "Framed Print", "Canvas"]
        elif category == "Photography":
            products = ["Framed Print", "Canvas", "Acrylic", "Poster"]
        else:
            products = BEST_PRODUCTS[:3]

        return {
            "id": designation, "sku": designation,
            "title": title, "description": "",
            "style": style,
            "category": category,
            "colorPalette": raw_colors,
            "namedColors": named_colors,
            "bestProducts": products,
            "seoKeywords": ["arttra", style.lower(), category.lower(), "wall art", "contemporary", "handmade"],
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
            "isPhotography": has_exif,
            "buyUrl": "#",
            "sourceFile": img_path.name,
            "timestamp": datetime.fromtimestamp(img_path.stat().st_mtime).isoformat(),
            "_hash": hashlib.md5(open(str(img_path), "rb").read()).hexdigest(),
            "_stem": stem,
        }

    except Exception as e:
        print(f"  [FAIL] {stem}: {e}")
        return None


def _apply_watermark(img):
    """Apply subtle diagonal ARTTRA.ART watermark to web display images."""
    try:
        w, h = img.size
        overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        # Try to get a decent font size
        font_size = max(w, h) // 18
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
        except Exception:
            try:
                font = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", font_size)
            except Exception:
                font = ImageFont.load_default()

        text = "ARTTRA.ART"

        # Tile the watermark diagonally across the image
        import math
        step_x = int(w * 0.4)
        step_y = int(h * 0.35)

        for y_off in range(-h, h * 2, step_y):
            for x_off in range(-w, w * 2, step_x):
                # Create rotated text
                txt_img = Image.new("RGBA", (font_size * 8, font_size * 2), (0, 0, 0, 0))
                txt_draw = ImageDraw.Draw(txt_img)
                txt_draw.text((0, 0), text, fill=(255, 255, 255, 28), font=font)
                rotated = txt_img.rotate(35, expand=True, resample=Image.BICUBIC)

                # Paste onto overlay
                paste_x = x_off
                paste_y = y_off
                if 0 - rotated.width < paste_x < w and 0 - rotated.height < paste_y < h:
                    overlay.paste(rotated, (paste_x, paste_y), rotated)

        # Composite
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        result = Image.alpha_composite(img, overlay)
        return result.convert("RGB")
    except Exception:
        return img


def _vectorize_true(input_path, output_path, color_precision=6):
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


def _vectorize_raster_svg(input_path, svg_output, w, h):
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


# ═══════════════════════════════════════════════════════════════════
# VTRACER SETUP
# ═══════════════════════════════════════════════════════════════════

def setup_vtracer():
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

def build(source_dir, output_root, workers=MAX_WORKERS):
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

    gallery_dir = output / "assets" / "images" / "gallery"
    thumb_dir = gallery_dir / "thumbs"
    web_dir = gallery_dir / "web"
    print_dir = gallery_dir / "print"
    vector_dir = gallery_dir / "vector"
    data_dir = output / "data"

    for d in [thumb_dir, web_dir, print_dir, vector_dir, data_dir]:
        d.mkdir(parents=True, exist_ok=True)

    manifest_path = data_dir / "build_manifest.json"
    manifest = {}
    if manifest_path.exists():
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}

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

    print(f"[build] {len(images)} total, {len(cached_artworks)} cached, {len(to_process)} new")

    if not to_process and cached_artworks:
        cached_artworks.sort(key=lambda a: a.get("timestamp", ""), reverse=True)
        with open(data_dir / "artworks.json", "w") as f:
            json.dump(cached_artworks, f, indent=2)
        print(f"[build] No new images. Done.")
        return

    has_vtracer = setup_vtracer()
    print(f"[build] vtracer: {'yes' if has_vtracer else 'no'}")
    print(f"[build] Processing {len(to_process)} images with {workers} workers...")

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
                    print(f"  [{done}/{len(to_process)}] {src} → {result['title']} [{result['style']}] [{result['category']}]")
                else:
                    print(f"  [{done}/{len(to_process)}] {src} — FAILED")
            except Exception as e:
                print(f"  [{done}/{len(to_process)}] {src} — ERROR: {e}")

    all_artworks = cached_artworks + new_artworks
    all_artworks.sort(key=lambda a: a.get("timestamp", ""), reverse=True)

    with open(data_dir / "artworks.json", "w") as f:
        json.dump(all_artworks, f, indent=2)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Stats
    categories = {}
    styles = {}
    for a in all_artworks:
        categories[a.get("category", "?")] = categories.get(a.get("category", "?"), 0) + 1
        styles[a.get("style", "?")] = styles.get(a.get("style", "?"), 0) + 1

    print(f"\n{'='*60}")
    print(f"[build] Complete: {len(all_artworks)} artworks ({len(new_artworks)} new)")
    print(f"  Categories: {json.dumps(categories)}")
    print(f"  Styles: {json.dumps(styles)}")
    print(f"{'='*60}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="../gallery-source")
    parser.add_argument("--output", default="..")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = parser.parse_args()
    build(args.source, args.output, args.workers)
