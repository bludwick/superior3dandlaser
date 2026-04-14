# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deployment

This is a static HTML/CSS/JS site hosted on Netlify with GitHub auto-deploy. Pushing to `main` triggers an automatic deployment — no manual deploy step needed.

```bash
git add <files>
git commit -m "description"
git push
```

Netlify runs `npm install` on each deploy (to bundle the serverless function dependencies). There is no build step for the static HTML/CSS files.

## Architecture

### Static Pages

All public-facing pages share `styles.css`. No framework, no bundler — edit HTML/CSS directly.

| Page | Purpose | Form destination |
|------|---------|-----------------|
| `index.html` | Homepage with services overview, materials band, stats | — |
| `services.html` | Full service details + process steps | — |
| `customquote.html` | "Get a Quote" — full form with file upload | `/.netlify/functions/submit-quote` |
| `contact-us.html` | General contact — simplified form, no file upload | `/.netlify/functions/submit-quote` |
| `3dprintingquotecalculator.html` | Interactive pricing calculator (estimate only, no form submit) | — |
| `invoice.html` | Public invoice view; customers pay via Stripe from here | — |

`3dprintingquotecalculator.html` uses self-contained inline CSS with its own `:root` variables — it does **not** share `styles.css`. Keep changes to this page self-contained.

### Admin Dashboard

Protected admin interface living in the `admin/` directory:

| File | Purpose |
|------|---------|
| `admin/login.html` | Login portal with rate-limited auth |
| `admin/index.html` | Full dashboard (orders, print jobs, pricing, materials) |

The `/admin/*` route is protected by a Netlify Edge Function (`netlify/edge-functions/admin-auth.js`) that validates a JWT cookie before any page is served. `/admin/login*` is the only exempt path.

### Serverless Functions

All functions live in `netlify/functions/`. API routes are aliased in `netlify.toml`.

| Function | Route | Purpose |
|----------|-------|---------|
| `submit-quote.js` | `/.netlify/functions/submit-quote` | Handles quote, contact, and cart order submissions |
| `admin-login.js` | `/api/admin/login` | Authenticates admin; issues JWT cookie |
| `admin-logout.js` | `/api/admin/logout` | Clears JWT cookie |
| `list-orders.js` | `/api/admin/orders` | Lists orders; updates status; attaches files; bulk delete |
| `manage-jobs.js` | `/api/admin/jobs` | Full CRUD for print jobs + Stripe checkout creation |
| `manage-materials.js` | `/api/materials` (GET public), `/api/admin/materials` (PUT admin) | Reads/writes materials library from Blobs |
| `manage-settings.js` | `/api/settings` (GET public), `/api/admin/settings` (PUT admin) | Reads/writes pricing settings from Blobs |
| `get-invoice.js` | `/api/invoice` | Public job lookup by ID + invoice token |
| `create-checkout.js` | `/api/checkout` | Creates Stripe payment session for an invoice |
| `calculate-tax.js` | `/api/calculate-tax` | Calculates sales tax via Stripe Tax API |
| `upload-file.js` | `/api/admin/upload` | Admin multipart file upload to Supabase |
| `download-file.js` | `/api/admin/files` (GET), `/api/admin/upload` (POST signed URL) | Generates signed Supabase download URLs; creates signed upload URLs for admin browser uploads |
| `sign-upload.js` | `/api/sign-upload` | Public endpoint — returns a signed Supabase upload URL so browsers can upload quote files directly (no server proxy) |

### Edge Function

`netlify/edge-functions/admin-auth.js` runs on Deno (no npm deps). It validates the `admin_token` JWT cookie using the Web Crypto API (HS256) and redirects unauthenticated requests to `/admin/login.html`.

### Data Persistence (Netlify Blobs)

