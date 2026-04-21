const busboy       = require('busboy');
const { getStore } = require('@netlify/blobs');
const nodemailer   = require('nodemailer');

let _resolvedBucket = null;
async function resolveUploadsBucket() {
  if (_resolvedBucket) return _resolvedBucket;
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/bucket`,
      { headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (res.ok) {
      const buckets = await res.json();
      const match = buckets.map(b => b.name).find(n => n.toLowerCase() === 'uploads');
      _resolvedBucket = match || 'Uploads';
    } else {
      _resolvedBucket = 'Uploads';
    }
  } catch {
    _resolvedBucket = 'Uploads';
  }
  return _resolvedBucket;
}

async function signDownloadUrl(key, originalName) {
  const bucket = await resolveUploadsBucket();
  const signRes = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 7 }), // 7 days
    }
  );
  if (!signRes.ok) {
    const t = await signRes.text().catch(() => '');
    throw new Error(`Failed to sign download URL (${signRes.status}): ${t.slice(0, 200)}`);
  }
  const signData = await signRes.json();
  const signedURL = signData.signedURL || signData.signedUrl;  // handle both API versions
  const supabaseBase = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const signedPath = signedURL.startsWith('/storage/') ? signedURL : `/storage/v1${signedURL}`;
  const url = `${supabaseBase}${signedPath}&download=${encodeURIComponent(originalName || key.replace(/^\d+-[a-z0-9]+-/, ''))}`;
  return url;
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 1) return at === -1 ? '***' : `*${s.slice(at)}`;
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 3) return `${local[0]}**${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

/** Debug NDJSON ingest — never throw (fetch may be missing in some Lambda runtimes). */
function agentDebugIngest(payload) {
  try {
    if (typeof globalThis.fetch !== 'function') return;
    globalThis.fetch('http://127.0.0.1:7491/ingest/295b3c28-d93c-479c-9242-adf8186cfce4', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'cb1f49' },
      body: JSON.stringify({ sessionId: 'cb1f49', ...payload, timestamp: Date.now() }),
    }).catch(() => {});
  } catch (_) { /* ignore */ }
}

// ── Blob store helper ─────────────────────────────────────────────────────────
function blobStore(name) {
  const opts = { name };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

// ── Supabase file upload ──────────────────────────────────────────────────────
async function supabaseUpload(key, buffer, contentType) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/Uploads/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  contentType,
      'x-upsert':      'false',
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

// ── Multipart parser ──────────────────────────────────────────────────────────
function parseForm(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files  = [];
    let tooLarge = false;
    const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MiB hard limit to avoid function OOM

    const bb = busboy({ headers: event.headers, limits: { fileSize: MAX_FILE_BYTES, fieldSize: 4 * 1024 * 1024 } });

    bb.on('field', (name, value) => { fields[name] = value; });

    bb.on('file', (fieldName, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      let bytes = 0;
      stream.on('limit', () => {
        tooLarge = true;
        stream.resume();
      });
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        if (chunks.length > 0) {
          try { bytes = chunks.reduce((n, c) => n + c.length, 0); } catch { /* best-effort */ }
          files.push({ fieldName, buffer: Buffer.concat(chunks), fileName: filename, fileMime: mimeType, bytes });
        }
      });
    });

    bb.on('finish', () => {
      if (tooLarge) {
        const err = new Error(`File too large. Max allowed is ${MAX_FILE_BYTES} bytes.`);
        err.code = 'FILE_TOO_LARGE';
        err.maxBytes = MAX_FILE_BYTES;
        return reject(err);
      }
      resolve({ fields, files, maxFileBytes: MAX_FILE_BYTES });
    });
    bb.on('error',  reject);

    const rawBody = event.body;
    if (rawBody == null || rawBody === '') {
      const err = new Error('Empty request body');
      err.code = 'EMPTY_BODY';
      return reject(err);
    }
    const body = Buffer.from(rawBody, event.isBase64Encoded ? 'base64' : 'utf8');
    bb.write(body);
    bb.end();
  });
}

