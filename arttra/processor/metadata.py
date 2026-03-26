"""
Metadata processor — transforms raw scrape manifest into arttra-web artworks.json format.

Takes the flat manifest from the scraper and generates:
  1. artworks.json — gallery data in the schema the frontend expects
  2. videos.json — separate catalog for the video/NFT gallery
  3. Thumbnail references (processor/thumbs.py handles actual resizing)

Auto-classification:
  - Style is inferred from hashtags and caption keywords
  - Color palette is extracted from the image itself (dominant colors via Pillow)
  - Room fit / mood are inferred from style
  - SKU is generated from shortcode + date
  - Price tiers use sensible defaults (overridable per-artwork later)
"""

import colorsys
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Optional

try:
    from PIL import Image
except ImportError:
    Image = None


# ------------------------------------------------------------------
# Style / mood inference from hashtags + captions
# ------------------------------------------------------------------

STYLE_KEYWORDS = {
    "Abstract": ["abstract", "abstraction", "expressionism", "gestural", "nonrepresentational"],
    "Geometric": ["geometric", "geometry", "shapes", "triangles", "pattern", "tessellation"],
    "Floral": ["floral", "botanical", "flower", "flowers", "bloom", "plant", "nature"],
    "Minimal": ["minimal", "minimalist", "minimalism", "simple", "clean"],
    "Surreal": ["surreal", "surrealism", "dreamlike", "psychedelic", "visionary"],
    "Portrait": ["portrait", "face", "figure", "figurative", "self-portrait", "selfportrait"],
    "Landscape": ["landscape", "scenery", "mountains", "ocean", "sky", "sunset", "sunrise"],
    "Digital": ["digital", "digitalart", "generative", "glitch", "nft", "crypto", "ai"],
    "Mixed Media": ["mixedmedia", "collage", "assemblage", "multimedia"],
    "Photography": ["photography", "photo", "photographer", "streetphotography", "film"],
    "Pop Art": ["popart", "pop", "warhol", "contemporary", "bold"],
    "Typography": ["typography", "lettering", "calligraphy", "text", "words"],
}

MOOD_MAP = {
    "Abstract": "Expressive / Bold",
    "Geometric": "Structured / Modern",
    "Floral": "Natural / Soft",
    "Minimal": "Calm / Clean",
    "Surreal": "Dreamlike / Provocative",
    "Portrait": "Intimate / Personal",
    "Landscape": "Expansive / Serene",
    "Digital": "Futuristic / Dynamic",
    "Mixed Media": "Layered / Textural",
    "Photography": "Documentary / Raw",
    "Pop Art": "Vibrant / Playful",
    "Typography": "Graphic / Statement",
}

ROOM_MAP = {
    "Abstract": ["Living Room", "Office", "Bedroom"],
    "Geometric": ["Office", "Kitchen", "Entryway"],
    "Floral": ["Bedroom", "Bathroom", "Dining Room"],
    "Minimal": ["Office", "Hallway", "Living Room"],
    "Surreal": ["Living Room", "Bedroom", "Studio"],
    "Portrait": ["Living Room", "Hallway", "Office"],
    "Landscape": ["Living Room", "Bedroom", "Dining Room"],
    "Digital": ["Office", "Studio", "Living Room"],
    "Mixed Media": ["Living Room", "Studio", "Entryway"],
    "Photography": ["Hallway", "Office", "Living Room"],
    "Pop Art": ["Kitchen", "Playroom", "Living Room"],
    "Typography": ["Office", "Entryway", "Kitchen"],
}

DEFAULT_PRICE_TIERS = {"startingPrice": 79}

BEST_PRODUCTS = ["Framed Print", "Canvas", "Acrylic", "Metal Print", "Poster"]


def infer_style(caption: str, hashtags: list[str]) -> str:
    """Score each style by keyword matches in caption + hashtags."""
    text = (caption + " " + " ".join(hashtags)).lower()
    scores = {}
    for style, keywords in STYLE_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in text)
        if score > 0:
            scores[style] = score

    if scores:
        return max(scores, key=scores.get)
    return "Abstract"  # default