| Store name | Contents |
|-----------|----------|
| `admin-auth` | Rate-limit counters for admin login attempts (per IP) |
| `orders` | Submitted quote/cart orders |
| `jobs` | Admin-managed print jobs |
| `materials` | Materials library JSON (key: `materials-library`) |
| `settings` | Pricing settings JSON (key: `pricing-settings`) |

The `uploads` Blob store is no longer used for file data — files are stored in Supabase (see below). Jobs and orders are mirrored: creating/updating/deleting a job also updates the corresponding entry in the `orders` store.

### File Storage (Supabase)

User-uploaded files (quote attachments, admin uploads) are stored in a Supabase Storage bucket named `Uploads` (capital U — the bucket name is case-sensitive).

**Upload flow for quote forms:**
1. Browser calls `POST /api/sign-upload` with `{ fileName, contentType }` — gets back a signed Supabase upload URL.
2. Browser uploads the file directly to Supabase using the signed URL.
3. Browser submits the form to `/.netlify/functions/submit-quote` with the Supabase file path (not the file itself).

**Upload flow for admin:**
1. Admin dashboard calls `POST /api/admin/upload` (multipart form) → `upload-file.js` uploads to Supabase and returns `{ blobKey, fileName }`.
2. Alternatively, admin calls `POST /api/admin/files` → `download-file.js` returns a signed Supabase upload URL for direct browser upload.

**Download:** `GET /api/admin/files?key={blobKey}` returns a 5-minute signed URL. All downloads go through Supabase to avoid Netlify's 6 MB response limit.

Accepted extensions for uploads (enforced in `sign-upload.js`): `.step`, `.stp`, `.f3d`, `.sldprt`, `.stl`, `.pdf`, `.dxf`, `.svg`, `.ai`

### Email

Email is sent via **nodemailer** over SMTP (Microsoft 365 / GoDaddy). Resend has been removed — do not re-introduce it.

Three email template types exist in `submit-quote.js`:
- **contact** — simple message from `contact-us.html`
- **quote** — quote request with project details and optional file attachment
- **cart** — cart order summary with items, totals, and payment status

Each template sends both plain-text and HTML variants. Outbound address: `sales@superior3dandlaser.com`

### Payment

Stripe integration spans `manage-jobs.js`, `create-checkout.js`, and `calculate-tax.js`.

- When a job is created from the admin dashboard, a Stripe checkout session can be created automatically (if `STRIPE_SECRET_KEY` is set).
- Customers receive an invoice URL (`/invoice.html?job=…&token=…`) that links to `invoice.html` for viewing and paying.
- `calculate-tax.js` calls the Stripe Tax Calculations API. It returns `{ taxAmount, taxRate, label }` (e.g. "TX Sales Tax (8.25%)"). The frontend falls back to a static rate if Stripe is not configured.

---

## Environment Variables

Set in Netlify's dashboard — never committed to the repo. `.env` is gitignored and used only as a local reference.

| Variable | Required | Purpose |
|----------|----------|---------|
| `ADMIN_EMAIL` | Yes | Admin login email address |
| `ADMIN_PASSWORD_HASH` | Preferred | bcrypt hash of admin password (cost factor 12) |
| `ADMIN_PASSWORD` | Fallback | Plain-text admin password (use only if hash not set) |
| `JWT_SECRET` | Yes | Secret for signing/verifying admin JWT tokens |
| `SMTP_HOST` | Yes | SMTP server hostname — `smtp.office365.com` (Microsoft 365 / GoDaddy) |
| `SMTP_PORT` | Yes | SMTP port — `587` (STARTTLS) |
| `SMTP_USER` | Yes | SMTP login — `sales@superior3dandlaser.com` |
| `SMTP_PASS` | Yes | SMTP password for the above account |
| `EMAIL_FROM` | Optional | Sender display name/address — defaults to `Superior 3D and Laser <sales@superior3dandlaser.com>` |
| `EMAIL_TO` | Optional | Recipient for all form submissions — defaults to `sales@superior3dandlaser.com` |
| `STRIPE_SECRET_KEY` | Optional | Enables Stripe checkout session creation and tax calculation |
| `SITE_URL` | Yes | `https://superior3dandlaser.com` — used to build invoice and file download URLs |
| `SUPABASE_URL` | Yes | Supabase project URL — used for file storage |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key — used server-side for file storage (bypasses RLS; never expose to client) |

