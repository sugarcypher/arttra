/**
 * arttra.art checkout Worker — slices 1 + 2 + size/material options.
 *
 *   POST /checkout   body: { items: [{ id, option, qty }] } -> { url }
 *                    `option` is "material:size[:frame]" (e.g. "canvas:24x36",
 *                    "framed:18x24:black"). It is validated against
 *                    data/products.json + the artwork's real resolution by the
 *                    SAME shared/options.js the storefront uses. Missing option
 *                    -> the artwork's default option (legacy carts keep working).
 *   POST /webhook    Stripe -> on checkout.session.completed, creates a
 *                    Printful v2 draft order (auto-confirms if env says so).
 *
 * Prices are looked up SERVER-SIDE from artworks.json. The browser is never
 * trusted for prices — it only says which item and how many.
 *
 * Deploy:  cd worker && npx wrangler deploy
 * Required secrets (set via `npx wrangler secret put NAME`):
 *   STRIPE_SECRET_KEY        sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET    whsec_... from Stripe Dashboard -> Webhooks
 *   PRINTFUL_API_KEY         Bearer token from Printful Dashboard
 * Optional vars (set in wrangler.toml [vars]):
 *   PRINTFUL_VARIANT_SQUARE/_PORTRAIT/_LANDSCAPE  catalog variant ids, chosen
 *                                 per artwork shape (square art -> square
 *                                 product, etc). At least the shapes you sell
 *                                 must be set for /webhook to fulfill.
 *   PRINTFUL_DEFAULT_VARIANT_ID   fallback variant id used for any shape that
 *                                 has no per-shape variant configured.
 *   PRINTFUL_AUTO_CONFIRM         "true" to auto-confirm the draft order for
 *                                 fulfillment. Default false (draft stays for
 *                                 human review in Printful Dashboard).
 *   REPLICATE_API_TOKEN (secret)  enables on-demand AI upscaling for sizes
 *                                 beyond a piece's real pixels; result saved
 *                                 to R2 (binding ART_BUCKET) as
 *                                 enhanced/<sku>.png and reused.
 */

import { resolveOption, defaultOptionKey } from "../../shared/options.js";

const MAX_ITEMS = 50;
const MAX_QTY = 20;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const WEBHOOK_TOLERANCE_S = 300;
const ID_PATTERN = /^[A-Za-z0-9_\-]{1,64}$/;

export default {
  async fetch(request, env) {
    const origin = resolveOrigin(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response("arttra checkout worker — POST /checkout (options-v2)", {
        status: 200,
        headers: { "Content-Type": "text/plain", ...corsHeaders(origin) },
      });
    }

    if (request.method === "POST" && pathname === "/checkout") {
      if (!originAllowed(request, env)) {
        return json({ error: "Origin not allowed." }, 403, origin);
      }
      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        return json({ error: "Unsupported content type." }, 415, origin);
      }
      const lengthHeader = parseInt(request.headers.get("Content-Length") || "0", 10);
      if (lengthHeader > MAX_BODY_BYTES) {
        return json({ error: "Request too large." }, 413, origin);
      }
      return handleCheckout(request, env, origin);
    }

    // Replicate calls back here when an on-demand AI upscale finishes.
    if (request.method === "POST" && pathname === "/upscale-done") {
      return handleUpscaleDone(request, env);
    }

    // Stripe webhook — no CORS (Stripe is server-to-server, not browser).
    if (request.method === "POST" && pathname === "/webhook") {
      return handleStripeWebhook(request, env);
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
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-site",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

function originAllowed(request, env) {
  const reqOrigin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "https://arttra.art";
  if (reqOrigin === allowed) return true;
  if (env.DEV === "true" && /^http:\/\/localhost(:\d+)?$/.test(reqOrigin)) return true;
  return false;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin), ...securityHeaders() },
  });
}

// --- Checkout ---------------------------------------------------------------

