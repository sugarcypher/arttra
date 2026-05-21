# Security

arttra.art is a static site served from GitHub Pages off the `main` branch of
`github.com/sugarcypher/arttra`. There is no application server in this repo —
the attack surface is the GitHub account, the repo, the Actions pipeline, and
the static assets. This file is the hardening checklist for that surface.

## Reporting a vulnerability

Email the repo owner. Do not open a public issue for security problems.

## Account & repo settings (do these in the GitHub web UI)

These are not enforceable from code — they must be set on the account/repo.

- [ ] **Enable 2FA on the `sugarcypher` account.** Currently OFF. This is the
      single highest-impact action here: the whole site can be replaced by
      anyone who phishes or reuses this password. Use an authenticator app or
      hardware key, not SMS. Settings → Password and authentication.
- [ ] **Branch protection on `main`.** Settings → Branches → add rule for
      `main`: require pull requests, block force-push from humans, do not allow
      deletions. Note: the build workflow force-pushes to `main` as `arttra-bot`
      — keep the protection rule compatible (allow the Actions token, or have
      the workflow commit normally instead of `--force`).
- [ ] **Restrict who can push.** Keep collaborators to the minimum. Review
      Settings → Collaborators periodically.
- [ ] **Enforce HTTPS on Pages.** Settings → Pages → "Enforce HTTPS" checked.
- [ ] **Verify the custom domain.** Settings → Pages → verify `arttra.art` so a
      lapsed/misconfigured DNS record cannot be claimed by someone else
      (subdomain/domain takeover).
- [ ] **Enable Dependabot alerts.** Settings → Code security → Dependabot
      alerts + security updates. The Python pipeline pulls Pillow / vtracer /
      opencv at build time.
- [ ] **Limit Actions permissions.** Settings → Actions → General → set
      "Workflow permissions" no broader than needed; the build only needs
      `contents: write` (already scoped in `build.yml`).

## Pipeline supply chain (in this repo)

- [x] **Pin third-party Actions to a commit SHA, not a tag.** Tags are mutable;
      a compromised upstream can repoint `v4` to malicious code. `build.yml`
      pins `actions/checkout` and `actions/setup-python` to full SHAs with the
      version in a trailing comment. When bumping, update both.
- [ ] **Pin Python build dependencies.** `build.yml` currently installs
      `Pillow vtracer opencv-python-headless` unpinned. Consider pinning to
      known-good versions (or a `requirements.txt` with hashes) so a malicious
      release cannot enter the build.

## Static assets & admin page

- [x] **`admin.html` is `noindex,nofollow,noarchive`** and disallowed in
      `robots.txt` so it stays out of search results. This is obscurity, not
      access control — see below.
- [ ] **`admin.html` is not access-controlled by GitHub Pages.** The page is
      world-readable; its client-side password "lock" is cosmetic. Real
      protection must come from the backend that `admin.js` calls (the
      `x-admin-password` header check). Keep that backend the source of truth;
      never put a usable secret in `admin.js` or any committed file.
- [ ] **Before adding any user-generated content**, fix the unescaped string
      interpolation in `script.js` (artwork fields are injected into the DOM
      without escaping). Safe today because all content is owner-authored; it
      becomes a stored-XSS vector the moment third-party input is rendered.

## Secrets

- No secrets belong in this repo. The `uploadUrl` in `admin.js` is currently
  unset (`"#"`). When the upload backend and the future Stripe/Printful
  integration land, their keys live in the serverless platform's secret store
  (Cloudflare Workers secrets), never in committed files.
