#!/usr/bin/env bash
#
# Deploy the arttra-checkout Worker: push secrets from .dev.vars to the LIVE
# Worker, then deploy the current code. Safe to re-run (idempotent).
#
#   cd worker && ./deploy.sh
#
set -euo pipefail

cd "$(dirname "$0")"

# --- Preconditions ----------------------------------------------------------

if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx not found (install Node.js)." >&2
  exit 1
fi

if [[ ! -f .dev.vars ]]; then
  echo "error: .dev.vars not found. Create it (see .dev.vars template) and fill" >&2
  echo "       in your STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PRINTFUL_API_KEY." >&2
  exit 1
fi

# Refuse to upload unfilled placeholders (lines like  KEY=<...> ).
if grep -qE '=<.*>' .dev.vars; then
  echo "error: .dev.vars still has placeholder values:" >&2
  grep -nE '=<.*>' .dev.vars | sed 's/^/       /' >&2
  echo "       Replace every <...> with a real value before deploying." >&2
  exit 1
fi

# --- Upload secrets, then deploy --------------------------------------------

echo "==> Uploading secrets from .dev.vars to the live Worker..."
npx wrangler secret bulk .dev.vars

echo "==> Deploying Worker code..."
npx wrangler deploy

echo "==> Done. Verify the webhook route is live:"
echo "    curl -s -X POST https://arttra-checkout.xp76cpmjsg.workers.dev/webhook"
echo "    (expect 200 'Already processed.'/'ok' on a real signed event; a bare"
echo "     curl with no signature should now be 400 'Missing signature.', not 404.)"
