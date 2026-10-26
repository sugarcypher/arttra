import { optionsForArtwork, resolveOption, defaultOptionKey, startingPrice, optionKey, slug } from "./shared/options.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE_KEY = "arttra_cart_v2";
const LEGACY_STORAGE_KEY = "arttra_cart_v1";
let config = { siteName: "arttra.art", checkoutUrl: "#", currency: "USD" };
let products = { materials: [] };
let artworks = [];
// Current picker selection in the open modal.
let pick = { material: "", size: "", frame: "" };
let state = { category: "all", color: null, query: "", selectedArtwork: null, hue: null, mono: false, big: false };

// ---- Environment ----
const mq = (q) => window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener() {} };
const reducedMotionMQ = mq("(prefers-reduced-motion: reduce)");
const reduceMotion = () => reducedMotionMQ.matches;
const saveData = !!(navigator.connection && navigator.connection.saveData);
const finePointer = mq("(hover: hover) and (pointer: fine)").matches;
const isNarrow = () => window.innerWidth < 700;

function fmt(amount) {
  try { const whole = Number.isInteger(Number(amount)); return new Intl.NumberFormat(undefined, { style: "currency", currency: config.currency, ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}) }).format(amount); }
  catch { return `$${amount.toFixed(0)}`; }
}
function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
function safeColor(s) { return /^#[0-9a-fA-F]{3,8}$/.test(String(s||"")) ? String(s) : "#000000"; }
function safeUrl(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  if (/^(https?:|data:image\/)/i.test(v)) return esc(v);
  if (/^[./]/.test(v) && !/^javascript:/i.test(v)) return esc(v);
  return "";
}
// Raw (un-escaped) URL for DOM properties / CSS, same allow-list as safeUrl.
function rawUrl(s) {
  const v = String(s || "").trim();
  if (/^https?:/i.test(v) || (/^[./]/.test(v) && !/^javascript:/i.test(v))) return v;
  return "";
}
function cssUrl(s) { const v = rawUrl(s); return v ? `url("${v.replace(/["\\\n\r]/g, "")}")` : "none"; }
function slugCode(value, fallback = "GEN") {
  const s = String(value || fallback).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (s || fallback).split("-").map(part => part.slice(0, 3)).join("").slice(0, 8);
}
function fnv1aHash(input) {
  let h = 0x811c9dc5;
  const s = String(input || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
function identityPayload(art) {
  return JSON.stringify({
    id: art.id || "",
    title: art.title || "",
    sourceFile: art.sourceFile || art.image || art.thumb || "",
    system: art.system || "",
    seed: art.seed || "",
    paramsHash: art.paramsHash || "",
    style: art.style || "",
    category: art.category || ""
  });
}
function buildSku(art) {
  const system = slugCode(art.system || art.style || art.category || "ART", "ART");
  const medium = slugCode(art.medium || art.defaultMedium || (art.bestProducts||[])[0] || "PRT", "PRT");
  const hash = (art.identityHash || art.paramsHash || fnv1aHash(identityPayload(art))).replace(/[^A-F0-9]/gi, "").toUpperCase().slice(0, 6);
  return `ARTTRA-${system}-${medium}-${hash}`;
}
function normalizeArtworkIdentity(art) {
  art.identityHash = art.identityHash || fnv1aHash(identityPayload(art));
  art.sku = art.sku || buildSku(art);
  art.pipelineVersion = art.pipelineVersion || config.pipelineVersion || "arttra-pipeline-v1";
  art.editionType = art.editionType || (art.system ? "generated-state" : "open");
  return art;
}
function normalizeArtworks(list) {
  return (Array.isArray(list) ? list : [])
    .filter(a => a && a.hidden !== true)
    .map(normalizeArtworkIdentity);
}

function findArt(id) { return artworks.find(x=>String(x.id)===String(id)); }
function getCart() {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
    // One-time migration: v1 lines had no option; give them the default.
    const old = localStorage.getItem(LEGACY_STORAGE_KEY);
    return old ? JSON.parse(old).map(i => ({ artId: i.artId, option: "", qty: i.qty || 1 })) : [];
  } catch { return []; }
}
function setCart(items) { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); localStorage.removeItem(LEGACY_STORAGE_KEY); }
// Resolve a cart line to its option (price, label). Lines whose option is no
// longer offered are dropped by sanitizeCart().
// Until the checkout Worker that understands options is live, the store keeps
// the old single-price flow so nobody is charged the wrong amount.
let optionsLive = false;
function lineOption(it) {
  const a = findArt(it.artId); if (!a) return null;
  if (!optionsLive) { const p = a.priceTiers?.startingPrice || 0; return p ? { price: p, label: a.sku, key: "" } : null; }
  return resolveOption(a, products, it.option || defaultOptionKey(a, products));
}
function sanitizeCart() {
  if (!optionsLive || !artworks.length || !products.materials.length) return;
  const items = getCart().map(it => {
    const a = findArt(it.artId); if (!a) return null;
    const key = it.option || defaultOptionKey(a, products);
    return resolveOption(a, products, key) ? { ...it, option: key } : null;
  }).filter(Boolean);
  setCart(items);
}
function cartCount(items) { return items.reduce((s,i)=>s+(i.qty||0),0); }
function cartTotal(items) {
  let t=0;
  for (const i of items) { const o=lineOption(i); if (o) t+=o.price*(i.qty||0); }
  return t;
}

function matchesFilters(art) {
  if (state.category !== "all") {
    const cat = state.category.toLowerCase();
    const artCat = (art.category||"").toLowerCase();
    const artStyle = (art.style||"").toLowerCase();
    if (cat === "art prints" && artCat !== "art prints") return false;
    if (cat === "metal art" && artCat !== "metal art") return false;
    if (cat === "photography" && artCat !== "photography") return false;
    if (cat === "painting" && artStyle !== "chromata" && artStyle !== "naturalis") return false;
    if (cat === "digital" && artStyle !== "luminos" && artStyle !== "intricata") return false;
    if (cat === "multimedia" && artStyle !== "intricata" && artCat !== "art prints") return false;
    if (cat === "graphic" && artStyle !== "starkform" && artStyle !== "ironwork") return false;
  }
  if (state.color) {
    const named = art.namedColors || [];
    if (!named.some(nc => nc.name === state.color)) return false;
  }
  if (state.big && !(art._maxLong >= 40)) return false;
  if (state.query) {
    const hay = [art.title, art.sku, art.identityHash, art.pipelineVersion, art.editionType, art.sourceFile, art.system, art.style, art.category,
      (art.namedColors||[]).map(c=>c.name).join(" "),
      (art.seoKeywords||[]).join(" ")
    ].join(" ").toLowerCase();
    if (!hay.includes(state.query.toLowerCase())) return false;
  }
  return true;
}

function fromLine(art) {
  const p = startingPrice(art, products);
  if (!p) return esc(art.sku);
  const maxLong = Math.max(...optionsForArtwork(art, products).flatMap(g => g.sizes.map(s => Math.max(s.w, s.h))));
  return `From ${esc(fmt(p))} \u00b7 up to ${esc(String(maxLong))}\u2033`;
}

// ---- Color math (palette -> HSL) ----
function hexToRgb(hex) {
  let h = safeColor(hex).slice(1);
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l, c: s * (1 - Math.abs(2 * l - 1)) };
}
function hueDist(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function avgColor(pal) {
  if (!pal.length) return "#16140f";
  const acc = [0, 0, 0];
  for (const h of pal) { const c = hexToRgb(h); acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; }
  return "#" + acc.map(v => Math.round(v / pal.length).toString(16).padStart(2, "0")).join("");
}
function hueScore(art, H) {
  let best = 0, sum = 0;
  for (const c of art._hsl) {
    const close = Math.max(0, 1 - hueDist(H, c.h) / 48);
    const v = Math.pow(c.c, .7) * close * close;
    if (v > best) best = v; sum += v;
  }
  return best + .18 * (sum / Math.max(1, art._hsl.length));
}
const HUE_NAMES = [[0,"Red"],[16,"Vermilion"],[30,"Orange"],[42,"Amber"],[54,"Gold"],[66,"Yellow"],[85,"Chartreuse"],[115,"Green"],[150,"Jade"],[172,"Teal"],[190,"Cyan"],[208,"Azure"],[228,"Blue"],[250,"Indigo"],[272,"Violet"],[292,"Purple"],[315,"Magenta"],[336,"Rose"],[352,"Crimson"],[360,"Red"]];
function hueName(h) { let best = HUE_NAMES[0]; for (const n of HUE_NAMES) if (hueDist(n[0], h) < hueDist(best[0], h)) best = n; return best[1]; }
// Spectrum stops: position (0..1) -> hue, so the ribbon colour under the
// finger is exactly the hue we sort by.
const SPECTRUM = [[0,0],[28,62,50],[48,72,54],[80,45,45],[140,38,40],[178,42,40],[205,55,46],[235,45,52],[270,40,50],[310,42,50],[345,55,50],[360,62,50]].map((s, i, a) => ({ p: i / (a.length - 1), h: s[0], s: s[1] ?? 62, l: s[2] ?? 50 }));
function spectrumAt(p) {
  p = Math.min(1, Math.max(0, p));
  for (let i = 1; i < SPECTRUM.length; i++) {
    const a = SPECTRUM[i - 1], b = SPECTRUM[i];
    if (p <= b.p) { const t = (p - a.p) / (b.p - a.p || 1); return { h: a.h + (b.h - a.h) * t, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t }; }
  }
  return SPECTRUM[SPECTRUM.length - 1];
}
function spectrumPos(h) {
  for (let i = 1; i < SPECTRUM.length; i++) { const a = SPECTRUM[i - 1], b = SPECTRUM[i]; if (h <= b.h) return a.p + (b.p - a.p) * ((h - a.h) / (b.h - a.h || 1)); }
  return 1;
}

function prepArt(art) {
  const sp = art.sourcePixels || {}, pd = art.printDimensions || {};
  const w = Number(sp.w) || Number(pd.pixelWidth) || 4, h = Number(sp.h) || Number(pd.pixelHeight) || 5;
  art._w = w; art._h = h; art._ratio = h / w;
  const pal = (art.colorPalette || []).filter(x => /^#[0-9a-fA-F]{3,8}$/.test(x));
  art._hsl = pal.map(x => rgbToHsl(hexToRgb(x)));
  art._chroma = art._hsl.reduce((m, c) => Math.max(m, c.c), 0);
  art._dom = avgColor(pal);
  art._edge = pal[Math.min(2, pal.length - 1)] || art._dom;
}
function prepOptions(art) {
  const groups = optionsForArtwork(art, products);
  art._groups = groups;
  art._maxLong = groups.length ? Math.max(...groups.flatMap(g => g.sizes.map(s => Math.max(s.w, s.h)))) : 0;
}

// ---- Scroll lock + layers (focus trap, Esc) ----
let lockCount = 0;
function lockScroll() { if (lockCount++ === 0) document.body.classList.add("is-locked"); }
function unlockScroll() { lockCount = Math.max(0, lockCount - 1); if (!lockCount) document.body.classList.remove("is-locked"); }
const layers = []; // [{el, close, returnFocus}]
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
function focusables(root) { return $$(FOCUSABLE, root).filter(el => !el.hidden && el.getClientRects().length && !el.closest("[hidden]")); }
function pushLayer(el, close) { layers.push({ el, close, returnFocus: document.activeElement }); }
function popLayer(el) {
  const i = layers.findIndex(l => l.el === el); if (i < 0) return;
  const [l] = layers.splice(i, 1);
  if (l.returnFocus && document.contains(l.returnFocus) && typeof l.returnFocus.focus === "function") { try { l.returnFocus.focus({ preventScroll: true }); } catch {} }
}
document.addEventListener("keydown", (e) => {
  const top = layers[layers.length - 1]; if (!top) return;
  if (e.key === "Escape") { e.preventDefault(); top.close(); return; }
  if (e.key === "Tab") {
    const f = focusables(top.el); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!top.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// =====================================================================
// GALLERY — JS masonry with real aspect ratios, FLIP via transform transitions
// =====================================================================
const grid = $("#cardsGrid");
const cardEls = new Map();
let visible = [];      // current display order (filtered + sorted)
let layoutPos = new Map();

function cardHtml(art) {
  const thumb = art.thumb || art.image || "";
  const swatches = (art.colorPalette||[]).slice(0,4);
  const from = fromLine(art);
  return `<span class="card__in"><span class="card__imgWrap" style="--c:${safeColor(art._dom)}"><img class="card__img" data-src="${safeUrl(thumb)}" alt="${esc(art.title)}" width="${art._w}" height="${art._h}" loading="lazy" decoding="async" />${art._maxLong >= 55 ? `<span class="card__big">Large format</span>` : ""}<span class="card__glare"></span></span><span class="card__body"><span class="card__title">${esc(art.title)}</span><span class="card__sku">${from}</span><span class="card__sub"><span>${esc(art.style||"")}</span><span class="card__swatches">${swatches.map(h=>`<span class="swatch" style="--c:${safeColor(h)}"></span>`).join("")}</span></span></span></span>`;
}
function buildCards() {
  const frag = document.createDocumentFragment();
  for (const art of artworks) {
    const a = document.createElement("a");
    a.className = "card";
    a.href = "#art=" + encodeURIComponent(art.id);
    a.dataset.id = art.id;
    a.dataset.cursor = "View";
    a.innerHTML = cardHtml(art);
    const img = a.querySelector("img");
    const done = () => img.classList.add("is-loaded");
    img.addEventListener("load", done, { once: true }); img.addEventListener("error", done, { once: true });
    cardEls.set(String(art.id), a);
    frag.appendChild(a);
  }
  grid.textContent = "";
  grid.appendChild(frag);
}
// Our own lazy loader: native loading=lazy thresholds vary a lot by browser
// and connection (mobile Chrome fetched all 201 thumbs), so a card's thumb is
// requested only when the card comes within ~1.5 screens of the viewport.
let thumbIO = null;
function loadThumb(card) { const img = card.querySelector("img[data-src]"); if (img) { img.src = img.dataset.src; img.removeAttribute("data-src"); } }
function observeThumbs() {
  if (!("IntersectionObserver" in window)) { cardEls.forEach(loadThumb); return; }
  thumbIO = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { loadThumb(en.target); thumbIO.unobserve(en.target); }
  }, { rootMargin: (saveData ? "300px" : "900px") + " 0px" });
  cardEls.forEach(el => thumbIO.observe(el));
}
function computeOrder() {
  let list = artworks.filter(matchesFilters);
  if (state.hue != null) {
    const H = state.hue;
    list = list.map((a, i) => ({ a, i, s: hueScore(a, H) })).sort((x, y) => (y.s - x.s) || (x.i - y.i)).map(x => x.a);
  } else if (state.mono) {
    list = list.map((a, i) => ({ a, i })).sort((x, y) => (x.a._chroma - y.a._chroma) || (x.i - y.i)).map(x => x.a);
  }
  return list;
}
function layout({ animate = true, stagger = false } = {}) {
  if (!grid) return;
  const W = grid.clientWidth; if (!W) return;
  const cols = W >= 1180 ? 4 : W >= 760 ? 3 : 2;
  const gap = W < 700 ? 10 : 16;
  const colW = (W - gap * (cols - 1)) / cols;
  const bodyH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bodyH")) || 84;
  const heights = new Array(cols).fill(0);
  const shown = new Set(visible.map(a => String(a.id)));
  if (!animate || reduceMotion()) grid.classList.add("no-anim");
  layoutPos = new Map();
  visible.forEach((art, i) => {
    const el = cardEls.get(String(art.id)); if (!el) return;
    const imgH = Math.round(colW * art._ratio);
    const h = imgH + bodyH + 2;
    let c = 0; for (let k = 1; k < cols; k++) if (heights[k] < heights[c] - 1) c = k;
    const x = Math.round(c * (colW + gap)), y = Math.round(heights[c]);
    heights[c] += h + gap;
    el.style.width = colW + "px";
    el.style.height = h + "px";
    el.firstElementChild.firstElementChild.style.height = imgH + "px";
    el.style.setProperty("--x", x + "px");
    el.style.setProperty("--y", y + "px");
    el.style.setProperty("--d", stagger ? Math.min(i * 7, 420) + "ms" : "0ms");
    el.classList.remove("is-out");
    el.removeAttribute("aria-hidden"); el.removeAttribute("tabindex");
    layoutPos.set(String(art.id), { x, y, col: c, i });
  });
  for (const [id, el] of cardEls) if (!shown.has(id)) { el.classList.add("is-out"); el.setAttribute("aria-hidden", "true"); el.tabIndex = -1; }
  grid.style.height = Math.max(0, Math.max(...heights) - gap) + "px";
  if (grid.classList.contains("no-anim")) { void grid.offsetHeight; requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.remove("no-anim"))); }
}
function renderCards(opts = { stagger: true }) {
  visible = computeOrder();
  const meta = $("#resultMeta");
  let txt = `${visible.length} piece${visible.length===1?"":"s"}`;
  if (state.hue != null) txt += ` \u00b7 nearest ${hueName(state.hue).toLowerCase()} first`;
  else if (state.mono) txt += " \u00b7 monochrome first";
  meta.textContent = txt;
  $("#emptyState").hidden = visible.length > 0;
  layout({ animate: true, ...opts });
}
let resizeRaf = 0;
if ("ResizeObserver" in window) new ResizeObserver(() => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => layout({ animate: false })); }).observe(grid);
else window.addEventListener("resize", () => layout({ animate: false }));

