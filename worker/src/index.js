/**
 * arttra.art checkout Worker — slices 1 + 2.
 *
 *   POST /checkout   body: { items: [{ id, qty }] }       -> { url }
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
 *   PRINTFUL_API_TOKEN       Bearer token from Printful Dashboard
 * Optional vars (set in wrangler.toml [vars]):
 *   PRINTFUL_DEFAULT_VARIANT_ID   numeric catalog variant id for slice 2's
 *                                 single-variant mapping (e.g. an 8x10 framed
 *                                 print). Required for /webhook to function.
 *   PRINTFUL_AUTO_CONFIRM         "true" to auto-confirm the draft order for
 *                                 fulfillment. Default false (draft stays for
 *                                 human review in Printful Dashboard).
 *   PRINTFUL_FALLBACK_PRINT_URL   public URL of a print file used when an
 *                                 artwork has no per-SKU `printUrl` in the
 *                                 catalog (slice 3 publishes those to R2).
 */

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
      return new Response("arttra checkout worker — POST /checkout", {
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

  let catalog;
  try {
    catalog = await loadCatalog(env);
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
    if (!(art.price > 0)) return json({ error: "An item is not available for online purchase." }, 400, origin);
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
    if (a && a.hidden === true) continue;
    map.set(id, {
      title: (a && a.title) || "Untitled artwork",
      price: Number(a && a.priceTiers && a.priceTiers.startingPrice) || 0,
      image: absoluteUrl((a && (a.image || a.thumb)) || "", env),
      // Public R2 print-file URL (set by the build pipeline). Empty until
      // slice 3's R2 upload runs; the webhook falls back when it's missing.
      printUrl: (a && a.printUrl) || "",
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

  // Printful needs a shipping address — collect it.
  for (const country of ["US", "CA", "GB", "AU", "DE", "FR"]) {
    form.append("shipping_address_collection[allowed_countries][]", country);
  }

  // Flat shipping: covers Printful's per-order shipping cost (~$10-15). Set
  // SHIPPING_FLAT_USD on the Worker to enable. When unset, shipping is free,
  // which is fine for test mode but loses money on live orders.
  const shipUsd = parseFloat(env.SHIPPING_FLAT_USD || "0");
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

  const variantId = env.PRINTFUL_DEFAULT_VARIANT_ID;
  if (!variantId) throw new Error("PRINTFUL_DEFAULT_VARIANT_ID not set");
  const fallbackPrint = env.PRINTFUL_FALLBACK_PRINT_URL || "";

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

  const printfulItems = [];
  for (const li of lineItems) {
    const sku = (li.price && li.price.product && li.price.product.metadata && li.price.product.metadata.sku) ||
      (li.price && li.price.metadata && li.price.metadata.sku) || "";
    const name = (li.price && li.price.product && li.price.product.name) || li.description || "Artwork";
    const entry = catalog.get(sku);
    const printUrl = (entry && entry.printUrl) || fallbackPrint;
    if (!printUrl) throw new Error(`no print file for ${sku || name} and no PRINTFUL_FALLBACK_PRINT_URL set`);
    printfulItems.push({
      source: "catalog",
      catalog_variant_id: Number(variantId),
      quantity: Math.max(1, Math.min(MAX_QTY, parseInt(li.quantity, 10) || 1)),
      placements: [
        {
          // placement + technique are PRODUCT-SPECIFIC (e.g. a framed poster
          // differs from apparel). Override per chosen variant via env so a
          // mismatch doesn't require a code change. Defaults suit a flat print.
          placement: env.PRINTFUL_PLACEMENT || "default",
          technique: env.PRINTFUL_TECHNIQUE || "digital-printing",
          layers: [{ type: "file", url: printUrl }],
        },
      ],
      external_id: `${session.id}:${sku || name}`.slice(0, 64),
    });
  }

  // Printful API v2 expects the top-level array named `items` (not
  // `order_items` — that was v1). Verified against the v2-beta docs.
  const draft = await printfulCreateDraft(env, {
    external_id: session.id.slice(0, 64),
    recipient,
    items: printfulItems,
  });

  // Optional auto-confirm. Defaults to OFF: drafts wait for human review.
  if (String(env.PRINTFUL_AUTO_CONFIRM || "").toLowerCase() === "true" && draft && draft.id) {
    await printfulConfirmDraft(env, draft.id);
  }
}

function stripeShippingToPrintful(session) {
  // Stripe Checkout populates customer_details.address (and shipping_details
  // for shipped orders). Prefer shipping_details when present.
  const ship = (session.shipping_details && session.shipping_details.address) ||
    (session.customer_details && session.customer_details.address) || null;
  const name = (session.shipping_details && session.shipping_details.name) ||
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
      Authorization: "Bearer " + env.PRINTFUL_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.detail || data.error || (data.result && data.result.message))) || `printful ${res.status}`;
    throw new Error(`printful create: ${msg}`);
  }
  // v2 wraps the order under `data`.
  return (data && data.data) || data;
}

async function printfulConfirmDraft(env, orderId) {
  const res = await fetch(`https://api.printful.com/v2/orders/${encodeURIComponent(orderId)}/confirmation`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.PRINTFUL_API_TOKEN,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`printful confirm ${res.status}: ${text.slice(0, 200)}`);
  }
}
