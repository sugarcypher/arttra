/**
 * arttra size + material options — ONE source of truth, imported by both the
 * storefront (script.js) and the checkout Worker (worker/src/index.js), so the
 * sizes a buyer sees are exactly the sizes the Worker will charge for and send
 * to Printful.
 *
 * The rules:
 *  1. Aspect fit. A size is offered only when its shape is within
 *     catalog.aspectTolerance (default 10%) of the artwork's shape, so Printful
 *     never crops a meaningful part of the piece.
 *  2. Real resolution. A size is offered only when the artwork's REAL source
 *     pixels (art.sourcePixels, or art.enhancedPixels once AI upscaling runs)
 *     give at least the material's minPpi on both edges. The 6000px print file
 *     is a resample, so it is never used to judge quality when the true source
 *     size is known.
 */

export const OPTION_PATTERN = /^[a-z]{2,16}:[0-9.]{1,6}x[0-9.]{1,6}(:[a-z0-9-]{1,16})?$/;

export function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Real pixels (no AI): saved enhancement > source > print file. */
export function effectivePixels(art) {
  const e = art && art.enhancedPixels;
  if (e && e.w > 0 && e.h > 0) return { w: Number(e.w), h: Number(e.h), source: "enhanced" };
  const s = art && art.sourcePixels;
  if (s && s.w > 0 && s.h > 0) return { w: Number(s.w), h: Number(s.h), source: "source" };
  const pd = (art && art.printDimensions) || {};
  return { w: Number(pd.pixelWidth) || 0, h: Number(pd.pixelHeight) || 0, source: "print" };
}

/**
 * Pixels the piece can reach for sizing: its real pixels, or — when the catalog
 * enables on-demand AI upscaling and the piece has no saved enhancement yet —
 * real pixels x upscale.factor (capped at upscale.maxLongEdge). Canvas-cropped
 * photos are not upscaled on demand (their source includes the floor).
 */
export function potentialPixels(art, catalog) {
  const px = effectivePixels(art);
  const up = catalog && catalog.upscale;
  if (!up || px.source === "enhanced" || (art && art.canvasCropped)) return px;
  const f = Math.max(1, Math.min(Number(up.factor) || 1, (Number(up.maxLongEdge) || Infinity) / Math.max(px.w, px.h, 1)));
  return { w: Math.floor(px.w * f), h: Math.floor(px.h * f), source: "upscale" };
}

export function orientationFor(art) {
  const px = effectivePixels(art);
  return px.w > px.h * 1.02 ? "horizontal" : "vertical";
}

/**
 * Every option the artwork can be sold as, grouped by material.
 * Returns [{ material, sizes: [{ id, w, h, price, ppi, label }] }] — materials
 * with no qualifying size are left out.
 */
export function optionsForArtwork(art, catalog) {
  const mats = (catalog && catalog.materials) || [];
  const tol = Number(catalog && catalog.aspectTolerance) || 0.1;
  const real = effectivePixels(art);
  const px = potentialPixels(art, catalog);
  if (!(px.w > 0 && px.h > 0)) return [];
  const realLong = Math.max(real.w, real.h), realShort = Math.min(real.w, real.h);
  const artLong = Math.max(px.w, px.h), artShort = Math.min(px.w, px.h);
  const artRatio = artShort / artLong;
  const out = [];
  for (const m of mats) {
    const sizes = [];
    for (const s of m.sizes || []) {
      const sLong = Math.max(s.w, s.h), sShort = Math.min(s.w, s.h);
      const sRatio = sShort / sLong;
      if (Math.abs(sRatio - artRatio) / artRatio > tol) continue;
      const ppi = Math.floor(Math.min(artLong / sLong, artShort / sShort));
      if (ppi < (Number(m.minPpi) || 150)) continue;
      if (!(Number(s.price) > 0)) continue;
      const landscape = px.w > px.h * 1.02;
      const dispW = landscape ? sLong : sShort, dispH = landscape ? sShort : sLong;
      // Needs the AI upscale when the real pixels alone fall short.
      const realPpi = Math.floor(Math.min(realLong / sLong, realShort / sShort));
      const needsUpscale = realPpi < (Number(m.minPpi) || 150);
      sizes.push({ id: s.id, w: dispW, h: dispH, price: Number(s.price), ppi, needsUpscale, label: `${dispW}\u2033 \u00d7 ${dispH}\u2033` });
    }
    if (sizes.length) out.push({ material: m, sizes });
  }
  return out;
}

export function startingPrice(art, catalog) {
  let min = Infinity;
  for (const g of optionsForArtwork(art, catalog)) for (const s of g.sizes) if (s.price < min) min = s.price;
  return Number.isFinite(min) ? min : 0;
}

export function optionKey(materialId, sizeId, frame) {
  return frame ? `${materialId}:${sizeId}:${slug(frame)}` : `${materialId}:${sizeId}`;
}

/**
 * Validate + resolve an option key for an artwork. Returns null when the
 * option is not offered for this artwork (wrong shape, too low-res, unknown).
 * { materialId, materialLabel, sizeId, sizeLabel, frame, price, variantId,
 *   placement, technique, orientation, label }
 */
export function resolveOption(art, catalog, key) {
  const k = String(key || "");
  if (!OPTION_PATTERN.test(k)) return null;
  const [materialId, sizeId, frameSlug] = k.split(":");
  const group = optionsForArtwork(art, catalog).find(g => g.material.id === materialId);
  if (!group) return null;
  const size = group.sizes.find(s => s.id === sizeId);
  if (!size) return null;
  const m = group.material;
  const raw = (m.sizes || []).find(s => s.id === sizeId);
  let frame = "";
  let variantId = 0;
  if (Array.isArray(m.frames) && m.frames.length) {
    frame = m.frames.find(f => slug(f) === frameSlug) || "";
    if (!frame) return null;
    variantId = Number(raw.variants && raw.variants[frame]) || 0;
  } else {
    if (frameSlug) return null;
    variantId = Number(raw.variants && (raw.variants.default || Object.values(raw.variants)[0])) || 0;
  }
  if (!variantId) return null;
  const label = `${m.label}, ${size.label}${frame ? `, ${frame} frame` : ""}`;
  return {
    key: k, materialId, materialLabel: m.label, sizeId, sizeLabel: size.label, frame,
    price: size.price, ppi: size.ppi, variantId, needsUpscale: !!size.needsUpscale,
    shipping: Number(raw.shipping || m.shipping) || 0,
    placement: m.placement || "default", technique: m.technique || "digital",
    orientation: orientationFor(art), label,
  };
}

/** The option a bare "add to cart" (or a legacy v1 cart line) maps to. */
export function defaultOptionKey(art, catalog) {
  const groups = optionsForArtwork(art, catalog);
  if (!groups.length) return "";
  const g = groups.find(x => x.material.id === "canvas") || groups[0];
  const s = g.sizes.find(x => Math.max(x.w, x.h) >= 24) || g.sizes[g.sizes.length - 1];
  const frame = Array.isArray(g.material.frames) && g.material.frames.length ? g.material.frames[0] : "";
  return optionKey(g.material.id, s.id, frame);
}
