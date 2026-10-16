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
let state = { category: "all", color: null, query: "", selectedArtwork: null };

function fmt(amount) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: config.currency }).format(amount); }
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

function renderCards() {
  const grid = $("#cardsGrid");
  const filtered = artworks.filter(matchesFilters);
  const meta = $("#resultMeta");
  meta.textContent = `${filtered.length} piece${filtered.length===1?"":"s"}`;
  if (!filtered.length) { grid.innerHTML = '<div class="emptyState">No matches. Try a different category or clear search.</div>'; return; }
  grid.innerHTML = filtered.map(art => {
    const thumb = art.thumb || art.image || "";
    const swatches = (art.colorPalette||[]).slice(0,4);
    return `<div class="card" data-id="${esc(art.id)}">
      <div class="card__imgWrap">
        <img class="card__img" src="${safeUrl(thumb)}" alt="${esc(art.title)}" loading="lazy" />
        ${art.category ? `<span class="card__category">${esc(art.category)}</span>` : ""}
      </div>
      <div class="card__body">
        <div class="card__title">${esc(art.title)}</div>
        <div class="card__sku">${fromLine(art)}</div>
        <div class="card__sub">
          <span>${esc(art.style||"")}</span>
          <span class="card__swatches">${swatches.map(h=>`<span class="swatch" style="--c:${safeColor(h)}"></span>`).join("")}</span>
        </div>
      </div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".card").forEach(c => c.addEventListener("click", () => openModal(artworks.find(a=>a.id===c.dataset.id))));
}

function renderColorBar() {
  const bar = $("#colorBar");
  const map = new Map();
  for (const a of artworks) for (const nc of (a.namedColors||[])) if (!map.has(nc.name)) map.set(nc.name, nc);
  const sorted = Array.from(map.values()).sort((a,b)=>a.name.localeCompare(b.name));
  let html = '<span class="colorbar__label">Color</span>';
  html += `<button class="cpill cpill--active" data-color="">All</button>`;
  for (const nc of sorted) html += `<button class="cpill" data-color="${esc(nc.name)}"><span class="cpill__dot" style="--c:${safeColor(nc.hex)}"></span>${esc(nc.name)}</button>`;
  bar.innerHTML = html;
  bar.querySelectorAll(".cpill").forEach(btn => btn.addEventListener("click", () => { state.color = btn.dataset.color || null; bar.querySelectorAll(".cpill").forEach(b=>b.classList.remove("cpill--active")); btn.classList.add("cpill--active"); renderCards(); }));
}

function initCatNav() {
  $$(".catnav__link[data-cat]").forEach(btn => btn.addEventListener("click", () => { $$(".catnav__link[data-cat]").forEach(b=>b.classList.remove("catnav__link--active")); btn.classList.add("catnav__link--active"); state.category = btn.dataset.cat; renderCards(); }));
}

function openModal(art) {
  if (!art) return;
  normalizeArtworkIdentity(art);
  state.selectedArtwork = art;
  $("#modalSku").textContent = art.sku || "";
  $("#modalTitle").textContent = art.title || "Untitled";
  $("#modalDescription").textContent = art.description || "";
  $("#modalStyleBadge").textContent = art.style || "";
  $("#modalCategoryBadge").textContent = art.category || "";
  $("#modalImage").src = art.image || art.thumb || "";
  $("#modalImage").alt = art.title || "";
  const colorsEl = $("#modalColors");
  colorsEl.innerHTML = (art.namedColors||[]).map(nc => `<div class="colorSwatch"><span class="colorSwatch__dot" style="--c:${safeColor(nc.hex)}"></span><span class="colorSwatch__hex">${esc(nc.name)}</span></div>`).join("");
  const identityEl = document.getElementById("modalIdentity");
  if (identityEl) identityEl.innerHTML = `<div>SKU: <strong>${esc(art.sku)}</strong></div><div>Identity hash: ${esc(art.identityHash)}</div><div>Edition: ${esc(art.editionType)}</div><div>Pipeline: ${esc(art.pipelineVersion)}</div>`;
  initPicker(art);
  $("#buyNowLink").onclick = (e) => { e.preventDefault(); const k=currentKey(); if (!k) return; startCheckout([{ id: String(art.id), ...(optionsLive ? { option: k } : {}), qty: 1 }], e.currentTarget); };
  $("#addToCartBtn").onclick = () => { const k=currentKey(); if (!k) return; addToCart(String(art.id), optionsLive ? k : ""); flashAdded(); };
  $("#modalOverlay").hidden = false;
  document.body.style.overflow = "hidden";
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
function renderPicker() {
  const art = state.selectedArtwork; if (!art) return;
  const groups = groupsFor(art);
  const box = $("#modalOptions");
  const buy = $("#buyNowLink"), add = $("#addToCartBtn");
  if (!groups.length && !optionsLive && art.priceTiers?.startingPrice) {
    box.innerHTML = "";
    $("#modalPriceLabel").textContent = "Starting at";
    $("#modalPrice").textContent = fmt(art.priceTiers.startingPrice);
    buy.hidden = false; add.hidden = false;
    return;
  }
  if (!groups.length) {
    box.innerHTML = '<div class="fineprint__line">This piece isn\u2019t available as a print yet. <a href="#contact">Ask about it</a>.</div>';
    $("#modalPrice").textContent = "Contact for pricing";
    $("#modalPriceLabel").textContent = "";
    buy.hidden = true; add.hidden = true;
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
  let html = `<div class="opt"><div class="opt__label">Material</div><div class="opt__chips">` +
    groups.map(x => `<button type="button" class="chip${x.material.id===pick.material?" chip--on":""}" data-mat="${esc(x.material.id)}">${esc(x.material.label)}</button>`).join("") +
    `</div><div class="opt__desc">${esc(g.material.description||"")}</div></div>`;
  html += `<div class="opt"><div class="opt__label">Size</div><div class="opt__sizes">` +
    g.sizes.map(s => `<button type="button" class="size${s.id===pick.size?" size--on":""}" data-size="${esc(s.id)}"><span>${esc(s.label)}</span><span class="size__price">${esc(fmt(s.price))}</span></button>`).join("") +
    `</div></div>`;
  if (frames.length) {
    html += `<div class="opt"><div class="opt__label">Frame</div><div class="opt__chips">` +
      frames.map(f => `<button type="button" class="chip${slug(f)===pick.frame?" chip--on":""}" data-frame="${esc(slug(f))}">${esc(f)}</button>`).join("") + `</div></div>`;
  }
  const maxLong = Math.max(...groups.flatMap(x => x.sizes.map(s => Math.max(s.w, s.h))));
  html += `<div class="fineprint__line">Up to ${esc(String(maxLong))}\u2033 for this piece \u00b7 sizes are limited to what its file prints sharp.</div>`;
  box.innerHTML = html;
  $("#modalPriceLabel").textContent = sel ? sel.label : "";
  $("#modalPrice").textContent = sel ? fmt(sel.price) : "";
  box.querySelectorAll("[data-mat]").forEach(b => b.onclick = () => { pick.material = b.dataset.mat; renderPicker(); });
  box.querySelectorAll("[data-size]").forEach(b => b.onclick = () => { pick.size = b.dataset.size; renderPicker(); });
  box.querySelectorAll("[data-frame]").forEach(b => b.onclick = () => { pick.frame = b.dataset.frame; renderPicker(); });
}
function flashAdded() {
  const b = $("#addToCartBtn"); const t = b.textContent;
  b.textContent = "Added \u2713"; setTimeout(() => { b.textContent = t; }, 1200);
}

function closeModal() { $("#modalOverlay").hidden = true; document.body.style.overflow = ""; state.selectedArtwork = null; }

function sameLine(i, artId, option) { return String(i.artId)===String(artId) && String(i.option||"")===String(option||""); }
function addToCart(artId, option) { const items = getCart(); const idx = items.findIndex(i=>sameLine(i,artId,option)); if (idx>=0) items[idx].qty=Math.min(20,(items[idx].qty||0)+1); else items.push({artId,option,qty:1}); setCart(items); renderCart(); }
function changeQty(artId, option, delta) { const items=getCart(); const idx=items.findIndex(i=>sameLine(i,artId,option)); if (idx<0) return; items[idx].qty=Math.min(20,(items[idx].qty||0)+delta); if (items[idx].qty<=0) items.splice(idx,1); setCart(items); renderCart(); }
function openCart() { $("#cartDrawer").hidden=false; document.body.style.overflow="hidden"; }
function closeCart() { $("#cartDrawer").hidden=true; document.body.style.overflow=""; }

function renderCart() {
  const items=getCart();
  $("#cartCount").textContent=String(cartCount(items));
  $("#cartItemsCount").textContent=String(cartCount(items));
  $("#cartTotal").textContent=fmt(cartTotal(items));
  const list=$("#cartItems"); list.innerHTML="";
  if (!items.length) { $("#cartEmpty").hidden=false; return; }
  $("#cartEmpty").hidden=true;
  for (const it of items) {
    const art=artworks.find(a=>String(a.id)===String(it.artId)); if (!art) continue;
    normalizeArtworkIdentity(art);
    const opt=lineOption(it); if (!opt) continue;
    const thumb=art.thumb||art.image||""; const price=opt.price;
    const row=document.createElement("div"); row.className="cartItem";
    row.innerHTML=`<div class="cartItem__img"><img src="${safeUrl(thumb)}" loading="lazy"/></div><div class="cartItem__main"><div class="cartItem__title">${esc(art.title)}</div><div class="cartItem__sku">${esc(opt.label)}</div><div class="cartItem__meta"><span>${esc(fmt(price))} each</span><span>${price?esc(fmt(price*it.qty)):"—"}</span></div><div class="qtyRow"><button class="qtyBtn" data-d="-1">−</button><div class="qtyVal">${Number(it.qty)||0}</div><button class="qtyBtn" data-d="1">+</button></div></div>`;
    row.querySelectorAll(".qtyBtn").forEach(b=>b.addEventListener("click",()=>changeQty(it.artId,it.option,Number(b.dataset.d))));
    list.appendChild(row);
  }
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
  if (ov) ov.hidden=true; if (dr) dr.hidden=true; document.body.style.overflow="";
  document.getElementById("modalCloseBtn")?.addEventListener("click",closeModal);
  ov?.addEventListener("click",e=>{if(e.target===ov)closeModal();});
  window.addEventListener("keydown",e=>{ if(e.key==="Escape"){if(ov&&!ov.hidden)closeModal();if(dr&&!dr.hidden)closeCart();} });
  document.getElementById("cartButton")?.addEventListener("click",()=>{openCart();renderCart();});
  document.getElementById("cartCloseBtn")?.addEventListener("click",closeCart);
  document.getElementById("checkoutLink")?.addEventListener("click", e => {
    e.preventDefault();
    startCheckout(cartToItems(), e.currentTarget);
  });
})();

async function init() {
  try { config = await (await fetch("./data/config.json",{cache:"no-store"})).json(); } catch {}
  try { artworks = normalizeArtworks(await (await fetch("./data/artworks.json",{cache:"no-store"})).json()); } catch { artworks=[]; }
  try { products = await (await fetch("./data/products.json",{cache:"no-store"})).json(); } catch { products = { materials: [] }; }
  try {
    const api = (config.apiBase || "").replace(/\/+$/, "");
    optionsLive = !!api && (await (await fetch(api + "/", { cache: "no-store" })).text()).includes("options-v2");
  } catch { optionsLive = false; }
  if (!optionsLive) products = { materials: [] };
  sanitizeCart();
  document.title = "ARTTRA.ART — Original Art";
  initCatNav(); renderColorBar(); renderCards(); renderCart();
  $("#searchInput").addEventListener("input", e => { state.query=e.target.value||""; renderCards(); });
  if (new URLSearchParams(location.search).get("checkout") === "cancelled") {
    openCart(); renderCart();
  }
}
init();
