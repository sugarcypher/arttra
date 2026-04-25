const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE_KEY = "arttra_cart_v1";
let config = { siteName: "arttra.art", checkoutUrl: "#", currency: "USD" };
let artworks = [];
let state = { category: "all", color: null, query: "", selectedArtwork: null };

function fmt(amount) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: config.currency }).format(amount); }
  catch { return `$${amount.toFixed(0)}`; }
}
function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
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
  return (Array.isArray(list) ? list : []).map(normalizeArtworkIdentity);
}

function getCart() { try { const r=localStorage.getItem(STORAGE_KEY); return r?JSON.parse(r):[]; } catch { return []; } }
function setCart(items) { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }
function cartCount(items) { return items.reduce((s,i)=>s+(i.qty||0),0); }
function cartTotal(items) {
  let t=0;
  for (const i of items) {
    const a=artworks.find(x=>String(x.id)===String(i.artId));
    if (a) t+=(a.priceTiers?.startingPrice||0)*(i.qty||0);
  }
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

function renderCards() {
  const grid = $("#cardsGrid");
  const filtered = artworks.filter(matchesFilters);
  const meta = $("#resultMeta");
  meta.textContent = `${filtered.length} piece${filtered.length===1?"":"s"}`;
  if (!filtered.length) { grid.innerHTML = '<div class="emptyState">No matches. Try a different category or clear search.</div>'; return; }
  grid.innerHTML = filtered.map(art => {
    const thumb = art.thumb || art.image || "";
    const swatches = (art.colorPalette||[]).slice(0,4);
    return `<div class="card" data-id="${art.id}">
      <div class="card__imgWrap">
        <img class="card__img" src="${thumb}" alt="${esc(art.title)}" loading="lazy" />
        ${art.category ? `<span class="card__category">${esc(art.category)}</span>` : ""}
      </div>
      <div class="card__body">
        <div class="card__title">${esc(art.title)}</div>
        <div class="card__sku">${esc(art.sku)}</div>
        <div class="card__sub">
          <span>${esc(art.style||"")}</span>
          <span class="card__swatches">${swatches.map(h=>`<span class="swatch" style="--c:${h}"></span>`).join("")}</span>
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
  for (const nc of sorted) html += `<button class="cpill" data-color="${esc(nc.name)}"><span class="cpill__dot" style="--c:${nc.hex}"></span>${esc(nc.name)}</button>`;
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
  colorsEl.innerHTML = (art.namedColors||[]).map(nc => `<div class="colorSwatch"><span class="colorSwatch__dot" style="--c:${nc.hex}"></span><span class="colorSwatch__hex">${nc.name}</span></div>`).join("");
  const identityEl = document.getElementById("modalIdentity");
  if (identityEl) identityEl.innerHTML = `<div>SKU: <strong>${esc(art.sku)}</strong></div><div>Identity hash: ${esc(art.identityHash)}</div><div>Edition: ${esc(art.editionType)}</div><div>Pipeline: ${esc(art.pipelineVersion)}</div>`;
  const price = art.priceTiers?.startingPrice;
  $("#modalPrice").textContent = price ? fmt(price) : "Contact for pricing";
  $("#modalBestProducts").textContent = (art.bestProducts||[]).join(", ") || "—";
  $("#buyNowLink").href = art.buyUrl || "#";
  $("#addToCartBtn").onclick = () => addToCart(String(art.id));
  $("#modalOverlay").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal() { $("#modalOverlay").hidden = true; document.body.style.overflow = ""; state.selectedArtwork = null; }

function addToCart(artId) { const items = getCart(); const idx = items.findIndex(i=>String(i.artId)===String(artId)); if (idx>=0) items[idx].qty=(items[idx].qty||0)+1; else items.push({artId,qty:1}); setCart(items); renderCart(); }
function changeQty(artId, delta) { const items=getCart(); const idx=items.findIndex(i=>String(i.artId)===String(artId)); if (idx<0) return; items[idx].qty=(items[idx].qty||0)+delta; if (items[idx].qty<=0) items.splice(idx,1); setCart(items); renderCart(); }
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
    const thumb=art.thumb||art.image||""; const price=art.priceTiers?.startingPrice||0;
    const row=document.createElement("div"); row.className="cartItem";
    row.innerHTML=`<div class="cartItem__img"><img src="${thumb}" loading="lazy"/></div><div class="cartItem__main"><div class="cartItem__title">${esc(art.title)}</div><div class="cartItem__sku">${esc(art.sku)}</div><div class="cartItem__meta"><span>${esc(art.style||"")}</span><span>${price?fmt(price*it.qty):"—"}</span></div><div class="qtyRow"><button class="qtyBtn" data-d="-1">−</button><div class="qtyVal">${it.qty}</div><button class="qtyBtn" data-d="1">+</button></div></div>`;
    row.querySelectorAll(".qtyBtn").forEach(b=>b.addEventListener("click",()=>changeQty(it.artId,Number(b.dataset.d))));
    list.appendChild(row);
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
})();

async function init() {
  try { config = await (await fetch("./data/config.json",{cache:"no-store"})).json(); } catch {}
  try { artworks = normalizeArtworks(await (await fetch("./data/artworks.json",{cache:"no-store"})).json()); } catch { artworks=[]; }
  document.title = "ARTTRA.ART — Original Art";
  initCatNav(); renderColorBar(); renderCards(); renderCart();
  $("#searchInput").addEventListener("input", e => { state.query=e.target.value||""; renderCards(); });
}
init();