grid.addEventListener("click", (e) => {
  const card = e.target.closest(".card"); if (!card) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let new-tab work
  e.preventDefault();
  openDetail(findArt(card.dataset.id), { push: true, fromEl: card.querySelector(".card__img") });
});
// Arrow keys move focus between works (←/→ in order, ↑/↓ by column).
grid.addEventListener("keydown", (e) => {
  const card = e.target.closest(".card"); if (!card) return;
  const id = card.dataset.id, pos = layoutPos.get(id); if (!pos) return;
  let next = null;
  if (e.key === "ArrowRight") next = visible[pos.i + 1];
  else if (e.key === "ArrowLeft") next = visible[pos.i - 1];
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const down = e.key === "ArrowDown"; let best = null, bd = Infinity;
    for (const a of visible) { const p = layoutPos.get(String(a.id)); if (!p || p.col !== pos.col) continue; const d = down ? p.y - pos.y : pos.y - p.y; if (d > 0 && d < bd) { bd = d; best = a; } }
    next = best;
  } else return;
  e.preventDefault();
  if (next) { const el = cardEls.get(String(next.id)); el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" }); }
});
// Subtle 3D tilt + glare on desktop hover.
if (finePointer) {
  let tiltRaf = 0, tiltEv = null, tilted = null;
  grid.addEventListener("pointermove", (e) => {
    if (reduceMotion()) return;
    tiltEv = e; if (tiltRaf) return;
    tiltRaf = requestAnimationFrame(() => {
      tiltRaf = 0; const ev = tiltEv; const card = ev.target.closest && ev.target.closest(".card");
      if (tilted && tilted !== card) resetTilt(tilted);
      if (!card) { tilted = null; return; }
      const r = card.getBoundingClientRect(); const px = (ev.clientX - r.left) / r.width, py = (ev.clientY - r.top) / r.height;
      const inn = card.firstElementChild;
      inn.style.setProperty("--tx", ((px - .5) * 7).toFixed(2) + "deg");
      inn.style.setProperty("--ty", ((.5 - py) * 7).toFixed(2) + "deg");
      inn.style.setProperty("--gx", (px * 100).toFixed(1) + "%"); inn.style.setProperty("--gy", (py * 100).toFixed(1) + "%");
      inn.style.transform = `perspective(900px) rotateX(${((.5 - py) * 7).toFixed(2)}deg) rotateY(${((px - .5) * 7).toFixed(2)}deg) translateY(-4px)`;
      tilted = card;
    });
  });
  grid.addEventListener("pointerleave", () => { if (tilted) resetTilt(tilted); tilted = null; });
  function resetTilt(card) { const inn = card.firstElementChild; inn.style.transform = ""; }
}

