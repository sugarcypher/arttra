const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE_KEY = "arttra_cart_v1";

let config = { siteName: "arttra.art", checkoutUrl: "#", currency: "USD" };
let artworks = [];

let state = {
  style: null,
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
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function setCart(items) { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }

function cartCount(items) { return items.reduce((sum, it) => sum + (it.qty || 0), 0); }

function cartEstimatedTotal(items) {
  let total = 0;
  for (const it of items) {
    const art = artworks.find((a) => String(a.id) === String(it.artId));
    if (!art) continue;
    const startPrice = Number(art.priceTiers?.startingPrice ?? 0);
    total += startPrice * (it.qty || 0);
  }
  return total;
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
}

function computePaletteSwatches(art) {
  const colors = Array.isArray(art.colorPalette) ? art.colorPalette : [];
  return colors.slice(0, 4);
}

// ── Pills ──

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
  if (!activeValue) {
    // Activate the "All" button
    if (pills.length > 0) pills[0].classList.add("pill--active");
    return;
  }
  const match = pills.find((p) => p.textContent === String(activeValue));
  if (match) match.classList.add("pill--active");
}

// ── Named Color Pills ──

function renderNamedColorPills(container, artworksList) {
  // Collect all named colors from artworks
  const colorMap = new Map(); // name -> {name, code, hex}
  for (const a of artworksList) {
    const named = a.namedColors || [];
    for (const nc of named) {
      if (!colorMap.has(nc.name)) {
        colorMap.set(nc.name, nc);
      }
    }
  }

  const sorted = Array.from(colorMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  container.innerHTML = "";

  const all = document.createElement("button");
  all.type = "button";
  all.className = "colorPill colorPill--active";
  all.dataset.color = "";
  all.innerHTML = `<span class="colorPill__dot" style="--c:#ffffff"></span><span>All</span>`;
  all.addEventListener("click", () => setColor(null));
  container.appendChild(all);

  for (const nc of sorted) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "colorPill";
    btn.dataset.color = nc.name;
    btn.innerHTML = `<span class="colorPill__dot" style="--c:${nc.hex}"></span><span>${nc.name}</span>`;
    btn.addEventListener("click", () => setColor(nc.name));
    container.appendChild(btn);
  }
}

function setActiveColorPill(container, activeName) {
  $$(".colorPill", container).forEach((el) => el.classList.remove("colorPill--active"));
  if (!activeName) {
    const first = $(".colorPill", container);
    if (first) first.classList.add("colorPill--active");
    return;
  }
  const match = $$(".colorPill", container).find((el) => el.dataset.color === activeName);
  if (match) match.classList.add("colorPill--active");
}

// ── Price ──

function priceStarting(art) {
  const tiers = art.priceTiers || {};
  const v = Number(tiers.startingPrice ?? tiers.low ?? tiers.base ?? 0);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

// ── Filtering ──

function artworkMatchesFilters(art) {
  const styleOk = !state.style || String(art.style) === String(state.style);

  // Color filter by named color
  let colorOk = true;
  if (state.color) {
    const named = art.namedColors || [];
    colorOk = named.some((nc) => nc.name === state.color);
  }

  const queryOk = !state.query
    ? true
    : [art.title, art.style, art.category, art.sku,
       Array.isArray(art.seoKeywords) ? art.seoKeywords.join(" ") : "",
       Array.isArray(art.namedColors) ? art.namedColors.map(c => c.name).join(" ") : "",
      ].filter(Boolean).join(" ").toLowerCase().includes(state.query.toLowerCase());

  return styleOk && colorOk && queryOk;
}

// ── Cards ──

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
    const categoryLabel = art.category || "";

    card.innerHTML = `
      <div class="card__imgWrap">
        <img class="card__img" src="${thumb}" alt="${escapeHtml(art.title || "Artwork")}" loading="lazy" />
        ${categoryLabel ? `<span class="card__category">${escapeHtml(categoryLabel)}</span>` : ""}
      </div>
      <div class="card__body">
        <h3 class="card__title">${escapeHtml(art.title || "Untitled")}</h3>
        <div class="card__sub">
          <span>${escapeHtml(art.style || "")}</span>
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

// ── Modal ──

function openModal(art) {
  state.selectedArtwork = art;
  $("#modalSku").textContent = art.sku || "";
  $("#modalTitle").textContent = art.title || "Untitled";
  $("#modalDescription").textContent = art.description || "";
  $("#modalStyleBadge").textContent = art.style || "";
  $("#modalCategoryBadge").textContent = art.category || "";

  const imgSrc = art.image || art.thumb || "./assets/images/placeholder.svg";
  $("#modalImage").src = imgSrc;
  $("#modalImage").alt = art.title || "Artwork image";

  // Show named colors in modal
  const colorsEl = $("#modalColors");
  const named = art.namedColors || [];
  colorsEl.innerHTML = named
    .map((nc) => `
    <div class="colorSwatch">
      <span class="colorSwatch__dot" style="--c:${nc.hex}"></span>
      <span class="colorSwatch__hex">${nc.name}</span>
    </div>`)
    .join("");

  const start = priceStarting(art);
  $("#modalPrice").textContent = start ? formatMoney(start) : "Contact for pricing";

  const products = Array.isArray(art.bestProducts) ? art.bestProducts.join(", ") : "";
  $("#modalBestProducts").textContent = products || "—";

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

// ── Filters ──

function setStyle(val) {
  state.style = val;
  setActivePill($("#styleFilters"), val);
  renderCards();
}

function setColor(val) {
  state.color = val;
  setActiveColorPill($("#colorFilters"), val);
  renderCards();
}

function initFilters() {
  const styles = uniqueSorted(artworks.map((a) => a.style));
  renderPill($("#styleFilters"), styles, (v) => setStyle(v), { noneLabel: "All styles" });
  renderNamedColorPills($("#colorFilters"), artworks);

  setActivePill($("#styleFilters"), null);
}

// ── Cart ──

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
          <span>${escapeHtml(art.style || "")}</span>
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

  const baseCheckout = config.checkoutUrl || "#";
  if (baseCheckout === "#" || !baseCheckout) {
    $("#checkoutLink").href = "#";
    return;
  }
  const payload = { items, currency: config.currency };
  const encoded = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    : encodeURIComponent(JSON.stringify(payload));
  const joiner = baseCheckout.includes("?") ? "&" : "?";
  $("#checkoutLink").href = `${baseCheckout}${joiner}cart=${encoded}`;
}

// ── Data loading ──

async function loadJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return await res.json();
}

// ── UI Setup (immediate, before async) ──

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

// ── Init ──

async function init() {
  try {
    config = await loadJSON("./data/config.json");
  } catch {}

  try {
    artworks = await loadJSON("./data/artworks.json");
  } catch (e) {
    console.warn("[arttra] No artworks.json — gallery empty.");
    artworks = [];
  }

  document.title = `${config.siteName || "arttra.art"} — Original art`;

  initFilters();
  renderCards();
  renderCart();

  const search = $("#searchInput");
  search.addEventListener("input", (e) => {
    state.query = e.target.value || "";
    renderCards();
  });

  $("#clearFiltersBtn").addEventListener("click", () => {
    state.style = null;
    state.color = null;
    $("#searchInput").value = "";
    state.query = "";
    setActivePill($("#styleFilters"), null);
    setActiveColorPill($("#colorFilters"), null);
    renderCards();
  });
}

init();