async function handleCheckout(request, env, origin) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Checkout is not configured yet." }, 500, origin);
  }

  let bodyText;
  try {
    bodyText = await request.text();
  } catch {
    return json({ error: "Invalid request." }, 400, origin);
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return json({ error: "Request too large." }, 413, origin);
  }
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return json({ error: "Invalid request." }, 400, origin);
  }

  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (items.length === 0) return json({ error: "Your cart is empty." }, 400, origin);
  if (items.length > MAX_ITEMS) return json({ error: "Too many items." }, 400, origin);

  let catalog, products;
  try {
    [catalog, products] = await Promise.all([loadCatalog(env), loadProducts(env)]);
  } catch {
    return json({ error: "Could not load the catalog. Please try again." }, 502, origin);
  }

  const lineItems = [];
  for (const raw of items) {
    const id = String((raw && raw.id) || "");
    if (!ID_PATTERN.test(id)) return json({ error: "Invalid item." }, 400, origin);
    const qty = Math.max(1, Math.min(MAX_QTY, parseInt(raw && raw.qty, 10) || 1));
    const art = catalog.get(id);
    // Reject unknown ids loudly — silently skipping would mean a $0 order.
    if (!art) return json({ error: "An item is no longer available." }, 400, origin);
    const optKey = String((raw && raw.option) || "") || defaultOptionKey(art.raw, products);
    // Price, Printful variant and orientation all come from the server-side
    // product table; an option the artwork can't print sharp is rejected.
    const opt = resolveOption(art.raw, products, optKey);
    if (!opt) return json({ error: `"${art.title}" isn't available in that size or material.` }, 400, origin);
    lineItems.push({
      qty, sku: id, name: `${art.title} \u2014 ${opt.label}`, amount: Math.round(opt.price * 100), image: art.image,
      option: opt.key, variantId: opt.variantId, orientation: opt.orientation,
      placement: opt.placement, technique: opt.technique, needsUpscale: opt.needsUpscale, shipping: opt.shipping,
    });
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
    if (a && a.hidden === true) continue;
    const pd = (a && a.printDimensions) || {};
    map.set(id, {
      title: (a && a.title) || "Untitled artwork",
      price: Number(a && a.priceTiers && a.priceTiers.startingPrice) || 0,
      image: absoluteUrl((a && (a.image || a.thumb)) || "", env),
      // Public R2 print-file URL (set by the build pipeline). Empty until
      // slice 3's R2 upload runs; the webhook falls back when it's missing.
      printUrl: (a && a.printUrl) || "",
      // Print dimensions drive which Printful variant (square / portrait /
      // landscape) the order maps to.
      w: Number(pd.pixelWidth || pd.widthInches) || 0,
      h: Number(pd.pixelHeight || pd.heightInches) || 0,
      // Full record: shared/options.js reads sourcePixels / printDimensions.
      raw: a,
      sourceFile: (a && a.sourceFile) || "",
      canvasCropped: !!(a && a.canvasCropped),
    });
  }
  return map;
}

