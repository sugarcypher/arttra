/**
 * arttra.art checkout Worker — slice 1 (Stripe payment skeleton).
 *
 *   POST /checkout   body: { items: [{ id, qty }] }   ->   { url }
 *
 * Prices are looked up SERVER-SIDE from the live artworks.json. The browser is
 * never trusted for prices — it only says which item and how many.
 *
 * Deploy:  cd worker && npx wrangler deploy
 * Secret:  npx wrangler secret put STRIPE_SECRET_KEY   (use a TEST key first)
 *
 * TODO before going live: this charges only the artwork price. Printful adds
 * ~$10-15 shipping per order. Add Stripe `shipping_options` (flat rate) or fold
 * shipping into the prices before switching STRIPE_SECRET_KEY to a live key.
 */

const MAX_ITEMS = 50;
const MAX_QTY = 20;

export default {
  async fetch(request, env) {
    const origin = resolveOrigin(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response("arttra checkout worker — POST /checkout", {
        status: 200,
        headers: { "Content-Type": "text/plain", ...corsHeaders(origin) },
      });
    }

    if (request.method === "POST" && pathname === "/checkout") {
      return handleCheckout(request, env, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  },
};

// --- CORS -------------------------------------------------------------------

function resolveOrigin(request, env) {
  const reqOrigin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "https://arttra.art";
  if (reqOrigin === allowed) return reqOrigin;
  if (env.DEV === "true" && /^http:\/\/localhost(:\d+)?$/.test(reqOrigin)) return reqOrigin;
  return allowed;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// --- Checkout ---------------------------------------------------------------

async function handleCheckout(request, env, origin) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Checkout is not configured yet." }, 500, origin);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400, origin);
  }

  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (items.length === 0) return json({ error: "Your cart is empty." }, 400, origin);
  if (items.length > MAX_ITEMS) return json({ error: "Too many items." }, 400, origin);

  let catalog;
  try {
    catalog = await loadCatalog(env);
  } catch {
    return json({ error: "Could not load the catalog. Please try again." }, 502, origin);
  }

  const lineItems = [];
  for (const raw of items) {
    const id = String((raw && raw.id) || "");
    const qty = Math.max(1, Math.min(MAX_QTY, parseInt(raw && raw.qty, 10) || 1));
    const art = catalog.get(id);
    // Reject unknown ids loudly — silently skipping would mean a $0 order.
    if (!art) return json({ error: "An item is no longer available." }, 400, origin);
    if (!(art.price > 0)) return json({ error: `"${art.title}" is not for sale online.` }, 400, origin);
    lineItems.push({ qty, sku: id, name: art.title, amount: Math.round(art.price * 100), image: art.image });
  }

  try {
    const url = await createCheckoutSession(env, lineItems);
    return json({ url }, 200, origin);
  } catch (err) {
    return json({ error: (err && err.message) || "Could not start checkout." }, 502, origin);
  }
}

// Fetch the live artworks.json (edge-cached) -> Map(id -> {title, price, image}).
async function loadCatalog(env) {
  const src = env.ARTWORKS_URL || "https://arttra.art/data/artworks.json";
  const res = await fetch(src, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error("catalog unavailable");
  const list = await res.json();
  const map = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    const id = String((a && (a.id || a.sku)) || "");
    if (!id) continue;
    map.set(id, {
      title: (a && a.title) || "Untitled artwork",
      price: Number(a && a.priceTiers && a.priceTiers.startingPrice) || 0,
      image: absoluteUrl((a && (a.image || a.thumb)) || "", env),
    });
  }
  return map;
}

function absoluteUrl(path, env) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const base = (env.ALLOWED_ORIGIN || "https://arttra.art").replace(/\/+$/, "");
  return base + "/" + String(path).replace(/^\.?\/+/, "");
}

async function createCheckoutSession(env, lineItems) {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", env.SUCCESS_URL || "https://arttra.art/success.html");
  form.set("cancel_url", env.CANCEL_URL || "https://arttra.art/?checkout=cancelled");

  // Printful (slice 2) needs a shipping address — collect it now.
  for (const country of ["US", "CA", "GB", "AU", "DE", "FR"]) {
    form.append("shipping_address_collection[allowed_countries][]", country);
  }

  lineItems.forEach((li, i) => {
    const p = `line_items[${i}]`;
    form.set(`${p}[quantity]`, String(li.qty));
    form.set(`${p}[price_data][currency]`, "usd");
    form.set(`${p}[price_data][unit_amount]`, String(li.amount));
    form.set(`${p}[price_data][product_data][name]`, li.name);
    if (li.image) form.set(`${p}[price_data][product_data][images][0]`, li.image);
    // SKU rides along so slice 2's webhook can map the order to Printful.
    form.set(`${p}[price_data][product_data][metadata][sku]`, li.sku);
  });

  // Idempotency: a double-click within the same minute reuses one session
  // instead of creating two.
  const idemKey = await sha256Hex(JSON.stringify(lineItems) + "|" + Math.floor(Date.now() / 60000));

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idemKey,
    },
    body: form.toString(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error && data.error.message) || "Stripe rejected the request.");
  if (!data.url) throw new Error("Stripe did not return a checkout URL.");
  return data.url;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