// ---- Filters: categories, named colours, search, toggles ----
function renderColorBar() {
  const bar = $("#colorBar");
  const map = new Map();
  for (const a of artworks) for (const nc of (a.namedColors||[])) if (!map.has(nc.name)) map.set(nc.name, nc);
  const sorted = Array.from(map.values()).sort((a,b)=>a.name.localeCompare(b.name));
  let html = '<span class="colorbar__label">Color</span>';
  html += `<button type="button" class="cpill cpill--active" data-color="" aria-pressed="true">All</button>`;
  for (const nc of sorted) html += `<button type="button" class="cpill" data-color="${esc(nc.name)}" aria-pressed="false"><span class="cpill__dot" style="--c:${safeColor(nc.hex)}"></span>${esc(nc.name)}</button>`;
  bar.innerHTML = html;
  bar.querySelectorAll(".cpill").forEach(btn => btn.addEventListener("click", () => { state.color = btn.dataset.color || null; bar.querySelectorAll(".cpill").forEach(b=>{ b.classList.remove("cpill--active"); b.setAttribute("aria-pressed","false"); }); btn.classList.add("cpill--active"); btn.setAttribute("aria-pressed","true"); renderCards(); }));
}
function initCatNav() {
  $$(".catnav__link[data-cat]").forEach(btn => btn.addEventListener("click", () => { $$(".catnav__link[data-cat]").forEach(b=>{ b.classList.remove("catnav__link--active"); b.setAttribute("aria-pressed","false"); }); btn.classList.add("catnav__link--active"); btn.setAttribute("aria-pressed","true"); state.category = btn.dataset.cat; renderCards(); }));
}
function initToggles() {
  const big = $("#bigToggle"), mono = $("#monoToggle");
  if (!optionsLive) big.hidden = true;
  big.addEventListener("click", () => { state.big = !state.big; big.setAttribute("aria-pressed", String(state.big)); renderCards(); });
  mono.addEventListener("click", () => {
    state.mono = !state.mono; mono.setAttribute("aria-pressed", String(state.mono));
    if (state.mono) clearHue(false);
    renderCards();
  });
  $$("[data-surprise]").forEach(b => b.addEventListener("click", surprise));
  const search = $("#searchInput");
  let t = 0;
  search.addEventListener("input", e => { state.query = e.target.value || ""; search.classList.toggle("has-value", !!state.query); clearTimeout(t); t = setTimeout(() => renderCards(), 120); });
}
function surprise() {
  const pool = (visible.length ? visible : artworks).filter(a => !optionsLive || a._groups.length);
  const list = pool.length ? pool : artworks;
  if (!list.length) return;
  const cur = state.selectedArtwork;
  let a = list[Math.floor(Math.random() * list.length)];
  if (cur && list.length > 1 && a === cur) a = list[(list.indexOf(a) + 1) % list.length];
  openDetail(a, { push: !viewerOpen() });
  if (viewerOpen()) history.replaceState({ art: a.id }, "", "#art=" + encodeURIComponent(a.id));
}

// ---- Spectrum ribbon: drag / tap to sort by hue ----
const spectrum = $("#spectrum");
function setSpectrumBg() {
  spectrum.style.background = "linear-gradient(90deg," + SPECTRUM.map(s => `hsl(${s.h} ${s.s}% ${s.l}%) ${(s.p * 100).toFixed(1)}%`).join(",") + ")";
}
let hueRaf = 0, lastSort = 0, pendingHue = null;
function applyHue(h, { final = false } = {}) {
  state.hue = ((h % 360) + 360) % 360;
  if (state.mono) { state.mono = false; $("#monoToggle").setAttribute("aria-pressed", "false"); }
  const p = spectrumPos(state.hue), c = spectrumAt(p);
  spectrum.classList.add("is-active");
  spectrum.style.setProperty("--x", (p * 100).toFixed(2) + "%");
  spectrum.style.setProperty("--hue-c", `hsl(${c.h} ${c.s}% ${c.l}%)`);
  $("#spectrumName").textContent = hueName(state.hue);
  spectrum.setAttribute("aria-valuenow", String(Math.round(state.hue)));
  spectrum.setAttribute("aria-valuetext", hueName(state.hue) + " first");
  $("#spectrumClear").hidden = false;
  // Throttle the re-sort while dragging so the FLIP animation can breathe.
  pendingHue = state.hue;
  const now = performance.now();
  if (final || now - lastSort > 140) { lastSort = now; renderCards({ stagger: final }); pendingHue = null; }
  else if (!hueRaf) hueRaf = setTimeout(() => { hueRaf = 0; if (pendingHue != null) { lastSort = performance.now(); renderCards({ stagger: false }); pendingHue = null; } }, 150);
}
function clearHue(rerender = true) {
  state.hue = null;
  spectrum.classList.remove("is-active");
  spectrum.setAttribute("aria-valuetext", "Not sorted");
  $("#spectrumClear").hidden = true;
  if (rerender) renderCards();
}
function initSpectrum() {
  setSpectrumBg();
  let dragging = false;
  const fromEvent = (e) => { const r = spectrum.getBoundingClientRect(); return spectrumAt((e.clientX - r.left) / r.width).h; };
  spectrum.addEventListener("pointerdown", (e) => {
    dragging = true; spectrum.setPointerCapture(e.pointerId); spectrum.classList.add("is-dragging");
    // Bring the top of the grid into view so the reorder is visible.
    const gTop = grid.getBoundingClientRect().top, navB = $("#catnav").getBoundingClientRect().bottom;
    if (gTop < navB - 60 || gTop > window.innerHeight * .7) {
      const y = window.scrollY + grid.getBoundingClientRect().top - navB - 12;
      window.scrollTo({ top: y, behavior: reduceMotion() ? "auto" : "smooth" });
    }
    applyHue(fromEvent(e));
  });
  spectrum.addEventListener("pointermove", (e) => { if (dragging) applyHue(fromEvent(e)); });
  const end = (e) => { if (!dragging) return; dragging = false; spectrum.classList.remove("is-dragging"); applyHue(fromEvent(e), { final: true }); };
  spectrum.addEventListener("pointerup", end);
  spectrum.addEventListener("pointercancel", () => { dragging = false; spectrum.classList.remove("is-dragging"); });
  spectrum.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 30 : 10;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); applyHue((state.hue ?? 0) + step, { final: true }); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); applyHue((state.hue ?? 0) - step + 360, { final: true }); }
    else if (e.key === "Home") { e.preventDefault(); applyHue(0, { final: true }); }
    else if (e.key === "End") { e.preventDefault(); applyHue(350, { final: true }); }
    else if (e.key === "Escape" || e.key === "Delete" || e.key === "Backspace") { if (state.hue != null) { e.preventDefault(); clearHue(); } }
  });
  $("#spectrumClear").addEventListener("click", () => { clearHue(); spectrum.focus(); });
}

