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
import tempfile
import base64
import random
import colorsys
from datetime import datetime
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Optional

try:
    from PIL import Image, ImageFilter, ImageEnhance, ImageStat, ImageDraw, ImageFont, ImageOps
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
    "Caliginous", "Crepuscule", "Subfusc", "Fuliginous", "Acheron",
    "Lethe", "Charnel", "Lichgate", "Corbeau", "Widdershin", "Mortcloth",
    "Blackdamp", "Tenebrific", "Sablefell", "Grimfen", "Ravenmoor",
    "Cinereous", "Nightjar", "Direling", "Umbrage",
]

LIGHT_PREFIX = [
    "Lumen", "Aether", "Solace", "Aurelius", "Meridian", "Zenith",
    "Alabast", "Gossamer", "Silvaine", "Ichor", "Halcyon", "Seraphine",
    "Opaline", "Pearlescent", "Glintmere", "Dawnspar", "Lucent",
    "Eidolon", "Luminesce", "Chandral", "Etherveil", "Starhollow",
    "Effulgence", "Empyrean", "Refulgent", "Coruscant", "Nacre",
    "Argent", "Eburnean", "Auroral", "Glister", "Limn", "Aubade",
    "Heliotrope", "Lucida", "Phosphor", "Candent", "Pellucid",
    "Selene", "Lambent", "Irradiance", "Sheen",
]

WARM_PREFIX = [
    "Ember", "Forge", "Cinnabar", "Pyralis", "Scoria", "Crucible",
    "Vulcan", "Amaranth", "Carnelian", "Sanguine", "Russet", "Titian",
    "Briarclaw", "Ironbloom", "Copperwynd", "Hearthstone", "Flamecrest",
    "Burnveil", "Ashenmoor", "Blazemark", "Scorchfield", "Kindlemere",
    "Calenture", "Incarnadine", "Minium", "Rubescent", "Flambeau",
    "Brimstone", "Pyrrhous", "Fervid", "Sienna", "Vermeil", "Ignescent",
    "Coalfell", "Smoulderwick", "Foundry", "Embermoor", "Auburn",
    "Cresset", "Ferrous", "Bellows", "Tindersphere",
]

COOL_PREFIX = [
    "Glacier", "Boreal", "Fjord", "Rime", "Crysthene", "Cerulean",
    "Lapis", "Cobalt", "Aquiline", "Tidewater", "Northveil", "Frostholme",
    "Wintermere", "Deepcurrent", "Slatewind", "Mistral", "Stormglass",
    "Bluevein", "Shorelight", "Pelagic", "Abyssen", "Harborglass",
    "Gelid", "Hyperborean", "Brumal", "Niveous", "Hibernal", "Glaucous",
    "Thalassic", "Hoarfrost", "Verglas", "Nereid", "Undine", "Cerule",
    "Frostmarrow", "Sleetmere", "Glacis", "Floe", "Wintermark",
    "Snowmelt", "Icebound", "Aquilon",
]

# Suffix pools organized by structural character
GEOMETRIC_SUFFIX = [
    "Lattice", "Tessera", "Facet", "Shard", "Matrix", "Prism",
    "Axis", "Meridian", "Parallax", "Vertex", "Polygon", "Tangent",
    "Bisect", "Fulcrum", "Keystone", "Capstone", "Lintel",
    "Quoin", "Gnomon", "Voussoir", "Plinth", "Mullion", "Spandrel",
    "Crenel", "Merlon", "Architrave", "Chamfer", "Lozenge",
    "Stellation", "Coffer", "Soffit", "Cornice", "Abacus",
]

ORGANIC_SUFFIX = [
    "Bloom", "Tendril", "Helix", "Gyre", "Frond", "Rhizome",
    "Mycelium", "Canopy", "Thicket", "Undergrowth", "Lichen",
    "Petalwork", "Roothold", "Seedvault", "Thornset",
    "Boscage", "Spinney", "Coppice", "Bracken", "Verdure", "Calyx",
    "Umbel", "Panicle", "Bosk", "Greenwood", "Witchgrass", "Sedge",
    "Bindweed", "Heartwood", "Burgeon", "Mossbloom",
]

MINIMAL_SUFFIX = [
    "Void", "Monolith", "Stele", "Cipher", "Null", "Vestige",
    "Fragment", "Remnant", "Trace", "Echo", "Silhouette", "Outline",
    "Husk", "Threshold", "Margin", "Plane", "Expanse",
    "Lacuna", "Caesura", "Interstice", "Abeyance", "Quietus", "Nadir",
    "Sere", "Effacement", "Hush", "Aphelion", "Tabula", "Attenuation",
    "Quiescence", "Ebb", "Vacancy", "Pall",
]

