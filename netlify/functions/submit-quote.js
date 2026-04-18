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
  if (!m || (!m[1] && !m[2])) return 0;
  const dollars = parseInt(m[1] || '0', 10) || 0;
  let frac = m[2] || '';
  if (frac.length === 1) frac += '0';
  const cents = frac ? parseInt(frac.padEnd(2, '0').slice(0, 2), 10) || 0 : 0;
  return sign * (dollars * 100 + cents);
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
    ? `\n--- Attached STL Files (${stlFiles.length}) ---\n${stlFiles.map(f => f.fileName).join('\n')}`
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
    let isCartOrder = false;

    if (formType === 'contact') {
      mailBody = buildContactEmail(fields);

    } else if (formType === 'cart' || fields.orderType === 'cart-order') {
      isCartOrder = true;
      const stlFiles = savedFiles.filter(f => f.fieldName.startsWith('stlFile'));
      mailBody = buildCartOrderEmail(fields, stlFiles);

      attachments = stlFiles.map(f => ({ filename: f.fileName, content: f.buffer }));
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
      if (orderId && process.env.STRIPE_SECRET_KEY) {
        try {
          stage = 'stripeCheckout';
          const { createStripeClient } = require('./stripe-client');
          const stripe = createStripeClient();
          const totalCents = usdStringToCents(fields.orderTotalRaw);
          const productData   = { name: 'Cart order — Superior 3D and Laser' };
          if (fields.itemCount) {
            productData.description = `${String(fields.itemCount)} item(s)`;
          }
          const lineItems = [{
            price_data: {
              currency:     'usd',
              product_data: productData,
              unit_amount:  totalCents,
            },
            quantity: 1,
          }];

          if (totalCents < 50) {
            console.warn('[submit-quote] Stripe skipped: order total below minimum (50¢):', totalCents);
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
            const checkoutCustomText = {
              submit: {
                message: 'You are paying Superior 3D and Laser for your custom 3D print order.',
              },
            };
            const siteBase = String(SITE_URL).replace(/\/$/, '');
            const brandColors = {
              display_name:     'Superior 3D and Laser',
              background_color: '#ffffff',
              button_color:     '#b91c1c',
              border_style:     'rounded',
            };
            // Hosted Checkout appearance: API branding_settings (falls back if account/API rejects a part).
            let session;
            try {
              session = await stripe.checkout.sessions.create({
                ...sessionParamsBase,
                custom_text:       { submit: checkoutCustomText.submit },
                branding_settings: {
                  ...brandColors,
                  logo: { type: 'url', url: `${siteBase}/3dprint-icon.svg` },
                },
              });
            } catch (e1) {
              console.warn('[submit-quote] Checkout with logo branding failed, retrying colors only:', e1.message);
              try {
                session = await stripe.checkout.sessions.create({
                  ...sessionParamsBase,
                  custom_text:       { submit: checkoutCustomText.submit },
                  branding_settings: brandColors,
                });
              } catch (e2) {
                console.warn('[submit-quote] Checkout with branding failed, retrying custom_text only:', e2.message);
                try {
                  session = await stripe.checkout.sessions.create({
                    ...sessionParamsBase,
                    custom_text: { submit: checkoutCustomText.submit },
                  });
                } catch (e3) {
                  console.warn('[submit-quote] Checkout with custom_text failed, retrying base:', e3.message);
                  session = await stripe.checkout.sessions.create(sessionParamsBase);
                }
              }
            }
            checkoutUrl = session.url;

            // Persist session ID on the saved order
            try {
              const os       = blobStore('orders');
              const existing = JSON.parse(await os.get(`order_${orderId}`) || '{}');
              existing.stripeSessionId = session.id;
              await os.set(`order_${orderId}`, JSON.stringify(existing));
            } catch (patchErr) {
              console.error('[submit-quote] stripeSessionId patch error:', patchErr.message);
            }
          }
        } catch (stripeErr) {
          console.error('[submit-quote] Stripe error:', stripeErr.message);
        }
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

    return { statusCode: 200, body: JSON.stringify({ success: true, checkoutUrl, runtime }) };

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