// data/products.json -> sizes, materials, prices, Printful variant ids.
async function loadProducts(env) {
  const src = env.PRODUCTS_URL || "https://arttra.art/data/products.json";
  const res = await fetch(src, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error("products unavailable");
  const data = await res.json();
  if (!data || !Array.isArray(data.materials)) throw new Error("products malformed");
  return data;
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

  // Printful needs a shipping address — collect it.
  // Printful ships worldwide; this list covers its main markets. Extend freely.
  for (const country of ["US", "CA", "GB", "AU", "NZ", "IE", "DE", "FR", "NL", "BE", "LU", "AT", "CH",
    "IT", "ES", "PT", "DK", "SE", "NO", "FI", "PL", "CZ", "JP", "SG", "HK", "KR", "MX", "AE", "IL"]) {
    form.append("shipping_address_collection[allowed_countries][]", country);
  }

  // Flat shipping: covers Printful's per-order shipping cost (~$10-15). Set
  // SHIPPING_FLAT_USD on the Worker to enable. When unset, shipping is free,
  // which is fine for test mode but loses money on live orders.
  // Shipping: the largest per-item rate in products.json (big canvas ships
  // dearer than a rolled print), never below SHIPPING_FLAT_USD.
  const shipUsd = Math.max(parseFloat(env.SHIPPING_FLAT_USD || "0") || 0, ...lineItems.map(li => Number(li.shipping) || 0));
  if (shipUsd > 0) {
    const cents = Math.round(shipUsd * 100);
    form.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
    form.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(cents));
    form.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
    form.set("shipping_options[0][shipping_rate_data][display_name]", "Standard shipping");
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
    // The resolved option rides along so the webhook orders the exact
    // Printful variant the buyer paid for.
    if (li.option) {
      form.set(`${p}[price_data][product_data][metadata][option]`, li.option);
      form.set(`${p}[price_data][product_data][metadata][variant_id]`, String(li.variantId));
      form.set(`${p}[price_data][product_data][metadata][orientation]`, li.orientation);
      form.set(`${p}[price_data][product_data][metadata][placement]`, li.placement);
      form.set(`${p}[price_data][product_data][metadata][technique]`, li.technique);
      if (li.needsUpscale) form.set(`${p}[price_data][product_data][metadata][needs_upscale]`, "1");
    }
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

// --- Slice 2: Stripe webhook -> Printful order ------------------------------

async function handleStripeWebhook(request, env) {
  // Plain-text replies (Stripe doesn't care about JSON, and we don't want CORS
  // headers on the webhook surface).
  const reply = (status, message) =>
    new Response(message, {
      status,
      headers: { "Content-Type": "text/plain", ...securityHeaders() },
    });

  if (!env.STRIPE_WEBHOOK_SECRET) return reply(503, "Webhook secret not configured.");
  if (!env.STRIPE_SECRET_KEY) return reply(503, "Stripe key not configured.");

  const sig = request.headers.get("Stripe-Signature") || "";
  if (!sig) return reply(400, "Missing signature.");

  const lengthHeader = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (lengthHeader > MAX_WEBHOOK_BYTES) return reply(413, "Body too large.");

  let body;
  try {
    body = await request.text();
  } catch {
    return reply(400, "Could not read body.");
  }
  if (body.length > MAX_WEBHOOK_BYTES) return reply(413, "Body too large.");

  let verified;
  try {
    verified = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return reply(400, `Signature check failed: ${err.message || "unknown"}`);
  }
  if (!verified) return reply(400, "Signature check failed.");

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return reply(400, "Invalid JSON.");
  }

  // Idempotency: Stripe retries on non-2xx, so dedupe by event.id with the
  // Cache API (per-colo cache, fine for short-window dedup).
  const eventId = String(event && event.id || "");
  if (!eventId) return reply(400, "Missing event id.");
  const cacheKey = new Request(`https://arttra.internal/webhook-seen/${encodeURIComponent(eventId)}`);
  if (await caches.default.match(cacheKey)) return reply(200, "Already processed.");

  try {
    if (event.type === "checkout.session.completed") {
      await onCheckoutSessionCompleted(event.data && event.data.object, env);
    }
    // All other event types: accept silently so Stripe stops retrying.
    await caches.default.put(
      cacheKey,
      new Response("ok", { headers: { "Cache-Control": "max-age=604800" } })
    );
    return reply(200, "ok");
  } catch (err) {
    // Return 500 so Stripe will retry. The cache write didn't happen, so a
    // retry will re-attempt fulfillment.
    return reply(500, `Handler error: ${err && err.message ? err.message : "unknown"}`);
  }
}

// Constant-time hex compare. Both strings must be the same length to avoid
// leaking length via timing; the verifier feeds equal-length hex digests.
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Stripe-Signature header format:  "t=TIMESTAMP,v1=SIG[,v0=...,v1=...]"
async function verifyStripeSignature(rawBody, header, secret) {
  const parts = String(header).split(",").map((p) => p.trim());
  let timestamp = null;
  const v1Sigs = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === "t") timestamp = v;
    else if (k === "v1") v1Sigs.push(v);
  }
  if (!timestamp || !v1Sigs.length) throw new Error("malformed signature header");
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) throw new Error("bad timestamp");
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (ageSec > WEBHOOK_TOLERANCE_S) throw new Error("timestamp outside tolerance");
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  for (const candidate of v1Sigs) {
    if (timingSafeEqualHex(candidate, expected)) return true;
  }
  return false;
}