def extract_seo_keywords(caption: str, hashtags: list[str], style: str) -> list[str]:
    """Pull SEO keywords from caption and hashtags."""
    keywords = set()

    # Hashtags without the #
    for tag in hashtags:
        clean = tag.strip("#").lower()
        if len(clean) > 2:
            keywords.add(clean)

    # Significant words from caption (>4 chars, skip common words)
    stopwords = {"this", "that", "with", "from", "have", "been", "will", "your",
                 "they", "them", "their", "what", "about", "which", "would", "there",
                 "these", "some", "like", "just", "more", "also", "very", "when"}
    for word in re.findall(r'\b[a-z]{4,}\b', caption.lower()):
        if word not in stopwords:
            keywords.add(word)

    # Always include brand + style
    keywords.update(["arttra", style.lower(), "art print", "wall art", "contemporary"])

    return sorted(keywords)[:20]


# ------------------------------------------------------------------
# Color palette extraction
# ------------------------------------------------------------------

def extract_color_palette(image_path: str, n_colors: int = 4) -> list[str]:
    """Extract dominant colors from an image as hex strings."""
    if Image is None:
        return ["#333333", "#666666", "#999999", "#cccccc"]

    try:
        with Image.open(image_path) as img:
            # Resize for speed
            img = img.convert("RGB").resize((150, 150), Image.LANCZOS)
            pixels = list(img.getdata())

        # Simple k-means-ish: quantize to reduced palette
        img_q = Image.new("RGB", (150, 150))
        img_q.putdata(pixels)
        img_q = img_q.quantize(colors=n_colors, method=Image.Quantize.MEDIANCUT)
        palette_data = img_q.getpalette()

        colors = []
        for i in range(n_colors):
            r, g, b = palette_data[i * 3], palette_data[i * 3 + 1], palette_data[i * 3 + 2]
            colors.append(f"#{r:02x}{g:02x}{b:02x}")

        return colors

    except Exception as e:
        print(f"[processor] Color extraction failed for {image_path}: {e}")
        return ["#333333", "#666666", "#999999", "#cccccc"]


# ------------------------------------------------------------------
# Main processor
# ------------------------------------------------------------------