// =====================================================================
// HERO — living mosaic of real thumbs (loaded after first paint)
// =====================================================================
function buildMosaic() {
  const plane = $("#mosaicPlane"); if (!plane || !artworks.length) return;
  const narrow = isNarrow();
  const cols = narrow ? 5 : 8, per = saveData ? 2 : 3;
  const pool = artworks.filter(a => a.thumb).slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const picks = pool.slice(0, cols * per);
  const vw = window.innerWidth, heroH = ($(".hero") || document.body).clientHeight || window.innerHeight;
  const colW = narrow ? vw * .34 : Math.min(240, Math.max(120, vw * .14)), gap = narrow ? 10 : 16;
  const planeH = heroH * 1.8;
  let html = "";
  for (let c = 0; c < cols; c++) {
    const set = picks.slice(c * per, c * per + per);
    if (!set.length) break;
    const tiles = set.map(a => `<button type="button" class="mtile" tabindex="-1" data-id="${esc(a.id)}" data-cursor="View" style="--c:${safeColor(a._dom)};aspect-ratio:${a._w}/${a._h}"><img src="${safeUrl(a.thumb)}" alt="" decoding="async" width="${a._w}" height="${a._h}" /></button>`).join("");
    // Repeat the set (same URLs -> one download each) so the drift loops
    // seamlessly and always covers the tilted plane.
    const setPx = set.reduce((s, a) => s + colW * a._ratio + gap, 0);
    const copies = reduceMotion() ? Math.max(1, Math.ceil(planeH / setPx)) : Math.max(2, Math.ceil(planeH / setPx) + 1);
    const dur = ((60 + Math.random() * 40) * copies / 2).toFixed(0);
    const offset = (-Math.random() * dur).toFixed(1);
    html += `<div class="mcol" style="--dur:${dur}s;--shift:${(-100 / copies).toFixed(4)}%;animation-delay:${offset}s">${tiles.repeat(copies)}</div>`;
  }
  plane.innerHTML = html;
  $$("img", plane).forEach(img => { const done = () => img.classList.add("is-loaded"); if (img.complete && img.naturalWidth) done(); else img.addEventListener("load", done, { once: true }); });
  plane.addEventListener("click", (e) => { const t = e.target.closest(".mtile"); if (t) openDetail(findArt(t.dataset.id), { push: true, fromEl: t }); });
  // Pointer / gyro parallax.
  const hero = $(".hero");
  if (!reduceMotion()) {
    let raf = 0, mx = 0, my = 0;
    const apply = () => { raf = 0; plane.style.setProperty("--mx", mx.toFixed(3)); plane.style.setProperty("--my", my.toFixed(3)); };
    hero.addEventListener("pointermove", (e) => { if (e.pointerType !== "mouse") return; mx = (e.clientX / window.innerWidth - .5) * 2; my = (e.clientY / window.innerHeight - .5) * 2; if (!raf) raf = requestAnimationFrame(apply); });
    window.addEventListener("deviceorientation", (e) => { if (e.gamma == null) return; mx = Math.max(-1, Math.min(1, e.gamma / 25)); my = Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 25)); if (!raf) raf = requestAnimationFrame(apply); }, { passive: true });
  }
  if ("IntersectionObserver" in window) new IntersectionObserver(([en]) => hero.classList.toggle("is-paused", !en.isIntersecting)).observe(hero);
}

// =====================================================================
// DETAIL VIEWER — true-scale wall preview
// =====================================================================
const overlay = $("#modalOverlay");
const wallEl = $("#wall"), pieceEl = $("#piece"), stageEl = $("#stage");
const SOFA_W = 84, SOFA_H = 33, PERSON_H = 69, PERSON_W = 22;
const FRAME_COLORS = { black: "#161514", white: "#efede7", "red-oak": "linear-gradient(90deg,#7b4a2a,#a46a40 30%,#8b5a35 60%,#a8703f)" };
const WALLS = [
  { key: "gallery", name: "Gallery white", c: "#e9e6df" },
  { key: "plaster", name: "Warm plaster", c: "#d8ccba" },
  { key: "greige", name: "Greige", c: "#b3aa9c" },
  { key: "sage", name: "Sage", c: "#97a08b" },
  { key: "night", name: "Night", c: "#222120" },
];
let viewer = { art: null, mode: "wall", wall: "gallery", pushed: false, list: [] };
const viewerOpen = () => !overlay.hidden;