COMPLEX_SUFFIX = [
    "Labyrinth", "Nexus", "Vortex", "Tangle", "Confluence", "Maelstrom",
    "Chronicle", "Palimpsest", "Mosaic", "Kaleidoscope", "Assemblage",
    "Compendium", "Phantasmagoria",
    "Daedal", "Arabesque", "Imbroglio", "Welter", "Filigree", "Plexus",
    "Reliquary", "Bestiary", "Cartouche", "Marginalia", "Involution",
    "Convolution", "Concatenation", "Gordian", "Warren", "Rookery",
]


# Words that must never appear in a generated name (banned AI-cliche vocabulary).
# Matched as substrings, so "scaffold" also blocks "scaffolding", etc.
BANNED_NAME_SUBSTRINGS = ("tapestry", "scaffold", "signal", "weave", "woven", "fabric", "realm")


def _name_is_clean(word: str) -> bool:
    """True if a candidate name-word contains no banned substring."""
    wl = word.lower()
    return not any(b in wl for b in BANNED_NAME_SUBSTRINGS)


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

    # Enforce the banned-word ban regardless of pool contents.
    pool = [w for w in pool if _name_is_clean(w)]
    spool = [w for w in spool if _name_is_clean(w)]

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
# CANVAS DETECTION (photos of physical paintings)
# ═══════════════════════════════════════════════════════════════════

def _longest_run(arr, thresh):
    """Start/end indices of the longest contiguous run of values above thresh."""
    above = arr > thresh
    best_len, best = 0, (0, len(arr))
    i, n = 0, len(arr)
    while i < n:
        if above[i]:
            j = i
            while j < n and above[j]:
                j += 1
            if j - i > best_len:
                best_len, best = j - i, (i, j)
            i = j
        else:
            i += 1
    return best


def detect_and_crop_canvas(image_path: str):
    """Locate a rectangular canvas in a photo of a physical painting, deskew it,
    and crop to it. Returns a cropped PIL.Image, or None when no confident
    canvas is found — the caller then leaves the image untouched.

    Built for phone photos of paintings lying on a floor/surface: GrabCut
    separates the canvas from the textured background, the canvas angle deskews
    it, and a projection-profile crop trims thin edge clutter (cords, tools).
    """
    try:
        import cv2
        import numpy as np

        pil = Image.open(image_path)
        try:
            pil = ImageOps.exif_transpose(pil)
        except Exception:
            pass
        full = cv2.cvtColor(np.array(pil.convert("RGB")), cv2.COLOR_RGB2BGR)
        H, W = full.shape[:2]
        scale = 1000.0 / max(H, W)
        small = cv2.resize(full, None, fx=scale, fy=scale) if scale < 1 else full.copy()
        sH, sW = small.shape[:2]
        frame_area = sH * sW

        # GrabCut — outer 6% border is taken as definite background (the surface).
        gc = np.zeros((sH, sW), np.uint8)
        mx, my = int(sW * 0.06), int(sH * 0.06)
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(small, gc, (mx, my, sW - 2 * mx, sH - 2 * my),
                    bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
        fg = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
        k = max(9, int(min(sH, sW) * 0.02))
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))

        cnts, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            return None
        c = max(cnts, key=cv2.contourArea)
        if cv2.contourArea(c) < 0.10 * frame_area:
            return None

        # Filled canvas contour — drops detached clutter blobs.
        filled = np.zeros((sH, sW), np.uint8)
        cv2.drawContours(filled, [c], -1, 255, -1)

        angle = cv2.minAreaRect(c)[-1] % 90
        if angle > 45:
            angle -= 90

        mask_full = cv2.resize(filled, (W, H), interpolation=cv2.INTER_NEAREST)
        cx, cy = W / 2.0, H / 2.0
        M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
        cos, sin = abs(M[0, 0]), abs(M[0, 1])
        nW, nH = int(H * sin + W * cos), int(H * cos + W * sin)
        M[0, 2] += nW / 2.0 - cx
        M[1, 2] += nH / 2.0 - cy
        rot_img = cv2.warpAffine(full, M, (nW, nH))
        rot_mask = cv2.warpAffine(mask_full, M, (nW, nH))

        # Projection-profile crop: keep the longest contiguous band of rows/cols
        # that are solidly canvas, which trims thin edge clutter.
        rows = (rot_mask > 127).mean(axis=1)
        cols = (rot_mask > 127).mean(axis=0)
        if rows.max() < 0.2 or cols.max() < 0.2:
            return None
        y0, y1 = _longest_run(rows, 0.7 * rows.max())
        x0, x1 = _longest_run(cols, 0.7 * cols.max())
        crop = rot_img[y0:y1, x0:x1]
        ch, cw = crop.shape[:2]
        if cw < 50 or ch < 50:
            return None
        ar = cw / ch
        if ar < 0.25 or ar > 4.0:
            return None
        return Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
    except Exception as e:
        print(f"  [canvas] detection failed on {Path(image_path).name}: {e}")
        return None