class MetadataProcessor:
    def __init__(self, data_dir: str = "./data/raw", output_dir: str = "./site/data"):
        self.data_dir = Path(data_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.manifest = self._load_manifest()

    def _load_manifest(self) -> dict:
        p = self.data_dir / "scrape_manifest.json"
        if p.exists():
            with open(p) as f:
                return json.load(f)
        raise FileNotFoundError(f"No manifest at {p}. Run scraper first.")

    def process(self, base_image_url: str = "./assets/images/gallery") -> tuple[list, list]:
        """
        Process all posts into artworks.json and videos.json.
        base_image_url: URL prefix for image paths in the frontend.
        """
        artworks = []
        videos = []

        for sc, post in self.manifest.get("posts", {}).items():
            media = post.get("media_files", [])
            images = [m for m in media if m["type"] == "image"]
            vids = [m for m in media if m["type"] == "video"]

            caption = post.get("caption", "")
            hashtags = post.get("hashtags", [])
            timestamp = post.get("timestamp", "")
            style = infer_style(caption, hashtags)

            # Generate SKU from date + shortcode
            try:
                dt = datetime.fromisoformat(timestamp)
                date_part = dt.strftime("%y%m%d")
            except (ValueError, TypeError):
                date_part = "000000"
            sku = f"ART-{date_part}-{sc[:8].upper()}"

            # Title from first line of caption or shortcode
            title = self._extract_title(caption, sc)

            # Description from caption (truncated)
            desc = self._clean_description(caption)

            # Process each image as a separate artwork
            for idx, img_meta in enumerate(images):
                img_path = img_meta.get("path", "")
                filename = img_meta.get("filename", "")

                # Thumb and full-size paths for the static site
                thumb_filename = f"thumb_{filename}"
                full_filename = filename

                # Color palette from actual image
                palette = extract_color_palette(img_path) if Path(img_path).exists() else []

                seo_keywords = extract_seo_keywords(caption, hashtags, style)

                artwork_id = f"{sku}-{idx}" if len(images) > 1 else sku

                artwork = {
                    "id": artwork_id,
                    "sku": artwork_id,
                    "title": title if idx == 0 else f"{title} ({idx + 1})",
                    "description": desc,
                    "style": style,
                    "mood": MOOD_MAP.get(style, "Contemporary"),
                    "roomFit": ROOM_MAP.get(style, ["Living Room"]),
                    "colorPalette": palette,
                    "bestProducts": BEST_PRODUCTS[:3],
                    "seoKeywords": seo_keywords,
                    "priceTiers": DEFAULT_PRICE_TIERS.copy(),
                    "thumb": f"{base_image_url}/{thumb_filename}",
                    "image": f"{base_image_url}/{full_filename}",
                    "buyUrl": post.get("post_url", "#"),
                    "instagramUrl": post.get("post_url", ""),
                    "shortcode": sc,
                    "timestamp": timestamp,
                    "likes": post.get("likes", 0),
                    "hashtags": hashtags,
                    "sourceFile": filename,
                }

                artworks.append(artwork)

            # Videos go to separate catalog
            for idx, vid_meta in enumerate(vids):
                video_entry = {
                    "id": f"VID-{date_part}-{sc[:8].upper()}-{idx}",
                    "shortcode": sc,
                    "title": title,
                    "description": desc,
                    "filename": vid_meta.get("filename", ""),
                    "path": vid_meta.get("path", ""),
                    "instagramUrl": post.get("post_url", ""),
                    "timestamp": timestamp,
                    "likes": post.get("likes", 0),
                    "hashtags": hashtags,
                    "style": style,
                    "nft_status": "pending",  # for future NFT minting workflow
                    "nft_contract": None,
                    "nft_token_id": None,
                }
                videos.append(video_entry)

        # Sort by timestamp descending (newest first)
        artworks.sort(key=lambda a: a.get("timestamp", ""), reverse=True)
        videos.sort(key=lambda v: v.get("timestamp", ""), reverse=True)

        # Write outputs
        artworks_path = self.output_dir / "artworks.json"
        videos_path = self.output_dir / "videos.json"

        with open(artworks_path, "w") as f:
            json.dump(artworks, f, indent=2)

        with open(videos_path, "w") as f:
            json.dump(videos, f, indent=2)

        print(f"[processor] Generated {len(artworks)} artworks -> {artworks_path}")
        print(f"[processor] Generated {len(videos)} videos -> {videos_path}")

        return artworks, videos

    @staticmethod
    def _extract_title(caption: str, shortcode: str) -> str:
        """Pull a title from the first line of the caption."""
        if not caption:
            return f"Untitled ({shortcode})"

        # First line, stripped of hashtags and mentions
        first_line = caption.split("\n")[0].strip()
        first_line = re.sub(r'[#@]\S+', '', first_line).strip()

        # Remove trailing punctuation clutter
        first_line = first_line.rstrip(".,;:!-–—")

        if len(first_line) > 3:
            return first_line[:120]

        return f"Untitled ({shortcode})"

    @staticmethod
    def _clean_description(caption: str) -> str:
        """Clean caption for use as artwork description."""
        if not caption:
            return ""

        # Remove hashtag block (usually at the end)
        desc = re.split(r'\n\s*[#.]', caption)[0].strip()
        # Remove @mentions
        desc = re.sub(r'@\S+', '', desc).strip()
        # Collapse whitespace
        desc = re.sub(r'\s+', ' ', desc)

        return desc[:500]


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Process scraped data into arttra format")
    parser.add_argument("--data-dir", default="./data/raw")
    parser.add_argument("--output-dir", default="./site/data")
    parser.add_argument("--base-url", default="./assets/images/gallery")

    args = parser.parse_args()

    processor = MetadataProcessor(data_dir=args.data_dir, output_dir=args.output_dir)
    artworks, videos = processor.process(base_image_url=args.base_url)
    print(f"\nTotal: {len(artworks)} artworks, {len(videos)} videos")