function artTones(art) {
  const sorted = art._hsl.slice().sort((a, b) => b.c - a.c);
  const base = sorted[0] || { h: 30, s: .2 };
  const s = Math.min(base.s, .38);
  const toHex = (h, s, l) => { const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return "#" + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join(""); };
  return [
    { key: "art-pale", name: `Pale ${hueName(base.h).toLowerCase()} (from the art)`, c: toHex(base.h, s * .8, .8), art: true },
    { key: "art-deep", name: `Deep ${hueName(base.h).toLowerCase()} (from the art)`, c: toHex(base.h, Math.min(.42, base.s), .2), art: true },
  ];
}
function wallOptions(art) { return WALLS.concat(artTones(art)); }
function renderWallSwatches(art) {
  const box = $("#wallSwatches");
  const opts = wallOptions(art);
  if (!opts.some(o => o.key === viewer.wall)) viewer.wall = "gallery";
  box.innerHTML = `<span class="walls__k">Wall</span>` + opts.map(o => `<button type="button" class="wsw${o.art ? " wsw--art" : ""}" data-wall="${o.key}" style="--c:${safeColor(o.c)}" aria-pressed="${o.key === viewer.wall}" aria-label="${esc(o.name)}" title="${esc(o.name)}"></button>`).join("");
  box.querySelectorAll("[data-wall]").forEach(b => b.onclick = () => { viewer.wall = b.dataset.wall; box.querySelectorAll("[data-wall]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); applyWall(art); });
  applyWall(art);
}
function applyWall(art) {
  const o = wallOptions(art).find(x => x.key === viewer.wall) || WALLS[0];
  const l = rgbToHsl(hexToRgb(o.c)).l;
  wallEl.style.setProperty("--wall", o.c);
  stageEl.style.setProperty("--wall", o.c);
  wallEl.classList.toggle("is-dark", l < .42);
  wallEl.style.setProperty("--sil", l < .42 ? "rgba(255,255,255,.075)" : "rgba(40,30,20,.17)");
}

function selectedSize(art) {
  const g = (art._groups || []).find(x => x.material.id === pick.material);
  return g ? g.sizes.find(s => s.id === pick.size) : null;
}
function updateWall({ animateSize = false } = {}) {
  const art = viewer.art; if (!art) return;
  const W = wallEl.clientWidth, H = wallEl.clientHeight; if (!W || !H) return;
  const sel = selectedSize(art);
  const groups = art._groups || [];
  let w, h, known = !!sel;
  if (sel) { w = sel.w; h = sel.h; }
  else { const long = 24; if (art._w >= art._h) { w = long; h = Math.round(long * art._h / art._w); } else { h = long; w = Math.round(long * art._w / art._h); } }
  let maxW = w, maxH = h;
  for (const g of groups) for (const s of g.sizes) { maxW = Math.max(maxW, s.w); maxH = Math.max(maxH, s.h); }
  const floorPx = Math.round(Math.min(64, Math.max(22, H * .075)));
  const topReserve = isNarrow() ? 160 : 112;
  const usableH = H - floorPx - topReserve;
  const showPerson = W / Math.max(1, usableH) > .95;
  const half = Math.max(SOFA_W / 2, maxW / 2);
  const rightEdge = showPerson ? SOFA_W / 2 + 14 + PERSON_W : half;
  const needW = half + rightEdge + 14;
  const topIn = (hh) => Math.max(57 - hh / 2, SOFA_H + 8) + hh;
  const needH = Math.max(96, topIn(maxH) + 6);
  const scale = Math.max(1, Math.min(W / needW, usableH / needH));
  const originX = W / 2 - ((rightEdge - half) / 2) * scale;
  const bottomIn = Math.max(57 - h / 2, SOFA_H + 8);
  const mat = known ? pick.material : "paper";

  wallEl.style.setProperty("--floor", floorPx + "px");
  stageEl.style.setProperty("--floor", floorPx + "px");
  const sofa = $("#sofa"), person = $("#person");
  Object.assign(sofa.style, { left: (originX - SOFA_W / 2 * scale) + "px", width: SOFA_W * scale + "px", height: SOFA_H * scale + "px" });
  person.hidden = !showPerson;
  Object.assign(person.style, { left: (originX + (SOFA_W / 2 + 14) * scale) + "px", width: PERSON_W * scale + "px", height: PERSON_H * scale + "px" });

  const pw = w * scale, ph = h * scale;
  Object.assign(pieceEl.style, { left: (originX - pw / 2) + "px", bottom: (floorPx + bottomIn * scale) + "px", width: pw + "px", height: ph + "px" });
  pieceEl.className = "piece mat-" + mat;
  const fw = mat === "framed" ? Math.max(2, .75 * scale) : 0;
  const depth = mat === "canvas" ? Math.max(3, 1.25 * scale * .45) : 0;
  pieceEl.style.setProperty("--fw", fw + "px");
  pieceEl.style.setProperty("--depth", depth + "px");
  pieceEl.style.setProperty("--depth0", depth + "px");
  pieceEl.style.setProperty("--s", Math.min(10, Math.max(2, scale * .6)).toFixed(2) + "px");
  pieceEl.style.setProperty("--c", safeColor(art._edge));
  if (mat === "framed") pieceEl.style.setProperty("--frame", FRAME_COLORS[pick.frame] || FRAME_COLORS.black);
  const long = Math.max(w, h);
  if (known && long >= 36) pieceEl.classList.add("is-statement");
  if (mat === "metal" && !reduceMotion()) { void pieceEl.offsetWidth; pieceEl.classList.add("sheen-run"); }

  wallEl.classList.toggle("hide-dims", !known);
  $("#dimW").textContent = `${w}\u2033`;
  $("#dimH").textContent = `${h}\u2033`;
  const cm = (v) => Math.round(v * 2.54);
  $("#scaleSize").textContent = known ? `${w}\u2033 \u00d7 ${h}\u2033` : "";
  let note = "";
  if (known) {
    const pct = Math.round(w / SOFA_W * 100);
    note = `${cm(w)} \u00d7 ${cm(h)} cm`;
    if (long >= 36) note += isNarrow() ? " \u00b7 Statement scale" : ` \u00b7 Statement scale \u00b7 ${pct}% of the sofa\u2019s width`;
    else if (sel && art._maxLong >= 36 && long === Math.max(...((groups.find(g => g.material.id === pick.material) || { sizes: [] }).sizes.map(s => Math.max(s.w, s.h))))) note += ` \u00b7 largest in ${groups.find(g => g.material.id === pick.material).material.label.toLowerCase()}`;
  }
  $("#scaleNote").textContent = note;
  if (animateSize && !reduceMotion()) { const t = $("#scaleTag"); t.classList.remove("pop"); void t.offsetWidth; t.classList.add("pop"); }
  $("#stageCaption").textContent = known
    ? `True scale \u00b7 84\u2033 sofa${showPerson ? " \u00b7 5\u20329\u2033 figure" : ""}${isNarrow() ? "" : " \u00b7 hung at gallery height"}`
    : `Scale preview at 24\u2033 \u00b7 84\u2033 sofa${showPerson ? " \u00b7 5\u20329\u2033 figure" : ""}`;
  pieceEl.setAttribute("aria-label", `${art.title || "Artwork"} shown ${known ? `at ${w} by ${h} inches` : ""} on a wall above an 84 inch sofa`);
}
if ("ResizeObserver" in window) new ResizeObserver(() => { if (viewerOpen()) updateWall(); }).observe(wallEl);

function setMode(mode) {
  viewer.mode = mode;
  $("#modeWall").setAttribute("aria-pressed", String(mode === "wall"));
  $("#modeDetail").setAttribute("aria-pressed", String(mode === "detail"));
  const lv = $("#loupeView");
  lv.hidden = mode !== "detail";
  stageEl.classList.toggle("is-detail", mode === "detail");
  $("#wallSwatches").hidden = mode !== "wall";
  if (mode === "detail" && viewer.art) {
    const src = rawUrl(viewer.art.image || viewer.art.thumb);
    const di = $("#detailImage"); if (di.getAttribute("src") !== src) di.src = src;
    di.alt = viewer.art.title || "";
    $("#loupeHint").textContent = finePointer ? "Hover to magnify" : "Press and hold to magnify";
  }
}
// Loupe: hover (mouse) or press-and-hold (touch) to magnify the web image.
function initLoupe() {
  const lv = $("#loupeView"), loupe = $("#loupe"), img = $("#detailImage");
  let holdTimer = 0, active = false;
  const R = () => loupe.offsetWidth / 2 || 115;
  function move(e) {
    const r = img.getBoundingClientRect(), lr = lv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) { loupe.classList.remove("is-on"); return; }
    const Z = Math.max(2, Math.min(4, (img.naturalWidth || r.width * 2.5) / r.width * 1.1));
    loupe.style.backgroundImage = cssUrl(img.currentSrc || img.src);
    loupe.style.backgroundSize = `${r.width * Z}px ${r.height * Z}px`;
    loupe.style.backgroundPosition = `${-(x * Z - R())}px ${-(y * Z - R())}px`;
    loupe.style.left = (e.clientX - lr.left) + "px"; loupe.style.top = (e.clientY - lr.top) + "px";
    loupe.classList.add("is-on");
  }
  lv.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || active) move(e); });
  lv.addEventListener("pointerleave", () => loupe.classList.remove("is-on"));
  lv.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { active = true; lv.style.touchAction = "none"; try { lv.setPointerCapture(e.pointerId); } catch {} move(e); }, 180);
  });
  const up = () => { clearTimeout(holdTimer); active = false; lv.style.touchAction = ""; loupe.classList.remove("is-on"); };
  lv.addEventListener("pointerup", up); lv.addEventListener("pointercancel", up);
  lv.addEventListener("contextmenu", (e) => e.preventDefault());
  viewer.loupeActive = () => active;
}

function navList() {
  const art = viewer.art;
  return visible.includes(art) ? visible : artworks;
}
function step(dir) {
  const list = navList(); if (!list.length) return;
  const i = list.indexOf(viewer.art);
  const next = list[(i + dir + list.length) % list.length];
  openDetail(next, { push: false, dir });
  history.replaceState({ art: next.id }, "", "#art=" + encodeURIComponent(next.id));
}
function preloadNeighbours() {
  if (saveData) return;
  const list = navList(); const i = list.indexOf(viewer.art); if (i < 0 || list.length < 2) return;
  for (const d of [1, -1]) { const a = list[(i + d + list.length) % list.length]; const src = rawUrl(a.image); if (src) { const im = new Image(); im.decoding = "async"; im.src = src; } }
}

function populatePanel(art) {
  $("#modalSku").textContent = art.sku || "";
  $("#modalTitle").textContent = art.title || "Untitled";
  $("#modalDescription").textContent = art.description || "";
  $("#modalStyleBadge").textContent = art.style || "";
  $("#modalCategoryBadge").textContent = art.category || "";
  const colorsEl = $("#modalColors");
  colorsEl.innerHTML = (art.namedColors||[]).map(nc => `<div class="colorSwatch"><span class="colorSwatch__dot" style="--c:${safeColor(nc.hex)}"></span><span class="colorSwatch__hex">${esc(nc.name)}</span></div>`).join("");
  const identityEl = document.getElementById("modalIdentity");
  if (identityEl) identityEl.innerHTML = `<div>SKU: <strong>${esc(art.sku)}</strong></div><div>Identity hash: ${esc(art.identityHash)}</div><div>Edition: ${esc(art.editionType)}</div><div>Pipeline: ${esc(art.pipelineVersion)}</div>`;
}
function setPieceImage(art, dir) {
  const img = $("#modalImage");
  const thumb = rawUrl(art.thumb || art.image), web = rawUrl(art.image || art.thumb);
  img.alt = art.title || "";
  const token = (setPieceImage.t = (setPieceImage.t || 0) + 1);
  if (dir && !reduceMotion()) img.classList.add("is-swapping");
  img.src = thumb;
  img.onload = () => { img.classList.remove("is-swapping"); img.onload = null; };
  if (web && web !== thumb) {
    const hi = new Image(); hi.decoding = "async"; hi.src = web;
    const swap = () => { if (setPieceImage.t !== token) return; img.src = web; img.classList.remove("is-swapping"); preloadNeighbours(); };
    (hi.decode ? hi.decode() : Promise.resolve()).then(swap, swap);
  } else preloadNeighbours();
}

