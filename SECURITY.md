# Security

arttra.art is a static site served by GitHub Pages from the `main` branch of
the public repo `github.com/sugarcypher/arttra`, plus one Cloudflare Worker
(`worker/`, deployed as `arttra-checkout`) that creates Stripe checkouts and
turns paid orders into Printful orders. Print files live in the Cloudflare R2
bucket `artimages`.

The attack surface is: the GitHub account, the repo and its Actions workflows,
the Cloudflare account, the Worker's public routes, and the DNS at Porkbun.

Last reviewed: 2026-11-20. Items marked "checked" were verified that day.

## Reporting a vulnerability

Email help@arttra.art. Do not open a public issue for security problems.

## Open items

**Everything in the repo is public, including the full-size originals.**
`gallery-source/` holds every original, for hidden pieces too, and anything
removed is still in the git history. The right-click blocking on the site is a
courtesy, not protection. Closing this means a private repo (GitHub Pages then
needs a paid plan, and the Worker's upscale source, `SOURCE_BASE_URL`, has to
move) or keeping originals outside the repo.

**Print files are still public until the R2 public URL is switched off.**
`PRINT_PROXY` is on, so Printful gets signed Worker links. Two steps remain,
recorded in `worker/wrangler.toml`: place one test-card order and confirm the
Printful draft shows the artwork, then disable the bucket's public r2.dev URL
in the Cloudflare dashboard. Until then `print/*` and
`private/print-map.json` can be fetched by anyone who knows the file name, and
`data/build_manifest.json` lists the names.

**Account and repo settings (GitHub web UI)**

- [ ] Two-factor login on the `sugarcypher` account. Not verifiable from the
      API; an earlier version of this file recorded it as off. This is the
      highest-impact item: whoever controls the account controls the site.
- [ ] Protect `main` against force-pushes and deletion (Settings → Rules).
      Nothing in the pipeline force-pushes any more, so a rule that blocks
      force-push and deletion is compatible with the build and with ingest.
- [ ] Turn on secret scanning and push protection (Settings → Code security).
      Both are off.
- [ ] Verify `arttra.art` under the account's Pages settings, so the domain
      can't be claimed by another GitHub account if DNS is ever misconfigured.

**DNS (Porkbun)**

- [ ] Add a DMARC record. SPF exists (`include:icloud.com ~all`) but with no
      DMARC record anyone can send mail that appears to come from
      `@arttra.art`.

**Before taking payments live**

- [ ] `PRINTFUL_AUTO_CONFIRM` is `"true"`: the first live order is charged and
      sent to print with no human review. Decide whether the first few live
      orders should stay drafts.
- [ ] A paid order that fails to reach Printful raises no alert. Stripe
      retries the webhook, and the failure is visible in the Worker logs and
      the Stripe dashboard, but nobody is notified.
- [ ] The site has no terms, refund, shipping or privacy pages.

## In place (checked 2026-11-20)

- No API keys, tokens or private keys in the repo or anywhere in its history.
  Worker secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `PRINTFUL_API_KEY`, optionally `REPLICATE_API_TOKEN`) are set on the Worker
  in Cloudflare and are not in the repo. The one GitHub Actions secret is
  `CLOUDFLARE_API_TOKEN`. `worker/.dev.vars` (a local copy, on the owner's
  Mac) is gitignored.
- Checkout prices are computed in the Worker from `data/products.json`; the
  browser only names the item, option and quantity.
- `/checkout` rejects requests whose `Origin` is not `https://arttra.art`.
  This stops other websites, not scripts: the header is trivial to forge
  outside a browser, and the route has no rate limit.
- `/webhook` verifies Stripe's signature and timestamp; `/file` and
  `/upscale-done` verify an HMAC.
- `data/artworks.json` carries no print or source file paths.
- HTTPS is enforced on Pages. The domain has transfer and delete locks.
- Third-party Actions are pinned to commit SHAs. The default workflow token is
  read-only; `build.yml` asks for `contents: write`, the other two for
  `contents: read`.
- Build tooling is pinned: wrangler by exact version with a lock file
  (`worker/package-lock.json`, installed with `npm ci`), Node by
  `actions/setup-node`, Python packages by `arttra/requirements-build.txt`.
- Every hand-written page sets a Content-Security-Policy. p5.js, the one
  script loaded from a CDN, carries a subresource-integrity hash.
- Dependabot alerts and security updates are on.

## Working rules

- No secret belongs in this repo. Keys go in the platform's secret store
  (`wrangler secret put` for the Worker, Actions secrets for CI).
- Never run `git add -A` or `git add .` here. This folder also holds files
  from other projects; they are hidden from git only by this Mac's
  `.git/info/exclude`, which a fresh clone does not have. Stage by path.
- When adding a GitHub Action, pin it to a full commit SHA with the version in
  a trailing comment.
- Artwork fields reach the page through `innerHTML`. `script.js` escapes them
  (`esc`, `safeUrl`, `safeColor`) and all content is owner-authored today.
  Re-audit every `innerHTML` use before rendering anything a visitor typed.
- CSP `frame-ancestors` is ignored in a `<meta>` tag and GitHub Pages can't
  send headers, so `shared/frame-guard.js` is what stops framing on the pages
  that load it.