To generate a bcrypt password hash: `node scripts/gen-password-hash.js`

---

## Navigation Convention

Active services (FDM 3D Printing, Design Assistance) link to `customquote.html`. Coming Soon services (Resin, Laser Cutting, Laser Engraving) link to `contact-us.html` with a "Notify Me When Available" CTA.

Coming Soon sections use `style="opacity:.65"` on their `<section>` element.

---

## CSS Theme

All colors use CSS custom properties defined at the top of `styles.css`. Current theme: light mode with dark red accent.

| Variable | Value | Usage |
|----------|-------|-------|
| `--bg` | `#ffffff` | Page background |
| `--bg-card` | `#f8f8f8` | Card backgrounds |
| `--bg-light` | `#f1f1f1` | Light section backgrounds |
| `--accent` | `#b91c1c` | Primary accent (red) |
| `--accent-lt` | `#dc2626` | Lighter accent variant |
| `--text` | `#111111` | Body text |
| `--muted` | `#555555` | Secondary text |
| `--border` | `#e0e0e0` | Borders |

Material tags on the homepage use `data-tooltip` attributes and a CSS `::after` pseudo-element for hover tooltips — no JavaScript involved.

Responsive breakpoints: `900px` (multi-column → single column), `768px` (mobile nav, form stacking).

---

## Accepted File Formats

Both the quote form UI and the "Send Your Files" process step should consistently list: **STEP, F3D, SLDPRT, STL, PDF, DXF, SVG, AI**

File input `accept` attribute: `.step,.stp,.f3d,.sldprt,.stl,.pdf,.dxf,.svg,.ai`

---

## Admin Auth Flow

1. `admin/login.html` POSTs credentials to `/api/admin/login`
2. `admin-login.js` rate-limits by IP (5 attempts / 15 min via Blobs `admin-auth` store), verifies bcrypt hash, issues a signed JWT (8-hour expiry) as an `HttpOnly` cookie
3. `admin-auth.js` (edge function) intercepts every `/admin/*` request, verifies the cookie JWT, redirects to login if invalid
4. Dashboard pages call `/api/admin/*` endpoints; each function independently re-validates the JWT cookie

---

## Print Job Lifecycle

Jobs managed via the admin dashboard follow this status progression:

```
confirmed → printing → ready → complete
```

When status advances to `ready`, an email is sent to the customer. Stripe checkout sessions are optionally created at job creation time.

---

## Key Conventions

- **No framework, no bundler** for the public site. Vanilla HTML/CSS/JS only.
- **Inline JS** for form validation and submission in `customquote.html` and `contact-us.html` — keep it inline, not in separate script files.
- **Admin dashboard JS/CSS is inline** in `admin/index.html` — same rule applies.
- **Do not add `styles.css` imports** to `3dprintingquotecalculator.html` or `admin/` pages; they are intentionally self-contained.
- **bcryptjs not bcrypt** — `bcryptjs` is the pure-JS implementation used here (no native addon required on Netlify).
- **Blobs not a database** — Netlify Blobs is used for all persistence. There is no SQL database.
- **Supabase for files** — all file uploads (quote attachments and admin uploads) go to Supabase Storage, not Netlify Blobs.
- **nodemailer SMTP** — email is sent via `nodemailer` using Microsoft 365 / GoDaddy SMTP. Do not re-introduce Resend or any other third-party email API.
- **Supabase bucket name is case-sensitive** — the bucket is `Uploads` (capital U). `download-file.js` contains a resolver that handles both `uploads` and `Uploads` to account for this.