// ── File save ─────────────────────────────────────────────────────────────────
async function saveBlobFile(buffer, fileName, fileMime) {
  const key = `${Date.now()}-${fileName}`;
  await supabaseUpload(key, buffer, fileMime);
  return { key };
}

// ── SMTP transport ────────────────────────────────────────────────────────────
function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  console.log('[submit-quote] smtp-config', {
    host,
    port,
    secure: port === 465,
    user: user ? maskEmail(user) : null,
    hasPass: !!pass,
    deploy: {
      commitRef: process.env.COMMIT_REF || null,
      deployId: process.env.DEPLOY_ID || null,
      siteName: process.env.SITE_NAME || null,
      context: process.env.CONTEXT || null,
    },
  });

  if (!host || !user || !pass) {
    throw new Error(
      'SMTP not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in Netlify environment variables.'
    );
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,   // true for SSL (465), false for STARTTLS (587)
    auth: { user, pass },
  });
}

async function sendEmail(payload) {
  const transporter = createTransport();
  try {
    const info = await transporter.sendMail(payload);
    return info;
  } catch (err) {
    console.error('[submit-quote] sendMail failed', {
      code: err?.code,
      command: err?.command,
      responseCode: err?.responseCode,
      message: err?.message,
    });
    throw err;
  }
}

// ── HTML escape helper ────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Email builders ────────────────────────────────────────────────────────────
const TO   = process.env.EMAIL_TO   || 'sales@superior3dandlaser.com';
const FROM = process.env.EMAIL_FROM || 'Superior 3D and Laser <sales@superior3dandlaser.com>';
const SITE_URL = process.env.SITE_URL || 'https://superior3dandlaser.com';

/** Parse a decimal dollars string (e.g. from orderTotalRaw) to integer cents without float drift. */
function usdStringToCents(raw) {
  const t = String(raw ?? '')
    .trim()
    .replace(/\$/g, '')
    .replace(/,/g, '');
  if (!t) return 0;
  const sign = t.startsWith('-') ? -1 : 1;
  const u = t.replace(/^-/, '');
  const m = u.match(/^(\d*)(?:\.(\d{0,2}))?/);
  if (!m || (!m[1] && !m[2])) {
    const n = parseFloat(u.replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) return Math.round(n * 100 + 1e-8);
    return 0;
  }
  const dollars = parseInt(m[1] || '0', 10) || 0;
  let frac = m[2] || '';
  if (frac.length === 1) frac += '0';
  const cents = frac ? parseInt(frac.padEnd(2, '0').slice(0, 2), 10) || 0 : 0;
  const primary = sign * (dollars * 100 + cents);
  if (primary === 0 && t.replace(/\s/g, '').length > 0) {
    const n = parseFloat(u.replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) return Math.round(n * 100 + 1e-8);
  }
  return primary;
}

function buildContactEmail(fields) {
  const name = `${fields.firstName || ''} ${fields.lastName || ''}`.trim();
  return {
    subject: `New Contact Message — ${name}`,
    text: `
New Contact Message — Superior 3D and Laser
============================================
Name:     ${name}
Email:    ${fields.email    || ''}
Phone:    ${fields.phone    || 'Not provided'}
Service:  ${fields.service  || 'Not specified'}

Message:
${fields.message || ''}
============================================
    `.trim(),
    html: `
<h2 style="color:#b91c1c">New Contact Message</h2>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td><strong>Name</strong></td><td>${esc(name)}</td></tr>
  <tr><td><strong>Email</strong></td><td>${esc(fields.email || '')}</td></tr>
  <tr><td><strong>Phone</strong></td><td>${esc(fields.phone || 'Not provided')}</td></tr>
  <tr><td><strong>Service</strong></td><td>${esc(fields.service || 'Not specified')}</td></tr>
</table>
<h3>Message</h3>
<p style="white-space:pre-wrap">${esc(fields.message || '')}</p>
    `.trim(),
  };
}