async function onCheckoutSessionCompleted(session, env) {
  if (!session || !session.id) throw new Error("session missing id");
  // Only act on paid sessions. Stripe also fires this event for async-payment
  // statuses; we wait for the explicit paid signal.
  if (session.payment_status !== "paid") return;

  // Need shipping address + line items. Shipping is on the session object;
  // line items must be fetched separately.
  const recipient = stripeShippingToPrintful(session);
  if (!recipient) throw new Error("missing shipping details");

  const lineItems = await stripeFetchLineItems(session.id, env);
  if (!lineItems.length) throw new Error("no line items on session");


  // Per-SKU print-file URLs ride along in the catalog (slice 3: R2-hosted).
  // Load once; if it's unavailable we still proceed via the fallback URL so a
  // transient catalog fetch failure doesn't trap a paid order in Stripe's
  // retry loop.
  let catalog;
  try {
    catalog = await loadCatalog(env);
  } catch {
    catalog = new Map();
  }

  // On-demand AI upscale: any line whose size needs more than the real pixels
  // uses the saved enhanced file (R2 enhanced/<sku>.png). If it isn't there
  // yet, kick off one Real-ESRGAN job per artwork and stop; /upscale-done
  // re-runs this function for the session once the file is saved.
  const enhancedUrl = {};
  const pendingUpscale = [];
  for (const li of lineItems) {
    const meta = (li.price && li.price.product && li.price.product.metadata) || {};
    if (meta.needs_upscale !== "1" || !meta.sku || enhancedUrl[meta.sku] !== undefined) continue;
    const url = await enhancedFileUrl(env, meta.sku);
    enhancedUrl[meta.sku] = url || "";
    if (!url) pendingUpscale.push(meta.sku);
  }
  if (pendingUpscale.length && env.REPLICATE_API_TOKEN && env.ART_BUCKET) {
    let started = 0;
    for (const sku of pendingUpscale) {
      const entry = catalog.get(sku);
      if (!entry || entry.canvasCropped) continue;
      if (await startUpscale(env, sku, entry, session.id)) started++;
    }
    if (started) return; // fulfillment resumes from /upscale-done
  }

  const printfulItems = [];
  for (const [i, li] of lineItems.entries()) {
    const meta = (li.price && li.price.product && li.price.product.metadata) || (li.price && li.price.metadata) || {};
    const sku = meta.sku || "";
    const name = (li.price && li.price.product && li.price.product.name) || li.description || "Artwork";
    const entry = catalog.get(sku);
    // Enhanced (AI-upscaled) file when this size needed one, else the print file.
    // Never substitute another artwork's file: a missing print file is an error
    // (Stripe retries; the paid order is visible in the dashboard).
    const printUrl = (meta.needs_upscale === "1" && enhancedUrl[sku]) || (entry && entry.printUrl) || "";
    if (!printUrl) throw new Error(`no print file for ${sku || name}`);
    // Map each artwork to a Printful variant by its shape, so square art goes
    // on a square product, portrait on portrait, landscape on landscape.
    // Option orders (metadata set server-side at /checkout) carry their exact
    // variant. Legacy orders without one fall back to the per-shape mapping.
    const bucket = aspectBucket(entry && entry.w, entry && entry.h);
    const variantId = Number(meta.variant_id) || variantForBucket(env, bucket);
    if (!variantId) {
      throw new Error(`no Printful variant for ${bucket} shape (set PRINTFUL_VARIANT_${bucket.toUpperCase()} or PRINTFUL_DEFAULT_VARIANT_ID)`);
    }
    // A rectangular variant prints either way up; orientation picks which.
    // Portrait art -> vertical, landscape -> horizontal. Square is symmetric.
    const orientation = meta.orientation || (bucket === "landscape" ? "horizontal" : "vertical");
    printfulItems.push({
      source: "catalog",
      catalog_variant_id: variantId,
      quantity: Math.max(1, Math.min(MAX_QTY, parseInt(li.quantity, 10) || 1)),
      placements: [
        {
          // placement + technique are PRODUCT-SPECIFIC. Override per product via
          // env (canvas = placement "default", technique "digital"). Orientation
          // selects vertical/horizontal print on a rectangular variant.
          placement: meta.placement || env.PRINTFUL_PLACEMENT || "default",
          technique: meta.technique || env.PRINTFUL_TECHNIQUE || "digital",
          orientation,
          layers: [{ type: "file", url: printUrl }],
        },
      ],
      // Printful caps external_id at 32 chars. Use the session id's
      // high-entropy tail + item index: unique per item, stable across
      // Stripe retries (same session -> same ids), and within the limit.
      external_id: `${session.id.slice(-24)}-${i}`.slice(0, 32),
    });
  }

  // Printful API v2 expects the top-level array named `items` (not
  // `order_items` — that was v1). Verified against the v2-beta docs.
  const draft = await printfulCreateDraft(env, {
    // Printful caps external_id at 32 chars; the session id is ~66. The tail
    // is the unique part (the cs_test_/cs_live_ prefix is constant), and it's
    // stable per session, so it doubles as the idempotency key on retries.
    external_id: session.id.slice(-32),
    recipient,
    items: printfulItems,
  });

  // Optional auto-confirm. Defaults to OFF: drafts wait for human review.
  if (String(env.PRINTFUL_AUTO_CONFIRM || "").toLowerCase() === "true" && draft && draft.id) {
    await printfulConfirmDraft(env, draft.id);
  }
}