# ═══════════════════════════════════════════════════════════════════
# SINGLE IMAGE PROCESSOR
# ═══════════════════════════════════════════════════════════════════

def process_single(args: tuple) -> Optional[dict]:
    img_path_str, thumb_dir, web_dir, print_dir, vector_dir, has_vtracer, no_crop_ids = args
    img_path = Path(img_path_str)
    stem = img_path.stem
    stable_id = hashlib.md5(img_path.name.encode()).hexdigest()[:8].upper()

    tmp_crop = None
    try:
        has_exif = detect_exif(str(img_path))

        # Photos of physical paintings (carpet/floor shots) carry camera EXIF —
        # auto-detect the canvas and crop to it in memory (the source file is
        # never modified). A successful crop means this is a physical painting,
        # not a photograph — so it classifies by visual style and lands in the
        # right gallery section with no manual override.
        work_path = str(img_path)
        canvas_cropped = False
        if has_exif and stable_id not in no_crop_ids:
            cropped = detect_and_crop_canvas(str(img_path))
            if cropped is not None:
                fd, tmp_crop = tempfile.mkstemp(suffix=".png", prefix="arttra-canvas-")
                os.close(fd)
                cropped.save(tmp_crop, "PNG")
                work_path = tmp_crop
                canvas_cropped = True

        is_photograph = has_exif and not canvas_cropped

        profile = analyze_image(work_path)
        raw_colors = extract_colors(work_path)
        named_colors = classify_palette(raw_colors)
        style = classify_style(profile, is_photograph)
        category = assign_category(style, profile["route"])
        title = generate_name(profile, raw_colors, img_path.name)

        # Designation code: BRC-[STYLE_3]-[ID]
        style_code = style[:3].upper()
        designation = f"BRC-{style_code}-{stable_id}"

        # ── Process image ──
        with Image.open(work_path) as img:
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
            "isPhotography": is_photograph,
            "buyUrl": "#",
            "sourceFile": img_path.name,
            "timestamp": datetime.fromtimestamp(img_path.stat().st_mtime).isoformat(),
            "_hash": hashlib.md5(open(str(img_path), "rb").read()).hexdigest(),
            "_stem": stem,
        }

    except Exception as e:
        print(f"  [FAIL] {stem}: {e}")
        return None
    finally:
        if tmp_crop and os.path.exists(tmp_crop):
            try:
                os.remove(tmp_crop)
            except OSError:
                pass


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


def setup_rembg():
    try:
        from rembg import remove as _
        return True
    except ImportError:
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "rembg[cpu]", "--break-system-packages"],
                capture_output=True, check=True, timeout=300)
            return True
        except Exception:
            print("[rembg] Install failed — bg removal unavailable")
            return False