function buildQuoteEmail(fields, fileName) {
  const name = `${fields.firstName || ''} ${fields.lastName || ''}`.trim();
  const fileUrl = fields.uploadedFileUrl || '';
  return {
    subject: `New Quote Request — ${name}`,
    text: `
New Quote Request — Superior 3D and Laser
==========================================
Name:        ${name}
Email:       ${fields.email    || ''}
Phone:       ${fields.phone    || 'Not provided'}
Service:     ${fields.service  || ''}
Quantity:    ${fields.quantity || 'Not provided'}
Timeline:    ${fields.timeline || 'Not provided'}
Material:    ${fields.material || 'Not provided'}

Project Description:
${fields.message || ''}

${fileUrl ? `Uploaded File: ${fileName || 'file'}\nDownload: ${fileUrl}` : (fileName ? `Uploaded File: ${fileName} (attached)` : 'No file attached.')}
==========================================
    `.trim(),
    html: `
<h2 style="color:#b91c1c">New Quote Request</h2>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td><strong>Name</strong></td><td>${esc(name)}</td></tr>
  <tr><td><strong>Email</strong></td><td>${esc(fields.email || '')}</td></tr>
  <tr><td><strong>Phone</strong></td><td>${esc(fields.phone || 'Not provided')}</td></tr>
  <tr><td><strong>Service</strong></td><td>${esc(fields.service || '')}</td></tr>
  <tr><td><strong>Quantity</strong></td><td>${esc(fields.quantity || 'Not provided')}</td></tr>
  <tr><td><strong>Timeline</strong></td><td>${esc(fields.timeline || 'Not provided')}</td></tr>
  <tr><td><strong>Material</strong></td><td>${esc(fields.material || 'Not provided')}</td></tr>
</table>
<h3>Project Description</h3>
<p style="white-space:pre-wrap">${esc(fields.message || '')}</p>
${fileUrl ? `<p><strong>File:</strong> <a href="${esc(fileUrl)}" target="_blank" rel="noreferrer noopener">${esc(fileName || 'Download file')}</a></p>` : (fileName ? `<p><strong>Attached:</strong> ${esc(fileName)}</p>` : '<p>No file attached.</p>')}
    `.trim(),
  };
}