// --- On-demand AI upscale (Replicate Real-ESRGAN -> R2) -----------------------

function enhancedKey(sku) { return `enhanced/${sku}.png`; }

async function enhancedFileUrl(env, sku) {
  if (!env.ART_BUCKET || !env.R2_PUBLIC_BASE) return "";
  const head = await env.ART_BUCKET.head(enhancedKey(sku));
  return head ? `${env.R2_PUBLIC_BASE.replace(/\/+$/, "")}/${enhancedKey(sku)}` : "";
}

function sourceUrl(env, entry) {
  const base = (env.SOURCE_BASE_URL || "https://raw.githubusercontent.com/sugarcypher/arttra/main/gallery-source").replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(entry.sourceFile)}`;
}

async function startUpscale(env, sku, entry, sessionId) {
  if (!entry.sourceFile) return false;
  // One job per artwork at a time: a marker in R2 dedupes concurrent orders.
  const marker = `enhancing/${sku}.json`;
  const existing = await env.ART_BUCKET.get(marker);
  const sessions = existing ? (await existing.json()).sessions || [] : [];
  if (!sessions.includes(sessionId)) sessions.push(sessionId);
  if (existing) {
    await env.ART_BUCKET.put(marker, JSON.stringify({ sessions, started: Date.now() }));
    return true;
  }
  const w = Number(entry.raw && entry.raw.sourcePixels && entry.raw.sourcePixels.w) || 0;
  const h = Number(entry.raw && entry.raw.sourcePixels && entry.raw.sourcePixels.h) || 0;
  const maxLong = Number(env.UPSCALE_MAX_LONG_EDGE || 12000);
  const scale = Math.max(2, Math.min(4, Math.floor(maxLong / Math.max(w, h, 1))));
  const token = await hmacSha256Hex(env.UPSCALE_CALLBACK_SECRET || env.STRIPE_WEBHOOK_SECRET, sku);
  const callback = `${(env.WORKER_URL || "").replace(/\/+$/, "")}/upscale-done?sku=${encodeURIComponent(sku)}&t=${token}`;
  const model = await fetch(`https://api.replicate.com/v1/models/${env.REPLICATE_MODEL || "nightmareai/real-esrgan"}`, {
    headers: { Authorization: "Bearer " + env.REPLICATE_API_TOKEN },
  }).then(r => r.json()).catch(() => ({}));
  const version = model && model.latest_version && model.latest_version.id;
  if (!version) return false;
  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.REPLICATE_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      version,
      input: { image: sourceUrl(env, entry), scale, face_enhance: false },
      webhook: callback,
      webhook_events_filter: ["completed"],
    }),
  });
  if (!res.ok) return false;
  await env.ART_BUCKET.put(marker, JSON.stringify({ sessions, started: Date.now() }));
  return true;
}