def remove_background(input_path: str, output_path: str) -> bool:
    """Remove background from image using rembg AI."""
    try:
        from rembg import remove
        with open(input_path, "rb") as f:
            input_data = f.read()
        output_data = remove(input_data)
        with open(output_path, "wb") as f:
            f.write(output_data)
        return True
    except Exception as e:
        print(f"  [rembg] Failed: {e}")
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

    # Load overrides
    overrides = {}
    overrides_path = data_dir / "overrides.json"
    if overrides_path.exists():
        try:
            with open(overrides_path) as f:
                overrides = json.load(f)
            print(f"[build] Loaded {len(overrides)} overrides from overrides.json")
        except Exception as e:
            print(f"[build] Failed to load overrides: {e}")

    manifest_path = data_dir / "build_manifest.json"
    manifest = {}
    if manifest_path.exists():
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}

    # Check which images need bg removal (from overrides)
    bg_removal_ids = {k for k, v in overrides.items() if v.get("removeBg")}

    # Stable-id suffixes opted out of canvas auto-crop (overrides: cropCanvas false)
    no_crop_ids = frozenset(
        k.rsplit("-", 1)[-1] for k, v in overrides.items() if v.get("cropCanvas") is False
    )

    to_process = []
    cached_artworks = []
    for img_path in images:
        stem = img_path.stem
        file_hash = hashlib.md5(open(img_path, "rb").read()).hexdigest()

        # Check if this image's artwork ID is flagged for bg removal
        # If so, check if bg removal was already done
        cached = manifest.get(stem, {})
        artwork_id = cached.get("artwork", {}).get("id", "")
        needs_bg_redo = artwork_id in bg_removal_ids and not cached.get("bg_removed")

        if stem in manifest and cached.get("hash") == file_hash and not needs_bg_redo:
            if "artwork" in cached:
                cached_artworks.append(cached["artwork"])
            continue
        to_process.append(img_path)

    print(f"[build] {len(images)} total, {len(cached_artworks)} cached, {len(to_process)} new/updated")

    if not to_process and cached_artworks:
        # Still apply overrides to cached artworks
        cached_artworks = _apply_overrides(cached_artworks, overrides)
        cached_artworks.sort(key=lambda a: a.get("timestamp", ""), reverse=True)
        with open(data_dir / "artworks.json", "w") as f:
            json.dump(cached_artworks, f, indent=2)
        print(f"[build] No new images. Overrides applied. Done.")
        return

    has_vtracer = setup_vtracer()
    has_rembg = setup_rembg() if bg_removal_ids else False
    print(f"[build] vtracer: {'yes' if has_vtracer else 'no'}")
    if bg_removal_ids:
        print(f"[build] rembg: {'yes' if has_rembg else 'no'} ({len(bg_removal_ids)} flagged for bg removal)")

    # Pre-process: remove backgrounds on flagged source images
    if has_rembg and bg_removal_ids:
        print(f"[build] Running background removal...")
        bg_done_dir = source.parent / ".bg-removed"
        bg_done_dir.mkdir(exist_ok=True)
        for img_path in to_process:
            stem = img_path.stem
            stable_id = hashlib.md5(img_path.name.encode()).hexdigest()[:8].upper()
            # Check all possible artwork IDs this image could map to
            for style_prefix in ["IRO", "CHR", "STA", "NAT", "LUM", "TEN", "INT", "PHO"]:
                possible_id = f"BRC-{style_prefix}-{stable_id}"
                if possible_id in bg_removal_ids:
                    bg_out = str(bg_done_dir / f"{stem}.png")
                    if remove_background(str(img_path), bg_out):
                        print(f"  [rembg] {stem} — background removed")
                        # Replace source with bg-removed version for processing
                        import shutil as _shutil
                        _shutil.copy2(bg_out, str(img_path))
                        # Mark in manifest
                        if stem not in manifest:
                            manifest[stem] = {}
                        manifest[stem]["bg_removed"] = True
                    break

    print(f"[build] Processing {len(to_process)} images with {workers} workers...")

    tasks = [
        (str(p), str(thumb_dir), str(web_dir), str(print_dir), str(vector_dir), has_vtracer, no_crop_ids)
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
                    manifest[stem] = {
                        "hash": file_hash,
                        "artwork": result,
                        "route": result["vectorRoute"],
                        "bg_removed": manifest.get(stem, {}).get("bg_removed", False),
                    }
                    print(f"  [{done}/{len(to_process)}] {src} → {result['title']} [{result['style']}] [{result['category']}]")
                else:
                    print(f"  [{done}/{len(to_process)}] {src} — FAILED")
            except Exception as e:
                print(f"  [{done}/{len(to_process)}] {src} — ERROR: {e}")

    all_artworks = cached_artworks + new_artworks

    # Apply overrides on top of auto-generated data
    all_artworks = _apply_overrides(all_artworks, overrides)

    all_artworks.sort(key=lambda a: a.get("timestamp", ""), reverse=True)

    # Filter hidden
    visible = [a for a in all_artworks if not a.get("hidden")]

    with open(data_dir / "artworks.json", "w") as f:
        json.dump(visible, f, indent=2)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Stats
    categories = {}
    styles = {}
    for a in visible:
        categories[a.get("category", "?")] = categories.get(a.get("category", "?"), 0) + 1
        styles[a.get("style", "?")] = styles.get(a.get("style", "?"), 0) + 1

    print(f"\n{'='*60}")
    print(f"[build] Complete: {len(visible)} visible artworks ({len(new_artworks)} new, {len(all_artworks) - len(visible)} hidden)")
    print(f"  Categories: {json.dumps(categories)}")
    print(f"  Styles: {json.dumps(styles)}")
    if overrides:
        print(f"  Overrides applied: {len(overrides)}")
    print(f"{'='*60}")


def _apply_overrides(artworks, overrides):
    """Merge overrides.json on top of auto-generated artwork data. Manual edits always win."""
    if not overrides:
        return artworks

    for art in artworks:
        art_id = art.get("id", "")
        if art_id in overrides:
            ovr = overrides[art_id]
            for key, val in ovr.items():
                if key == "priceTiers" and isinstance(val, dict):
                    if "priceTiers" not in art:
                        art["priceTiers"] = {}
                    art["priceTiers"].update(val)
                elif key == "bestProducts" and isinstance(val, list):
                    art["bestProducts"] = val
                elif key in ("removeBg",):
                    # Flag only, don't copy to artwork output
                    continue
                else:
                    art[key] = val

    return artworks


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="../gallery-source")
    parser.add_argument("--output", default="..")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = parser.parse_args()
    build(args.source, args.output, args.workers)
