const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE_KEY = "arttra_cart_v1";

/** @type {{siteName:string, checkoutUrl:string, currency:string}} */
let config = { siteName: "arttra.art", checkoutUrl: "#", currency: "USD" };

/** @type {Array<any>} */
let artworks = [];

let state = {
  style: null,
  room: null,
  color: null,
  query: "",
  selectedArtwork: null,
};

function formatMoney(amount) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: config.currency }).format(amount);
  } catch {
    return `$${amount.toFixed(0)}`;
  }
}

function getCart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function setCart(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function cartCount(items) {
  return items.reduce((sum, it) => sum + (it.qty || 0), 0);
}

function cartEstimatedTotal(items) {
  // Using "starting price" as an estimate.
  let total = 0;
  for (const it of items) {
    const art = artworks.find((a) => String(a.id) === String(it.artId));
    if (!art) continue;
    const startPrice = Number(art.priceTiers?.startingPrice ?? art.priceTiers?.low ?? art.price?.startingPrice ?? 0);
    total += startPrice * (it.qty || 0);
  }
  return total;
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
}

function computePaletteSwatches(art) {
  const colors = Array.isArray(art.colorPalette) ? art.colorPalette : [];
  // Keep short and stable: first 4
  return colors.slice(0, 4);
}

function renderPill(container, items, onClick, options = {}) {
  container.innerHTML = "";
  const noneBtn = document.createElement("button");
  noneBtn.type = "button";
  noneBtn.className = "pill";
  noneBtn.textContent = options.noneLabel || "All";
  noneBtn.addEventListener("click", () => onClick(null));
  container.appendChild(noneBtn);

  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill";
    btn.textContent = it;
    btn.addEventListener("click", () => onClick(it));
    container.appendChild(btn);
  }
}

function setActivePill(container, activeValue) {
  const pills = $$(".pill", container);
  for (const p of pills) p.classList.remove("pill--active");
  if (!activeValue) return;
  const match = pills.find((p) => p.textContent === String(activeValue));
  if (match) match.classList.add("pill--active");
}

function renderColorPills(container, artworksList) {
  const palette = artworksList.flatMap((a) => (Array.isArray(a.colorPalette) ? a.colorPalette : []));
  const unique = uniqueSorted(palette);
  container.innerHTML = "";

  const all = document.createElement("button");
  all.type = "button";
  all.className = "colorPill";
  all.dataset.color = "";
  all.innerHTML = `<span class="colorPill__dot" style="--c:#ffffff"></span><span>All</span>`;
  all.addEventListener("click", () => setColor(null));
  container.appendChild(all);

  for (const hex of unique) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "colorPill";
    btn.dataset.color = hex;
    btn.innerHTML = `<span class="colorPill__dot" style="--c:${hex}"></span><span>${hex}</span>`;
    btn.addEventListener("click", () => setColor(hex));
    container.appendChild(btn);
  }
}

function setActiveColorPill(container, activeHex) {
  $$(".colorPill", container).forEach((el) => el.classList.remove("colorPill--active"));
  if (!activeHex) return;
  const match = $$(".colorPill", container).find((el) => el.dataset.color === activeHex);
  if (match) match.classList.add("colorPill--active");
}