async function handleUpscaleDone(request, env) {
  const reply = (status, msg) => new Response(msg, { status, headers: { "Content-Type": "text/plain", ...securityHeaders() } });
  const u = new URL(request.url);
  const sku = u.searchParams.get("sku") || "";
  if (!ID_PATTERN.test(sku)) return reply(400, "bad sku");
  const expected = await hmacSha256Hex(env.UPSCALE_CALLBACK_SECRET || env.STRIPE_WEBHOOK_SECRET, sku);
  if (!timingSafeEqualHex(u.searchParams.get("t") || "", expected)) return reply(403, "bad token");
  let body;
  try { body = await request.json(); } catch { return reply(400, "bad json"); }
  // Don't trust the callback body: re-read the prediction from Replicate.
  const id = String((body && body.id) || "");
  if (!/^[a-z0-9]{8,64}$/i.test(id)) return reply(400, "bad id");
  const pred = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: "Bearer " + env.REPLICATE_API_TOKEN },
  }).then(r => r.json()).catch(() => ({}));
  const marker = `enhancing/${sku}.json`;
  const m = await env.ART_BUCKET.get(marker);
  const sessions = m ? (await m.json()).sessions || [] : [];
  if (pred.status === "succeeded") {
    const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    const img = await fetch(out);
    if (!img.ok || !img.body) return reply(502, "output fetch failed");
    // Saved once, reused for every later order of this piece.
    await env.ART_BUCKET.put(enhancedKey(sku), img.body, { httpMetadata: { contentType: "image/png" } });
  }
  await env.ART_BUCKET.delete(marker);
  // Resume fulfillment for every order that was waiting on this piece. On a
  // failed upscale the re-run falls back to the standard print file.
  for (const sid of sessions) {
    try {
      const sres = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sid)}`, {
        headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY },
      });
      if (!sres.ok) continue;
      const session = await sres.json();
      await onCheckoutSessionCompleted(session, { ...env, REPLICATE_API_TOKEN: pred.status === "succeeded" ? env.REPLICATE_API_TOKEN : "" });
    } catch (e) {
      console.log("resume failed", sid, e && e.message);
    }
  }
  return reply(200, "ok");
}

// Classify an artwork's shape from its print dimensions. Thresholds give a
// ~15% tolerance band around 1:1 so near-square pieces map to the square
// product. Unknown dimensions fall back to "square" (the most forgiving crop).
function aspectBucket(w, h) {
  if (!w || !h) return "square";
  const r = w / h;
  if (r >= 1.15) return "landscape";
  if (r <= 0.87) return "portrait";
  return "square";
}

// Resolve the Printful catalog_variant_id for a shape bucket, with the
// single-variant PRINTFUL_DEFAULT_VARIANT_ID as a fallback when a per-shape
// variant isn't configured.
function variantForBucket(env, bucket) {
  const perShape = {
    square: env.PRINTFUL_VARIANT_SQUARE,
    portrait: env.PRINTFUL_VARIANT_PORTRAIT,
    landscape: env.PRINTFUL_VARIANT_LANDSCAPE,
  }[bucket];
  return Number(perShape || env.PRINTFUL_DEFAULT_VARIANT_ID) || 0;
}

function stripeShippingToPrintful(session) {
  // Where Stripe puts the collected shipping address has moved across API
  // versions: newer versions use session.collected_information.shipping_details,
  // older ones use session.shipping_details. Fall back to the billing address
  // (customer_details) only as a last resort. Prefer the real shipping address.
  const ci = (session.collected_information && session.collected_information.shipping_details) || null;
  const legacy = session.shipping_details || null;
  const ship = (ci && ci.address) ||
    (legacy && legacy.address) ||
    (session.customer_details && session.customer_details.address) || null;
  const name = (ci && ci.name) ||
    (legacy && legacy.name) ||
    (session.customer_details && session.customer_details.name) || "";
  const email = (session.customer_details && session.customer_details.email) || "";
  const phone = (session.customer_details && session.customer_details.phone) || "";
  if (!ship || !ship.line1 || !ship.country) return null;
  return {
    name,
    email,
    phone,
    address1: ship.line1,
    address2: ship.line2 || "",
    city: ship.city || "",
    state_code: ship.state || "",
    country_code: ship.country,
    zip: ship.postal_code || "",
  };
}

async function stripeFetchLineItems(sessionId, env) {
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100&expand[]=data.price.product`;
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`stripe line_items ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data && data.data) ? data.data : [];
}

// NOTE: Printful API v2 is in open beta. The order body uses `items` (verified
// against the v2-beta docs — v1 used `order_items`); items carry
// catalog_variant_id + placements/technique/layers; recipient uses
// state_code/country_code. The confirm endpoint path (/confirmation) and the
// per-product placement/technique should still be re-verified against the live
// docs before flipping PRINTFUL_AUTO_CONFIRM=true. A bad shape surfaces as a
// 4xx in the create call → 500 webhook response → Stripe retry, so keeping
// AUTO_CONFIRM off lets you eyeball the draft in the Printful Dashboard first.
async function printfulCreateDraft(env, body) {
  const res = await fetch("https://api.printful.com/v2/orders", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.PRINTFUL_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Printful's error can be a string OR an object ({message,reason}/array);
    // stringify robustly so the real reason surfaces instead of "[object Object]".
    const e = data && data.error;
    const msg =
      (typeof data.detail === "string" && data.detail) ||
      (e && typeof e === "object" && (e.message || e.reason)) ||
      (typeof e === "string" && e) ||
      (data && data.result && data.result.message) ||
      JSON.stringify(data).slice(0, 300) ||
      `status ${res.status}`;
    throw new Error(`printful create ${res.status}: ${msg}`);
  }
  // v2 wraps the order under `data`.
  return (data && data.data) || data;
}

async function printfulConfirmDraft(env, orderId) {
  const res = await fetch(`https://api.printful.com/v2/orders/${encodeURIComponent(orderId)}/confirmation`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.PRINTFUL_API_KEY,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`printful confirm ${res.status}: ${text.slice(0, 200)}`);
  }
}