function buildCartOrderEmail(fields, stlFiles) {
  const filesText = stlFiles.length
    ? `\n--- STL Files (${stlFiles.length}) ---\n${stlFiles.map(f => (
        f.downloadUrl ? `${f.fileName}\nDownload: ${f.downloadUrl}` : f.fileName
      )).join('\n\n')}`
    : '';

  return {
    subject: `New Order Request — ${fields.name || ''} — ${fields.orderTotal || ''}`.trim(),
    text: `
New Cart Order Request — Superior 3D and Laser
===============================================
Customer:  ${fields.name    || ''}
Email:     ${fields.email   || ''}
Phone:     ${fields.phone   || 'Not provided'}
Ship To:   ${fields.address || ''}

--- Order Items (${fields.itemCount || '?'} item(s)) ---
${fields.orderItems || ''}

--- Totals ---
Subtotal:    ${fields.subtotal   || ''}
Tax (8.5%):  ${fields.tax        || ''}
ORDER TOTAL: ${fields.orderTotal || ''}

--- Notes ---
${fields.orderNotes || 'None'}
${filesText}
Payment Status: ${fields.paymentStatus || 'Pending'}
${fields.paymentId ? `Payment ID: ${fields.paymentId}` : ''}
===============================================
    `.trim(),
    html: `
<h2 style="color:#b91c1c">New Cart Order</h2>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td><strong>Customer</strong></td><td>${esc(fields.name || '')}</td></tr>
  <tr><td><strong>Email</strong></td><td>${esc(fields.email || '')}</td></tr>
  <tr><td><strong>Phone</strong></td><td>${esc(fields.phone || 'Not provided')}</td></tr>
  <tr><td><strong>Ship To</strong></td><td>${esc(fields.address || '')}</td></tr>
</table>
<h3>Order Items</h3>
<pre style="background:#f8f8f8;padding:12px">${esc(fields.orderItems || '')}</pre>
<h3>Totals</h3>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td>Subtotal</td><td>${esc(fields.subtotal || '')}</td></tr>
  <tr><td>Tax (8.5%)</td><td>${esc(fields.tax || '')}</td></tr>
  <tr><td><strong>ORDER TOTAL</strong></td><td><strong>${esc(fields.orderTotal || '')}</strong></td></tr>
</table>
<p><strong>Payment Status:</strong> ${esc(fields.paymentStatus || 'Pending')}</p>
${fields.paymentId ? `<p><strong>Payment ID:</strong> ${esc(fields.paymentId)}</p>` : ''}
${stlFiles.length ? `
<h3>STL Files (${stlFiles.length})</h3>
<ul>${stlFiles.map(f => (
  f.downloadUrl
    ? `<li><a href="${esc(f.downloadUrl)}" target="_blank" rel="noreferrer noopener">${esc(f.fileName)}</a></li>`
    : `<li>${esc(f.fileName)} (attached)</li>`
)).join('')}</ul>` : ''}
    `.trim(),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const runtime = {
    commitRef: process.env.COMMIT_REF || null,
    deployId: process.env.DEPLOY_ID || null,
    context: process.env.CONTEXT || null,
    siteName: process.env.SITE_NAME || null,
  };

  console.log('[submit-quote] handler entry', {
    runtime,
    contentType: event.headers?.['content-type'] || event.headers?.['Content-Type'] || null,
    isBase64Encoded: !!event.isBase64Encoded,
    bodyBytes: event.body ? String(event.body).length : 0,
  });

  let stage = 'init';
  let debug = {
    formType: null,
    orderType: null,
    fieldsCount: 0,
    filesCount: 0,
    savedFilesCount: 0,
    attachmentsCount: 0,
  };

  if (event.body == null || event.body === '') {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Empty request body.',
        stage: 'parseForm',
        runtime,
      }),
    };
  }

  try {
    stage = 'parseForm';
    const { fields, files, maxFileBytes } = await parseForm(event);
    debug = {
      ...debug,
      formType: fields.formType || null,
      orderType: fields.orderType || null,
      fieldsCount: Object.keys(fields || {}).length,
      filesCount: Array.isArray(files) ? files.length : 0,
      maxFileBytes: maxFileBytes || null,
    };

    // If the browser uploaded directly to Supabase, we won't receive multipart file bytes here.
    // We only receive uploadedFileKey + uploadedFileName; generate a signed download URL to include in the email.
    if (fields.uploadedFileKey) {
      try {
        stage = 'signUploadedFile';
        const key = String(fields.uploadedFileKey);
        const originalName = String(fields.uploadedFileName || key.replace(/^\d+-[a-z0-9]+-/, ''));
        const url = await signDownloadUrl(key, originalName);
        fields.uploadedFileUrl = url;
      } catch (e) {
        console.error('[submit-quote] failed to sign uploaded file URL:', e?.message || String(e));
      }
    }

    // Save all uploaded files to Supabase
    const savedFiles = [];
    stage = 'saveFiles';
    for (const f of files) {
      try {
        const { key } = await saveBlobFile(f.buffer, f.fileName, f.fileMime);
        savedFiles.push({ fieldName: f.fieldName, fileName: f.fileName, key, buffer: f.buffer, fileMime: f.fileMime });
      } catch (blobErr) {
        console.error('[submit-quote] File save error for', f.fileName, ':', blobErr.message);
      }
    }
    debug.savedFilesCount = savedFiles.length;

    // Route to the correct email template
    stage = 'buildEmail';
    const formType = fields.formType || (fields.orderType === 'cart-order' ? 'cart' : 'quote');
    let mailBody;
    let attachments = [];
    let checkoutUrl = null;
    /** Populated when `debugStripe=85749a` on cart orders (no PII). */
    let responseDebugStripe = null;
    let isCartOrder = false;
    /** Populated when `debugSession=cb1f49` on cart orders (no PII). */
    let cartDebugCb1f49 = null;

    if (formType === 'contact') {
      mailBody = buildContactEmail(fields);

    } else if (formType === 'cart' || fields.orderType === 'cart-order') {
      isCartOrder = true;

      // The cart uploads STLs directly to Supabase via sign-upload (to bypass Netlify's
      // ~6MB function body limit). Those arrive here as `uploadedStlKeys` JSON. Older
      // clients may still attach STLs to the multipart body — we support both.
      let directStlList = [];
      try {
        const parsed = JSON.parse(fields.uploadedStlKeys || '[]');
        if (Array.isArray(parsed)) directStlList = parsed;
      } catch { /* ignore malformed list */ }

      const directStlFiles = await Promise.all(directStlList.map(async (u) => {
        let downloadUrl = null;
        try {
          downloadUrl = await signDownloadUrl(String(u.key), String(u.fileName || ''));
        } catch (e) {
          console.error('[submit-quote] Failed to sign STL download URL:', e?.message || String(e));
        }
        return { fileName: String(u.fileName || ''), key: String(u.key), downloadUrl };
      }));

      const multipartStlFiles = savedFiles.filter(f => f.fieldName.startsWith('stlFile'));
      const stlFiles = [...directStlFiles, ...multipartStlFiles];
      mailBody = buildCartOrderEmail(fields, stlFiles);

      // Only multipart-attached STLs have buffers available to attach to the email.
      // Direct-upload STLs are linked via signed download URL in the email body instead.
      attachments = multipartStlFiles.map(f => ({ filename: f.fileName, content: f.buffer }));
      debug.attachmentsCount = attachments.length;

      let orderId   = null;
      let parsedItems = [];
      try {
        stage = 'saveCartOrder';
        const orderStore = blobStore('orders');
        orderId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try { parsedItems = JSON.parse(fields.itemsJson || '[]'); } catch { /* best-effort */ }
        await orderStore.set(`order_${orderId}`, JSON.stringify({
          id:            orderId,
          customerName:  fields.name    || '',
          customerEmail: fields.email   || '',
          phone:         fields.phone   || '',
          address:       fields.address || '',
          notes:         fields.orderNotes || '',
          leadTime:      fields.leadTime   || 'Standard',
          items:         parsedItems,
          subtotal:      parseFloat(fields.subtotalRaw)   || 0,
          tax:           parseFloat(fields.taxRaw)        || 0,
          total:         parseFloat(fields.orderTotalRaw) || 0,
          stlFiles:      stlFiles.map(f => ({ fileName: f.fileName, blobKey: f.key })),
          status:        'pending',
          paymentStatus: 'unpaid',
          paidAt:        null,
          stripeSessionId: null,
          createdAt:     new Date().toISOString(),
        }));
      } catch (saveErr) {
        console.error('[submit-quote] Order save error:', saveErr.message);
      }

      // Create Stripe checkout session so customer can pay immediately
      // Single line item = exact order total (subtotal + lead-time + tax) — matches calculator checkout UI.
      let stripeCheckoutBranchForDebug = null;
      let stripeTotalCentsForDebug = null;
      let stripeSessionAmountTotalForDebug = null;
      if (orderId && process.env.STRIPE_SECRET_KEY) {
        try {
          stage = 'stripeCheckout';
          const { createStripeClient } = require('./stripe-client');
          const stripe = createStripeClient();
          let totalCents = usdStringToCents(fields.orderTotalRaw);
          if (!Number.isFinite(totalCents) || totalCents < 0) totalCents = 0;
          stripeTotalCentsForDebug = totalCents;

          // Build itemized line items so the Stripe Checkout page mirrors the calculator breakdown.
          // Each cart item uses item.lineTotal (= unitPrice×qty + printLabourFlat + colorSurcharge)
          // as the Stripe unit_amount (quantity=1). This matches the TOTAL column the customer
          // sees, avoids any mismatch caused by labour/color fields being absent on older cart
          // items, and keeps the reconciliation simple and reliable.
          const lineItems = [];
          let cartItems = [];
          try { cartItems = JSON.parse(fields.itemsJson || '[]'); } catch { cartItems = []; }
          if (!Array.isArray(cartItems)) cartItems = [];

          let subtotalCents = 0;
          for (const it of cartItems) {
            const qty = Math.max(1, parseInt(it.qty, 10) || 1);
            // lineTotal already incorporates unitPrice×qty + printLabourFlat + colorSurcharge.
            const lineTotalCents = Math.max(0, Math.round((Number(it.lineTotal) || 0) * 100));
            const baseName = (String(it.fileName || '').slice(0, 240)) || 'Custom print';
            // Append qty to name if >1 so the customer can see how many units are billed.
            const displayName = qty > 1 ? `${baseName} × ${qty}`.slice(0, 240) : baseName;
            const descParts = [it.material, it.infill ? `${it.infill} infill` : null, it.color]
              .filter(Boolean).map(String);
            const description = descParts.join(' · ').slice(0, 500) || undefined;

            if (lineTotalCents > 0) {
              lineItems.push({
                price_data: {
                  currency: 'usd',
                  product_data: description
                    ? { name: displayName, description }
                    : { name: displayName },
                  unit_amount: lineTotalCents,
                },
                quantity: 1,
              });
              subtotalCents += lineTotalCents;
            }
          }

          const ltSurchargeCents = Math.max(0, usdStringToCents(fields.ltSurchargeRaw));
          if (ltSurchargeCents > 0) {
            const ltLabel = String(fields.leadTime || 'Rush').slice(0, 200);
            lineItems.push({
              price_data: {
                currency: 'usd',
                product_data: { name: `Lead-time surcharge — ${ltLabel}`.slice(0, 240) },
                unit_amount: ltSurchargeCents,
              },
              quantity: 1,
            });
          }

          // Reconciled tax = customer-visible total minus everything billed so far.
          const preTaxCents = subtotalCents + ltSurchargeCents;
          let taxCents = totalCents - preTaxCents;
          if (taxCents < 0) taxCents = Math.max(0, usdStringToCents(fields.taxRaw));
          if (taxCents > 0) {
            lineItems.push({
              price_data: {
                currency: 'usd',
                product_data: { name: 'Sales Tax (8.5%)' },
                unit_amount: taxCents,
              },
              quantity: 1,
            });
          }

          // Safety: if itemsJson was empty/malformed or the sum doesn't match the customer's
          // total, fall back to a single lumped line item so Stripe still charges correctly.
          const lineItemsSumCents = lineItems.reduce(
            (s, li) => s + li.price_data.unit_amount * li.quantity, 0
          );
          if (lineItems.length === 0 || lineItemsSumCents !== totalCents) {
            if (lineItems.length > 0) {
              console.warn('[submit-quote] itemized line-item sum mismatch; using lumped line item', {
                lineItemsSumCents, totalCents, itemCount: cartItems.length,
              });
            }
            lineItems.length = 0;
            const productData = { name: 'Cart order — Superior 3D and Laser' };
            if (fields.itemCount) productData.description = `${String(fields.itemCount)} item(s)`;
            lineItems.push({
              price_data: {
                currency:     'usd',
                product_data: productData,
                unit_amount:  totalCents,
              },
              quantity: 1,
            });
          }

          if (totalCents < 50) {
            stripeCheckoutBranchForDebug = 'skipped_below_min';
            console.warn('[submit-quote] Stripe skipped: order total below minimum (50¢):', totalCents);
            if (fields.debugStripe === '85749a') {
              const { STRIPE_API_VERSION } = require('./stripe-client');
              responseDebugStripe = {
                totalCents,
                skip: 'below_min',
                apiVersion: STRIPE_API_VERSION,
                orderTotalRawLen: String(fields.orderTotalRaw || '').length,
              };
              // #region agent log
              agentDebugIngest({ runId: 'pre-fix', hypothesisId: 'H5', location: 'submit-quote.js:stripe:below_min', message: 'stripe skipped below min', data: { totalCents: totalCents } });
              // #endregion
            }
          } else {
            const sessionParamsBase = {
              payment_method_types: ['card'],
              line_items:     lineItems,
              mode:           'payment',
              success_url:    `${SITE_URL}/3dprintingquotecalculator.html?payment=success`,
              cancel_url:     `${SITE_URL}/3dprintingquotecalculator.html`,
              customer_email: fields.email || undefined,
              metadata:       { orderId },
            };
            // Session-level `branding_settings` are intentionally omitted so the
            // Stripe Dashboard branding settings (Test and Live each configured
            // separately) are the single source of truth for logo/colors/name.
            // That eliminates intermittent unbranded Checkout pages caused by
            // transient session-branding failures.
            const customTextPayload = {
              submit: {
                message: 'You are paying Superior 3D and Laser for your custom 3D print order.',
              },
            };
            let session;
            let checkoutBranch = null;
            try {
              session = await stripe.checkout.sessions.create({
                ...sessionParamsBase,
                custom_text: customTextPayload,
              });
              checkoutBranch = 'custom_text';
            } catch (e1) {
              console.warn('[submit-quote] Checkout with custom_text failed, retrying base:', e1.message);
              // #region agent log
              agentDebugIngest({ runId: 'post-fix', hypothesisId: 'B1', location: 'submit-quote.js:stripe:e1', message: 'checkout create failed (custom_text)', data: { code: e1.code || null, type: e1.type || null } });
              // #endregion
              session = await stripe.checkout.sessions.create(sessionParamsBase);
              checkoutBranch = 'base';
            }
            checkoutUrl = session && session.url ? session.url : checkoutUrl;
            if (session) {
              stripeCheckoutBranchForDebug = checkoutBranch;
              stripeSessionAmountTotalForDebug = session.amount_total != null ? session.amount_total : null;
            }

            if (fields.debugStripe === '85749a') {
              const { STRIPE_API_VERSION } = require('./stripe-client');
              responseDebugStripe = {
                totalCents,
                checkoutBranch,
                apiVersion: STRIPE_API_VERSION,
                orderTotalRawLen: String(fields.orderTotalRaw || '').length,
                siteUrlLen: String(SITE_URL || '').length,
                brandingStrategy: 'colors_first_then_logo',
              };
              // #region agent log
              agentDebugIngest({ runId: 'pre-fix', hypothesisId: 'H2', location: 'submit-quote.js:stripe:success', message: 'cart checkout session created', data: { totalCents: totalCents, checkoutBranch: checkoutBranch, apiVersion: STRIPE_API_VERSION } });
              // #endregion
            }

            // Persist session ID on the saved order
            if (session && session.id) {
              try {
                const os       = blobStore('orders');
                const existing = JSON.parse(await os.get(`order_${orderId}`) || '{}');
                existing.stripeSessionId = session.id;
                await os.set(`order_${orderId}`, JSON.stringify(existing));
              } catch (patchErr) {
                console.error('[submit-quote] stripeSessionId patch error:', patchErr.message);
              }
            }
          }
        } catch (stripeErr) {
          stripeCheckoutBranchForDebug = stripeCheckoutBranchForDebug || 'stripe_outer_error';
          console.error('[submit-quote] Stripe error:', stripeErr.message);
          if (fields.debugStripe === '85749a') {
            responseDebugStripe = {
              stripeError: true,
              errCode: stripeErr.code || null,
              errType: stripeErr.type || null,
            };
            // #region agent log
            agentDebugIngest({ runId: 'pre-fix', hypothesisId: 'H5', location: 'submit-quote.js:stripe:catch', message: 'stripe outer catch', data: { code: stripeErr.code || null, type: stripeErr.type || null } });
            // #endregion
          }
        }
      }

      if (fields.debugSession === 'cb1f49' && isCartOrder) {
        const { STRIPE_API_VERSION } = require('./stripe-client');
        const centsDbg =
          stripeTotalCentsForDebug != null
            ? stripeTotalCentsForDebug
            : usdStringToCents(fields.orderTotalRaw);
        cartDebugCb1f49 = {
          hypothesisIds: ['P1', 'P3', 'T1', 'T2'],
          orderTotalRaw: String(fields.orderTotalRaw || ''),
          subtotalRaw: String(fields.subtotalRaw || ''),
          taxRaw: String(fields.taxRaw || ''),
          totalCentsParsed: centsDbg,
          checkoutBranch: stripeCheckoutBranchForDebug,
          stripeSessionAmountTotal: stripeSessionAmountTotalForDebug,
          hadStripeKey: !!process.env.STRIPE_SECRET_KEY,
          apiVersion: STRIPE_API_VERSION,
        };
        // #region agent log
        agentDebugIngest({
          runId: 'pre-fix',
          hypothesisId: 'P1',
          location: 'submit-quote.js:cart:debugCb1f49',
          message: 'cart checkout debug snapshot',
          data: cartDebugCb1f49,
        });
        // #endregion
      }

    } else {
      const primary  = savedFiles.find(f => f.fieldName === 'file') || savedFiles[0];
      const fileName = primary?.fileName || null;
      mailBody = buildQuoteEmail(fields, fileName || fields.uploadedFileName || null);

      if (primary?.buffer) {
        attachments = [{ filename: primary.fileName, content: primary.buffer }];
        debug.attachmentsCount = attachments.length;
      }

      if (primary?.key) {
        try {
          stage = 'saveQuoteOrder';
          const orderStore = blobStore('orders');
          const orderId    = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await orderStore.set(`order_${orderId}`, JSON.stringify({
            id:            orderId,
            customerName:  `${fields.firstName || ''} ${fields.lastName || ''}`.trim(),
            customerEmail: fields.email   || '',
            phone:         fields.phone   || '',
            notes:         fields.message || '',
            items: [{
              projectName: fileName || 'Quote Request',
              material:    fields.material || '',
              qty:         parseInt(fields.quantity) || 1,
              lineTotal:   0,
            }],
            subtotal:  0,
            tax:       0,
            total:     0,
            stlFiles:  [{ fileName: primary.fileName, blobKey: primary.key }],
            status:    'pending',
            source:    'quote',
            createdAt: new Date().toISOString(),
          }));
        } catch (saveErr) {
          console.error('[submit-quote] Quote order save error:', saveErr.message);
        }
      }
    }

    stage = 'sendEmail';
    const emailOpts = {
      from:    FROM,
      to:      TO,
      replyTo: fields.email || undefined,
      ...mailBody,
      ...(attachments.length ? { attachments } : {}),
    };
    if (isCartOrder) {
      // Admin notification is best-effort — SMTP failures must not block customer flow
      sendEmail(emailOpts).catch(emailErr =>
        console.error('[submit-quote] Cart email error (non-blocking):', emailErr.message)
      );
    } else {
      await sendEmail(emailOpts);
    }

    const okBody = { success: true, checkoutUrl, runtime };
    if (responseDebugStripe) okBody.debugStripe = responseDebugStripe;
    if (cartDebugCb1f49) okBody.debugCb1f49 = cartDebugCb1f49;
    return { statusCode: 200, body: JSON.stringify(okBody) };

  } catch (err) {
    console.error('submit-quote error:', {
      stage,
      message: err?.message,
      code: err?.code,
      command: err?.command,
      responseCode: err?.responseCode,
      runtime,
      smtpUser: process.env.SMTP_USER ? maskEmail(process.env.SMTP_USER) : null,
    });

    if (err?.code === 'FILE_TOO_LARGE') {
      return {
        statusCode: 413,
        body: JSON.stringify({
          error: 'File too large.',
          stage,
          maxBytes: err.maxBytes || null,
          runtime,
        }),
      };
    }
    if (err?.code === 'EMPTY_BODY') {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Empty request body.',
          stage: 'parseForm',
          runtime,
        }),
      };
    }
    let body500;
    try {
      body500 = JSON.stringify({
        error: 'Submission failed. Please try again.',
        stage,
        detail: err?.message || String(err),
        runtime,
        debug,
        nodemailer: err && (err.code || err.command || err.responseCode || err.response) ? {
          code: err.code,
          command: err.command,
          responseCode: err.responseCode,
          response: typeof err.response === 'string' ? err.response.slice(0, 300) : undefined,
        } : undefined,
      });
    } catch {
      body500 = JSON.stringify({ error: 'Submission failed. Please try again.', stage });
    }
    return { statusCode: 500, body: body500 };
  }
};
