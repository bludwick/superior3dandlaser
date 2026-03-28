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

**Static pages** (`index.html`, `services.html`, `contact.html`, `contact-us.html`) share a single `styles.css`. No framework, no bundler — edit HTML/CSS directly.

**Serverless function** (`netlify/functions/submit-quote.js`) handles both the "Get a Quote" form (`contact.html`) and the "Contact" form (`contact-us.html`). It:
1. Parses multipart form data with `busboy`
2. Saves any uploaded file to Netlify Blobs (store name: `uploads`)
3. Sends an email via Microsoft 365 SMTP (`smtp.office365.com:587`) using `nodemailer`

The function requires two env vars set in Netlify's dashboard (not in the repo):
- `SMTP_USER` — M365 email address
- `SMTP_PASS` — M365 password or app password
- `SITE_URL` — `https://superior3dandlaser.com` (used to build blob download URLs)

**`.env`** is gitignored and only used as a local reference template — it is not loaded automatically.

## Page Structure

| Page | Purpose | Form destination |
|------|---------|-----------------|
| `index.html` | Homepage | — |
| `services.html` | Full service details + process steps | — |
| `contact.html` | "Get a Quote" — full form with file upload | `/.netlify/functions/submit-quote` |
| `contact-us.html` | General contact — simplified form, no file upload | `/.netlify/functions/submit-quote` |
| `3dprintingquotecalculator.html` | Interactive pricing calculator (estimate only, no form submit) | — |

`3dprintingquotecalculator.html` uses self-contained inline CSS with its own `:root` variables — it does **not** share `styles.css`. Keep changes to this page self-contained.

## Navigation Convention

Active services (FDM 3D Printing, Design Assistance) link to `contact.html`. Coming Soon services (Resin, Laser Cutting, Laser Engraving) link to `contact-us.html` with a "Notify Me When Available" CTA.

Coming Soon sections use `style="opacity:.65"` on their `<section>` element.

## CSS Theme

All colors use CSS custom properties defined at the top of `styles.css`. Current theme is light mode with dark red accent (`--accent: #b91c1c`). Key variables: `--bg`, `--bg-card`, `--bg-light`, `--text`, `--muted`, `--border`, `--accent`.

Material tags on the homepage use `data-tooltip` attributes and a CSS `::after` pseudo-element for hover tooltips — no JavaScript involved.

## Accepted File Formats

Both the quote form UI and the "Send Your Files" process step should consistently list: **STEP, F3D, SLDPRT, STL, PDF, DXF, SVG, AI**

The file input `accept` attribute: `.step,.stp,.f3d,.sldprt,.stl,.pdf,.dxf,.svg,.ai`