function priceStarting(art) {
  const tiers = art.priceTiers || {};
  const v = Number(tiers.startingPrice ?? tiers.low ?? tiers.base ?? art.price?.startingPrice ?? 0);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

function artworkMatchesFilters(art) {
  const styleOk = !state.style || String(art.style) === String(state.style);
  const roomOk = !state.room || (Array.isArray(art.roomFit) ? art.roomFit.includes(state.room) : String(art.roomFit) === String(state.room));
  const colorOk = !state.color || (Array.isArray(art.colorPalette) ? art.colorPalette.includes(state.color) : false);
  const queryOk = !state.query
    ? true
    : [
        art.title,
        art.style,
        art.mood,
        Array.isArray(art.roomFit) ? art.roomFit.join(" ") : "",
        Array.isArray(art.seoKeywords) ? art.seoKeywords.join(" ") : "",
        art.sku,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(state.query.toLowerCase());
  return styleOk && roomOk && colorOk && queryOk;
}

function renderCards() {
  const grid = $("#cardsGrid");
  const filtered = artworks.filter(artworkMatchesFilters);
  grid.innerHTML = "";

  const meta = $("#resultMeta");
  meta.textContent = `${filtered.length} piece${filtered.length === 1 ? "" : "s"} shown`;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyState";
    empty.textContent = "No matches. Try clearing filters.";
    grid.appendChild(empty);
    return;
  }

  for (const art of filtered) {
    const card = document.createElement("div");
    card.className = "card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `View ${art.title}`);

    const thumb = art.thumb || art.image || "./assets/images/placeholder.svg";
    const swatches = computePaletteSwatches(art);

    card.innerHTML = `
      <div class="card__imgWrap">
        <img class="card__img" src="${thumb}" alt="${escapeHtml(art.title || "Artwork")}" loading="lazy" />
      </div>
      <div class="card__body">
        <h3 class="card__title">${escapeHtml(art.title || "Untitled")}</h3>
        <div class="card__sub">
          <span>${escapeHtml(art.style || "Style")}</span>
          <span class="card__swatches" aria-hidden="true">
            ${swatches
              .map((hex) => `<span class="swatch" style="--c:${hex}"></span>`)
              .join("")}
          </span>
        </div>
      </div>
    `;

    const open = () => openModal(art);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") open();
    });

    grid.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openModal(art) {
  state.selectedArtwork = art;
  $("#modalSku").textContent = art.sku ? `SKU ${art.sku}` : "";
  $("#modalTitle").textContent = art.title || "Untitled";
  $("#modalDescription").textContent = art.description || "";
  $("#modalStyleBadge").textContent = art.style ? `Style: ${art.style}` : "Style";
  const roomText = Array.isArray(art.roomFit) ? art.roomFit.slice(0, 3).join(", ") : art.roomFit || "Room";
  $("#modalRoomBadge").textContent = `Room: ${roomText}`;

  const imgSrc = art.image || art.thumb || "./assets/images/placeholder.svg";
  $("#modalImage").src = imgSrc;
  $("#modalImage").alt = art.title || "Artwork image";

  const palette = computePaletteSwatches(art);
  const colorsEl = $("#modalColors");
  colorsEl.innerHTML = palette
    .map(
      (hex) => `
    <div class="colorSwatch">
      <span class="colorSwatch__dot" style="--c:${hex}"></span>
      <span class="colorSwatch__hex">${hex}</span>
    </div>`
    )
    .join("");

  const start = priceStarting(art);
  $("#modalPrice").textContent = start ? formatMoney(start) : "Contact for pricing";

  const best = Array.isArray(art.bestProducts) ? art.bestProducts.join(", ") : (art.bestProducts || "");
  $("#modalBestProducts").textContent = best || "—";

  const keys = Array.isArray(art.seoKeywords) ? art.seoKeywords.slice(0, 18).join(", ") : (art.seoKeywords || "");
  $("#modalKeywords").textContent = keys || "—";

  const buyUrl = art.buyUrl || "#";
  $("#buyNowLink").href = buyUrl;

  $("#addToCartBtn").onclick = () => addToCart(String(art.id));

  $("#modalOverlay").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#modalOverlay").hidden = true;
  document.body.style.overflow = "";
  state.selectedArtwork = null;
}

function setStyle(val) {
  state.style = val;
  const styleFilters = $("#styleFilters");
  // Active state is handled by re-rendering; fast path: update active pill.
  setActivePill(styleFilters, val);
  renderCards();
}

function setRoom(val) {
  state.room = val;
  const roomFilters = $("#roomFilters");
  setActivePill(roomFilters, val);
  renderCards();
}

function setColor(val) {
  state.color = val;
  const colorFilters = $("#colorFilters");
  setActiveColorPill(colorFilters, val);
  renderCards();
}

function initFilters() {
  const styles = uniqueSorted(artworks.map((a) => a.style));
  const rooms = uniqueSorted(artworks.flatMap((a) => (Array.isArray(a.roomFit) ? a.roomFit : a.roomFit ? [a.roomFit] : [])));

  renderPill($("#styleFilters"), styles, (v) => setStyle(v), { noneLabel: "All styles" });
  renderPill($("#roomFilters"), rooms, (v) => setRoom(v), { noneLabel: "All rooms" });
  renderColorPills($("#colorFilters"), artworks);

  // Initial active states
  setActivePill($("#styleFilters"), null);
  setActivePill($("#roomFilters"), null);
  setActiveColorPill($("#colorFilters"), null);
}

function addToCart(artId) {
  const items = getCart();
  const idx = items.findIndex((it) => String(it.artId) === String(artId));
  if (idx >= 0) items[idx].qty = (items[idx].qty || 0) + 1;
  else items.push({ artId: String(artId), qty: 1 });
  setCart(items);
  renderCart();
}

function changeQty(artId, delta) {
  const items = getCart();
  const idx = items.findIndex((it) => String(it.artId) === String(artId));
  if (idx < 0) return;
  items[idx].qty = (items[idx].qty || 0) + delta;
  if (items[idx].qty <= 0) items.splice(idx, 1);
  setCart(items);
  renderCart();
}

function openCart() {
  $("#cartDrawer").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeCart() {
  $("#cartDrawer").hidden = true;
  document.body.style.overflow = "";
}

function renderCart() {
  const items = getCart();
  const count = cartCount(items);
  $("#cartCount").textContent = String(count);
  $("#cartItemsCount").textContent = String(count);

  const total = cartEstimatedTotal(items);
  $("#cartTotal").textContent = formatMoney(total);

  const emptyEl = $("#cartEmpty");
  const listEl = $("#cartItems");
  listEl.innerHTML = "";

  if (items.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const it of items) {
    const art = artworks.find((a) => String(a.id) === String(it.artId));
    if (!art) continue;

    const thumb = art.thumb || art.image || "./assets/images/placeholder.svg";
    const start = priceStarting(art);
    const linePrice = start ? start * (it.qty || 0) : 0;

    const row = document.createElement("div");
    row.className = "cartItem";
    row.innerHTML = `
      <div class="cartItem__img">
        <img src="${thumb}" alt="${escapeHtml(art.title || "Artwork")}" loading="lazy" />
      </div>
      <div class="cartItem__main">
        <div class="cartItem__title">${escapeHtml(art.title || "Untitled")}</div>
        <div class="cartItem__meta">
          <span>${escapeHtml(art.style || "Style")}</span>
          <span>${start ? formatMoney(linePrice) : "—"}</span>
        </div>
        <div class="qtyRow" aria-label="Quantity controls">
          <button class="qtyBtn" type="button" aria-label="Decrease quantity">−</button>
          <div class="qtyVal">${Number(it.qty || 0)}</div>
          <button class="qtyBtn" type="button" aria-label="Increase quantity">+</button>
        </div>
      </div>
    `;

    const minus = row.querySelectorAll(".qtyBtn")[0];
    const plus = row.querySelectorAll(".qtyBtn")[1];
    minus.addEventListener("click", () => changeQty(it.artId, -1));
    plus.addEventListener("click", () => changeQty(it.artId, +1));

    listEl.appendChild(row);
  }

  // If you later hook up a real checkout page, this provides the cart in a query param.
  const baseCheckout = config.checkoutUrl || "#";
  if (baseCheckout === "#" || !baseCheckout) {
    $("#checkoutLink").href = "#";
    return;
  }
  const payload = { items, currency: config.currency };
  const encoded =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
      : encodeURIComponent(JSON.stringify(payload));

  const joiner = baseCheckout.includes("?") ? "&" : "?";
  $("#checkoutLink").href = `${baseCheckout}${joiner}cart=${encoded}`;
}

async function loadJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return await res.json();
}

async function loadArtworksFromFirebase() {
  const fbCfg = config.firebase?.config;
  if (!fbCfg) throw new Error("Missing Firebase config in data/config.json");

  const artworksCollection = config.firebase?.artworksCollection || "artworks";

  // Using CDN modules keeps this repo Surge-friendly (no bundler needed).
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js");
  const { getFirestore, collection, getDocs } = await import(
    "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js"
  );

  const app = initializeApp(fbCfg);
  const db = getFirestore(app);
  const snap = await getDocs(collection(db, artworksCollection));

  return snap.docs.map((d) => {
    const data = d.data() || {};
    return { id: data.id ?? d.id, ...data };
  });
}

// Immediately ensure modal and cart are closed and wire up close handlers
(function setupUI() {
  const overlay = document.getElementById("modalOverlay");
  const drawer = document.getElementById("cartDrawer");
  if (overlay) overlay.hidden = true;
  if (drawer) drawer.hidden = true;
  document.body.style.overflow = "";

  document.getElementById("modalCloseBtn")?.addEventListener("click", closeModal);
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (overlay && !overlay.hidden) closeModal();
      if (drawer && !drawer.hidden) closeCart();
    }
  });
  document.getElementById("cartButton")?.addEventListener("click", () => {
    openCart();
    renderCart();
  });
  document.getElementById("cartCloseBtn")?.addEventListener("click", closeCart);
})();

async function init() {
  try {
    config = await loadJSON("./data/config.json");
  } catch {
    // Keep defaults.
  }

  let loaded = false;
  if (config.firebase?.enabled) {
    try {
      artworks = await loadArtworksFromFirebase();
      loaded = true;
    } catch (e) {
      console.error("Firebase artworks load failed:", e);
      loaded = false;
    }
  }

  if (!loaded) {
    try {
      artworks = await loadJSON("./data/artworks.json");
    } catch (e) {
      console.warn("[arttra] No artworks.json — gallery empty.");
      artworks = [];
    }
  }

  document.title = `${config.siteName || "arttra.art"} - Contemporary prints`;

  initFilters();
  renderCards();
  renderCart();

  // Search
  const search = $("#searchInput");
  search.addEventListener("input", (e) => {
    state.query = e.target.value || "";
    renderCards();
  });

  // Clear
  $("#clearFiltersBtn").addEventListener("click", () => {
    state.style = null;
    state.room = null;
    state.color = null;
    $("#searchInput").value = "";
    state.query = "";
    setActivePill($("#styleFilters"), null);
    setActivePill($("#roomFilters"), null);
    setActiveColorPill($("#colorFilters"), null);
    renderCards();
  });
}

init();