function openDetail(art, { push = true, fromEl = null, dir = 0 } = {}) {
  if (!art) return;
  normalizeArtworkIdentity(art);
  const wasOpen = viewerOpen();
  state.selectedArtwork = art;
  viewer.art = art;
  populatePanel(art);
  setPieceImage(art, dir);
  renderWallSwatches(art);
  initPicker(art);
  $("#buyNowLink").onclick = (e) => { e.preventDefault(); const k=currentKey(); if (!k) return; startCheckout([{ id: String(art.id), ...(optionsLive ? { option: k } : {}), qty: 1 }], e.currentTarget); };
  $("#addToCartBtn").onclick = () => { const k=currentKey(); if (!k) return; addToCart(String(art.id), optionsLive ? k : ""); flashAdded(); flyToCart(); };
  if (viewer.mode === "detail") setMode("detail");
  if (!wasOpen) {
    overlay.hidden = false;
    lockScroll();
    pushLayer(overlay, () => closeDetail());
    void overlay.offsetWidth;
    overlay.classList.add("is-open");
    setMode("wall");
    updateWall();
    if (fromEl && !reduceMotion() && pieceEl.animate) {
      const a = fromEl.getBoundingClientRect(), b = pieceEl.getBoundingClientRect();
      if (a.width && b.width) pieceEl.animate([
        { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: "0 0", opacity: .6 },
        { transform: "none", transformOrigin: "0 0", opacity: 1 }
      ], { duration: 650, easing: "cubic-bezier(.16,1,.3,1)" });
    }
    setTimeout(() => { if (viewerOpen()) $("#modalCloseBtn").focus({ preventScroll: true }); }, 60);
    $("#panel").scrollTop = 0;
  } else {
    updateWall();
    if (isNarrow()) { const d = $(".viewer__dialog"); if (d.scrollTop > 0) d.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" }); }
  }
  if (push) {
    const h = "#art=" + encodeURIComponent(art.id);
    if (location.hash !== h) { history.pushState({ art: art.id }, "", h); viewer.pushed = true; }
  }
  document.title = `${art.title || "Artwork"} — ARTTRA.ART`;
}
// Kept for compatibility with the old API name.
function openModal(art) { openDetail(art, { push: true }); }

function closeDetail({ fromHistory = false } = {}) {
  if (!viewerOpen()) return;
  overlay.classList.remove("is-open");
  setTimeout(() => { if (!overlay.classList.contains("is-open")) overlay.hidden = true; }, reduceMotion() ? 0 : 380);
  unlockScroll();
  popLayer(overlay);
  state.selectedArtwork = null;
  const art = viewer.art; viewer.art = null;
  document.title = "ARTTRA.ART — Original Art";
  if (!fromHistory && /^#art=/.test(location.hash)) {
    if (viewer.pushed && history.state && history.state.art) { viewer.pushed = false; history.back(); }
    else history.replaceState(null, "", location.pathname + location.search);
  }
  viewer.pushed = fromHistory ? false : viewer.pushed;
  // Return focus to the card of the work last viewed when it is on the page.
  const el = art && cardEls.get(String(art.id));
  if (el && !el.classList.contains("is-out") && document.activeElement === document.body) el.focus({ preventScroll: true });
}
function closeModal() { closeDetail(); }

function hashArtId() {
  const m = /^#art=([^&]+)/.exec(location.hash || "");
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
function syncFromHash() {
  const id = hashArtId();
  if (id) {
    const art = findArt(id);
    if (art && (!viewerOpen() || viewer.art !== art)) openDetail(art, { push: false });
  } else if (viewerOpen()) closeDetail({ fromHistory: true });
}

function initViewerControls() {
  $("#modalCloseBtn").addEventListener("click", () => closeDetail());
  $("#modeWall").addEventListener("click", () => setMode("wall"));
  $("#modeDetail").addEventListener("click", () => setMode("detail"));
  pieceEl.addEventListener("click", () => setMode("detail"));
  pieceEl.dataset.cursor = "Zoom";
  $("#prevArt").addEventListener("click", () => step(-1));
  $("#nextArt").addEventListener("click", () => step(1));
  overlay.addEventListener("keydown", (e) => {
    if (layers[layers.length - 1]?.el !== overlay) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  });
  // Swipe between works on the stage.
  let sx = 0, sy = 0, st = 0, tracking = false;
  stageEl.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" || e.target.closest("button")) return; tracking = true; sx = e.clientX; sy = e.clientY; st = performance.now(); });
  stageEl.addEventListener("pointerup", (e) => {
    if (!tracking) return; tracking = false;
    if (viewer.loupeActive && viewer.loupeActive()) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && performance.now() - st < 700) step(dx < 0 ? 1 : -1);
  });
  stageEl.addEventListener("pointercancel", () => { tracking = false; });
  initLoupe();
}

// ---- Size + material picker ----
function groupsFor(art) { return optionsForArtwork(art, products); }
function currentKey() {
  const art = state.selectedArtwork; if (!art) return "";
  if (!optionsLive) return "legacy";
  const g = groupsFor(art).find(x => x.material.id === pick.material);
  const frame = g && g.material.frames && g.material.frames.length ? pick.frame : "";
  const k = optionKey(pick.material, pick.size, frame);
  return resolveOption(art, products, k) ? k : "";
}
function initPicker(art) {
  const groups = groupsFor(art);
  const def = defaultOptionKey(art, products).split(":");
  pick = { material: def[0] || "", size: def[1] || "", frame: "" };
  const g = groups.find(x => x.material.id === pick.material);
  if (g && g.material.frames) pick.frame = slug(g.material.frames[0]);
  renderPicker();
}
function sizeGlyph(s, maxLong) {
  const k = 30 * Math.max(.3, Math.max(s.w, s.h) / maxLong);
  const r = s.w / s.h;
  const w = r >= 1 ? k : k * r, h = r >= 1 ? k / r : k;
  return `<span class="size__glyph" aria-hidden="true"><i style="width:${w.toFixed(1)}px;height:${h.toFixed(1)}px"></i></span>`;
}
function renderPicker(changed) {
  const art = state.selectedArtwork; if (!art) return;
  const groups = groupsFor(art);
  const box = $("#modalOptions");
  const buy = $("#buyNowLink"), add = $("#addToCartBtn");
  if (!groups.length && !optionsLive && art.priceTiers?.startingPrice) {
    box.innerHTML = "";
    $("#modalPriceLabel").textContent = "Starting at";
    $("#modalPrice").textContent = fmt(art.priceTiers.startingPrice);
    buy.hidden = false; add.hidden = false;
    updateWall();
    return;
  }
  if (!groups.length) {
    box.innerHTML = '<div class="fineprint__line">This piece isn\u2019t available as a print yet. <a href="#contact" data-close-viewer>Ask about it</a>.</div>';
    $("#modalPrice").textContent = "Contact for pricing";
    $("#modalPriceLabel").textContent = "";
    buy.hidden = true; add.hidden = true;
    const ask = box.querySelector("[data-close-viewer]");
    if (ask) ask.addEventListener("click", (e) => { e.preventDefault(); closeDetail(); setTimeout(() => $("#contact").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" }), 60); });
    updateWall();
    return;
  }
  buy.hidden = false; add.hidden = false;
  let g = groups.find(x => x.material.id === pick.material) || groups[0];
  pick.material = g.material.id;
  if (!g.sizes.some(s => s.id === pick.size)) {
    // Keep the closest size when switching material.
    pick.size = (g.sizes.find(s => Math.max(s.w,s.h) >= 24) || g.sizes[g.sizes.length-1]).id;
  }
  const frames = g.material.frames || [];
  if (frames.length && !frames.some(f => slug(f) === pick.frame)) pick.frame = slug(frames[0]);
  const sel = g.sizes.find(s => s.id === pick.size);
  const gMax = Math.max(...g.sizes.map(s => Math.max(s.w, s.h)));
  const maxIdx = g.sizes.reduce((bi, s, i, a) => Math.max(s.w, s.h) * 1000 + s.w * s.h / 1000 > Math.max(a[bi].w, a[bi].h) * 1000 + a[bi].w * a[bi].h / 1000 ? i : bi, 0);
  let html = `<div class="opt"><div class="opt__label">Material <b>${esc(g.material.label)}</b></div><div class="opt__chips" role="group" aria-label="Material">` +
    groups.map(x => `<button type="button" class="chip${x.material.id===pick.material?" chip--on":""}" data-mat="${esc(x.material.id)}" aria-pressed="${x.material.id===pick.material}">${esc(x.material.label)}</button>`).join("") +
    `</div><div class="opt__desc">${esc(g.material.description||"")}</div></div>`;
  html += `<div class="opt"><div class="opt__label">Size <b>${sel ? esc(sel.label) : ""}</b></div><div class="opt__sizes" role="group" aria-label="Size">` +
    g.sizes.map((s, i) => `<button type="button" class="size${s.id===pick.size?" size--on":""}" data-size="${esc(s.id)}" aria-pressed="${s.id===pick.size}">${sizeGlyph(s, gMax)}<span class="size__label">${esc(s.label)}</span><span class="size__price">${esc(fmt(s.price))}</span>${i === maxIdx && g.sizes.length > 2 ? '<span class="size__tag">Largest</span>' : ""}</button>`).join("") +
    `</div></div>`;
  if (frames.length) {
    html += `<div class="opt"><div class="opt__label">Frame</div><div class="opt__chips" role="group" aria-label="Frame">` +
      frames.map(f => `<button type="button" class="chip${slug(f)===pick.frame?" chip--on":""}" data-frame="${esc(slug(f))}" aria-pressed="${slug(f)===pick.frame}"><span class="chip__dot" style="background:${FRAME_COLORS[slug(f)] || "#161514"}"></span>${esc(f)}</button>`).join("") + `</div></div>`;
  }
  const maxLong = Math.max(...groups.flatMap(x => x.sizes.map(s => Math.max(s.w, s.h))));
  html += `<div class="fineprint__line">Up to ${esc(String(maxLong))}\u2033 for this piece \u00b7 sizes are limited to what its file prints sharp.</div>`;
  box.innerHTML = html;
  $("#modalPriceLabel").textContent = sel ? sel.label : "";
  $("#modalPrice").textContent = sel ? fmt(sel.price) : "";
  const refocus = (sel2) => { const el = box.querySelector(sel2); if (el) el.focus({ preventScroll: true }); };
  box.querySelectorAll("[data-mat]").forEach(b => b.onclick = () => { pick.material = b.dataset.mat; renderPicker("mat"); refocus(`[data-mat="${CSS.escape(b.dataset.mat)}"]`); });
  box.querySelectorAll("[data-size]").forEach(b => b.onclick = () => { pick.size = b.dataset.size; renderPicker("size"); refocus(`[data-size="${CSS.escape(b.dataset.size)}"]`); });
  box.querySelectorAll("[data-frame]").forEach(b => b.onclick = () => { pick.frame = b.dataset.frame; renderPicker("frame"); refocus(`[data-frame="${CSS.escape(b.dataset.frame)}"]`); });
  if (viewer.art === art) updateWall({ animateSize: !!changed });
}
function flashAdded() {
  const b = $("#addToCartBtn"); const t = b.textContent;
  if (b.dataset.flashing) return; b.dataset.flashing = "1";
  b.textContent = "Added \u2713"; setTimeout(() => { b.textContent = t; delete b.dataset.flashing; }, 1200);
}

// =====================================================================
// CART
// =====================================================================
function sameLine(i, artId, option) { return String(i.artId)===String(artId) && String(i.option||"")===String(option||""); }
function addToCart(artId, option) { const items = getCart(); const idx = items.findIndex(i=>sameLine(i,artId,option)); if (idx>=0) items[idx].qty=Math.min(20,(items[idx].qty||0)+1); else items.push({artId,option,qty:1}); setCart(items); renderCart(); }
function changeQty(artId, option, delta) { const items=getCart(); const idx=items.findIndex(i=>sameLine(i,artId,option)); if (idx<0) return; items[idx].qty=Math.min(20,(items[idx].qty||0)+delta); if (items[idx].qty<=0) items.splice(idx,1); setCart(items); renderCart(); }
const drawer = $("#cartDrawer"), scrim = $("#cartScrim");
const cartOpen = () => !drawer.hidden;
function openCart() {
  if (cartOpen()) return;
  renderCart();
  drawer.hidden = false; scrim.hidden = false;
  void drawer.offsetWidth;
  drawer.classList.add("is-open"); scrim.classList.add("is-open");
  lockScroll();
  pushLayer(drawer, closeCart);
  setTimeout(() => $("#cartCloseBtn").focus({ preventScroll: true }), 50);
}
function closeCart() {
  if (!cartOpen()) return;
  drawer.classList.remove("is-open"); scrim.classList.remove("is-open");
  setTimeout(() => { if (!drawer.classList.contains("is-open")) { drawer.hidden = true; scrim.hidden = true; } }, reduceMotion() ? 0 : 450);
  unlockScroll();
  popLayer(drawer);
}

function renderCart() {
  const items=getCart();
  const n = cartCount(items);
  const badge = $("#cartCount");
  badge.textContent=String(n);
  badge.classList.toggle("is-zero", n === 0);
  $("#cartButton").setAttribute("aria-label", `Open cart, ${n} item${n===1?"":"s"}`);
  $("#cartItemsCount").textContent=String(n);
  $("#cartTotal").textContent=fmt(cartTotal(items));
  const list=$("#cartItems"); list.innerHTML="";
  const checkout = $("#checkoutLink");
  checkout.setAttribute("aria-disabled", String(!items.length));
  checkout.style.opacity = items.length ? "" : ".45";
  if (!items.length) { $("#cartEmpty").hidden=false; return; }
  $("#cartEmpty").hidden=true;
  for (const it of items) {
    const art=artworks.find(a=>String(a.id)===String(it.artId)); if (!art) continue;
    normalizeArtworkIdentity(art);
    const opt=lineOption(it); if (!opt) continue;
    const thumb=art.thumb||art.image||""; const price=opt.price;
    const row=document.createElement("div"); row.className="cartItem";
    row.innerHTML=`<div class="cartItem__img" style="--c:${safeColor(art._dom)}"><img src="${safeUrl(thumb)}" alt="${esc(art.title)}" loading="lazy" decoding="async"/></div><div class="cartItem__main"><div class="cartItem__title">${esc(art.title)}</div><div class="cartItem__sku">${esc(opt.label)}</div><div class="cartItem__meta"><span>${esc(fmt(price))} each</span><b>${price?esc(fmt(price*it.qty)):"—"}</b></div><div class="qtyRow"><button type="button" class="qtyBtn" data-d="-1" aria-label="Decrease quantity">−</button><div class="qtyVal" aria-label="Quantity">${Number(it.qty)||0}</div><button type="button" class="qtyBtn" data-d="1" aria-label="Increase quantity">+</button><button type="button" class="qtyRemove">Remove</button></div></div>`;
    row.querySelectorAll(".qtyBtn").forEach(b=>b.addEventListener("click",()=>{ changeQty(it.artId,it.option,Number(b.dataset.d)); const again = $$(".cartItem", list).find(r => r.dataset.key === key); const fb = again && again.querySelector(`.qtyBtn[data-d="${b.dataset.d}"]`); if (fb) fb.focus(); else $("#cartCloseBtn").focus(); }));
    row.querySelector(".qtyRemove").addEventListener("click", () => { changeQty(it.artId, it.option, -(Number(it.qty) || 0) - 1); $("#cartCloseBtn").focus(); });
    const key = String(it.artId) + "|" + String(it.option || "");
    row.dataset.key = key;
    row.style.animationDelay = "0ms";
    list.appendChild(row);
  }
}
let toastTimer = 0;
function showToast(text) {
  const t = $("#toast"); $("#toastText").textContent = text;
  t.classList.add("is-on"); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-on"), 3600);
}
function flyToCart() {
  const art = viewer.art; if (!art) return;
  const badge = $("#cartCount"), btn = $("#cartButton");
  const bump = () => { badge.classList.remove("bump"); void badge.offsetWidth; badge.classList.add("bump"); };
  const opt = currentKey() && optionsLive ? resolveOption(art, products, currentKey()) : null;
  showToast(`Added \u2014 ${art.title || "Artwork"}${opt ? ` \u00b7 ${opt.sizeLabel}` : ""}`);
  const from = $("#modalImage").getBoundingClientRect(), to = btn.getBoundingClientRect();
  if (reduceMotion() || !from.width || !to.width || !document.body.animate) { bump(); return; }
  const f = document.createElement("img");
  f.className = "flyer"; f.src = rawUrl(art.thumb || art.image); f.alt = "";
  const size = Math.min(from.width, from.height, 220);
  Object.assign(f.style, { left: (from.left + from.width / 2 - size / 2) + "px", top: (from.top + from.height / 2 - size / 2) + "px", width: size + "px", height: size + "px" });
  document.body.appendChild(f);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const anim = f.animate([
    { transform: "translate(0,0) scale(1) rotate(0deg)", opacity: 1, borderRadius: "2px" },
    { transform: `translate(${dx * .5}px, ${dy * .5 - 80}px) scale(.55) rotate(-8deg)`, opacity: 1, offset: .55 },
    { transform: `translate(${dx}px, ${dy}px) scale(.08) rotate(-14deg)`, opacity: .4, borderRadius: "50%" }
  ], { duration: 820, easing: "cubic-bezier(.5,0,.2,1)" });
  anim.onfinish = () => { f.remove(); bump(); };
}

// ---- Checkout (Stripe, via the Cloudflare Worker) ----
function cartToItems() {
  return getCart()
    .map(i => ({ id: String(i.artId), ...(optionsLive && i.option ? { option: String(i.option) } : {}), qty: Number(i.qty) || 1 }))
    .filter(i => i.id);
}

let checkoutBusy = false;
async function startCheckout(items, button) {
  if (checkoutBusy) return;
  if (!items || !items.length) return;
  const api = (config.apiBase || "").replace(/\/+$/, "");
  if (!api) { alert("Checkout isn't switched on yet — the store is still being set up."); return; }
  checkoutBusy = true;
  const label = button ? button.textContent : "";
  if (button) { button.textContent = "Starting checkout…"; button.style.pointerEvents = "none"; button.style.opacity = ".6"; }
  try {
    const res = await fetch(api + "/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || "Checkout could not start.");
    window.location.href = data.url;
  } catch (err) {
    alert("Sorry — checkout couldn't start. " + (err && err.message ? err.message : "Please try again."));
    checkoutBusy = false;
    if (button) { button.textContent = label; button.style.pointerEvents = ""; button.style.opacity = ""; }
  }
}

(function() {
  const ov=document.getElementById("modalOverlay"); const dr=document.getElementById("cartDrawer");
  if (ov) ov.hidden=true; if (dr) dr.hidden=true; document.body.classList.remove("is-locked");
  document.getElementById("cartButton")?.addEventListener("click",()=>{openCart();});
  document.getElementById("cartCloseBtn")?.addEventListener("click",closeCart);
  document.getElementById("cartScrim")?.addEventListener("click",closeCart);
  document.getElementById("toastView")?.addEventListener("click",()=>{ $("#toast").classList.remove("is-on"); openCart(); });
  document.getElementById("checkoutLink")?.addEventListener("click", e => {
    e.preventDefault();
    startCheckout(cartToItems(), e.currentTarget);
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) { checkoutBusy = false; const c = $("#checkoutLink"); if (c) { c.textContent = "Checkout"; c.style.pointerEvents = ""; c.style.opacity = ""; } } });
})();

// =====================================================================
// Media reel: preload=none, play only while visible
// =====================================================================
function initReel() {
  const vids = $$("#reel video");
  const auto = !reduceMotion() && !saveData;
  const ensureSrc = (v) => { if (!v.getAttribute("src")) { v.src = v.dataset.src; v.addEventListener("loadeddata", () => v.classList.add("is-ready"), { once: true }); } };
  vids.forEach(v => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "reel__play"; btn.innerHTML = "<span>Play</span>";
    btn.setAttribute("aria-label", "Play " + (v.getAttribute("aria-label") || "video"));
    btn.hidden = auto;
    btn.addEventListener("click", () => { ensureSrc(v); if (v.paused) { v.play().catch(() => {}); btn.hidden = true; } });
    v.addEventListener("click", () => { if (!v.paused) { v.pause(); btn.hidden = false; } });
    v.parentElement.appendChild(btn);
  });
  if (!("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const v = en.target;
      if (en.isIntersecting) { if (auto) { ensureSrc(v); const p = v.play(); if (p) p.catch(() => { const b = v.parentElement.querySelector(".reel__play"); if (b) b.hidden = false; }); } }
      else if (!v.paused) v.pause();
    }
  }, { threshold: .35 });
  vids.forEach(v => io.observe(v));
}

// ---- Meet the artist: links to #artist open the bio ----
function initArtist() {
  const d = document.getElementById("artist");
  if (!d) return;
  if (location.hash === "#artist") d.open = true;
  $$('a[href="#artist"]').forEach(a => a.addEventListener("click", () => { d.open = true; }));
}

// ---- Featured film: swap the thumbnail for the YouTube player on click ----
function initFilm() {
  $$(".film__frame[data-yt]").forEach(a => a.addEventListener("click", (e) => {
    e.preventDefault();
    const f = document.createElement("iframe");
    f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(a.dataset.yt)}?autoplay=1&rel=0`;
    f.title = a.dataset.title || "Film";
    f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    f.allowFullscreen = true;
    f.referrerPolicy = "strict-origin-when-cross-origin";
    const box = document.createElement("div");
    box.className = "film__frame";
    box.appendChild(f);
    a.replaceWith(box);
    f.focus();
  }, { once: true }));
}

// ---- Scroll reveal ----
function initReveal() {
  const els = $$("[data-reveal]");
  if (!("IntersectionObserver" in window) || reduceMotion()) { els.forEach(e => e.classList.add("is-in")); return; }
  const io = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); } }, { rootMargin: "0px 0px -10% 0px" });
  els.forEach(e => io.observe(e));
}

// ---- Custom cursor ring (desktop only) ----
function initCursor() {
  if (!finePointer || reduceMotion()) return;
  const c = $("#cursor"), label = c.querySelector("span");
  let x = -100, y = -100, cx = -100, cy = -100, raf = 0;
  const loop = () => {
    cx += (x - cx) * .22; cy += (y - cy) * .22;
    c.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    raf = Math.abs(x - cx) + Math.abs(y - cy) > .3 ? requestAnimationFrame(loop) : 0;
  };
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    x = e.clientX; y = e.clientY;
    c.classList.add("is-on");
    const t = e.target.closest ? e.target.closest("[data-cursor]") : null;
    const hideIt = e.target.closest && e.target.closest(".loupeView");
    c.style.opacity = hideIt ? "0" : "";
    if (t) { label.textContent = t.dataset.cursor; c.classList.add("is-big"); } else c.classList.remove("is-big");
    if (!raf) raf = requestAnimationFrame(loop);
  }, { passive: true });
  document.addEventListener("pointerdown", () => c.classList.add("is-down"));
  document.addEventListener("pointerup", () => c.classList.remove("is-down"));
  document.documentElement.addEventListener("mouseleave", () => c.classList.remove("is-on"));
  // Inside an iframe (the film player) moves stop reaching this page — hide the ring instead of leaving it frozen on top
  document.addEventListener("pointerover", (e) => { if (e.target.tagName === "IFRAME") c.classList.remove("is-on", "is-big"); });
}

// ---- Structured data: ItemList of Products (built from the live catalogue) ----
function injectItemList() {
  try {
    const base = "https://arttra.art/";
    const abs = (p) => { const v = rawUrl(p); return v ? new URL(v, base).href : undefined; };
    const items = artworks.filter(a => a._groups && a._groups.length).map((a, i) => {
      const prices = a._groups.flatMap(g => g.sizes.map(s => s.price));
      return { "@type": "ListItem", position: i + 1, item: {
        "@type": "Product", name: a.title, sku: a.sku, image: abs(a.image || a.thumb), url: base + "#art=" + encodeURIComponent(a.id),
        brand: { "@type": "Brand", name: "ARTTRA" }, category: "Art Prints",
        description: `${a.title} — ${a.style || "original"} art print, made to order up to ${a._maxLong}\u2033.`,
        offers: { "@type": "AggregateOffer", priceCurrency: config.currency || "USD", lowPrice: Math.min(...prices), highPrice: Math.max(...prices), offerCount: prices.length, availability: "https://schema.org/InStock" }
      } };
    });
    if (!items.length) return;
    const s = document.createElement("script");
    s.type = "application/ld+json";
    s.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList", name: "ARTTRA collection", numberOfItems: items.length, itemListElement: items });
    document.head.appendChild(s);
  } catch {}
}

function heroLine() {
  if (!optionsLive) return;
  const max = Math.max(0, ...artworks.map(a => a._maxLong || 0));
  if (max >= 30) $("#heroLine").textContent = `Original art, printed up to ${max}\u2033 \u2014 and previewed at true scale on your wall before you buy.`;
}

async function getJson(url) { const r = await fetch(url, { cache: "no-store" }); return r.json(); }
async function init() {
  initReveal(); initReel(); initFilm(); initArtist(); initCursor(); initViewerControls(); initSpectrum();
  const [cfg, arts, prods] = await Promise.all([
    getJson("./data/config.json").catch(() => null),
    getJson("./data/artworks.json").catch(() => null),
    getJson("./data/products.json").catch(() => null),
  ]);
  if (cfg) config = cfg;
  artworks = normalizeArtworks(arts || []);
  artworks.forEach(prepArt);
  products = prods || { materials: [] };
  // Hero after first paint, without waiting for the checkout health check.
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 30));
  requestAnimationFrame(() => idle(buildMosaic, { timeout: 600 }));
  try {
    const api = (config.apiBase || "").replace(/\/+$/, "");
    optionsLive = !!api && (await (await fetch(api + "/", { cache: "no-store" })).text()).includes("options-v2");
  } catch { optionsLive = false; }
  if (!optionsLive) products = { materials: [] };
  artworks.forEach(prepOptions);
  sanitizeCart();
  document.title = "ARTTRA.ART — Original Art";
  initCatNav(); initToggles(); renderColorBar();
  buildCards(); renderCards({ stagger: false }); observeThumbs(); renderCart();
  heroLine();
  injectItemList();
  if (new URLSearchParams(location.search).get("checkout") === "cancelled") {
    openCart(); renderCart();
  }
  window.addEventListener("popstate", syncFromHash);
  window.addEventListener("hashchange", syncFromHash);
  syncFromHash();
}
init();
