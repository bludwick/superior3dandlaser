const busboy       = require('busboy');
const { getStore } = require('@netlify/blobs');
const nodemailer   = require('nodemailer');

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

    const bb = busboy({ headers: event.headers });

    bb.on('field', (name, value) => { fields[name] = value; });

    bb.on('file', (fieldName, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        if (chunks.length > 0) {
          files.push({ fieldName, buffer: Buffer.concat(chunks), fileName: filename, fileMime: mimeType });
        }
      });
    });

    bb.on('finish', () => resolve({ fields, files }));
    bb.on('error',  reject);

    const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
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
  const info = await transporter.sendMail(payload);
  return info;
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

${fileName ? `Uploaded File: ${fileName} (attached)` : 'No file attached.'}
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
${fileName ? `<p><strong>Attached:</strong> ${esc(fileName)}</p>` : '<p>No file attached.</p>'}
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

  try {
    const { fields, files } = await parseForm(event);

    // Save all uploaded files to Supabase
    const savedFiles = [];
    for (const f of files) {
      try {
        const { key } = await saveBlobFile(f.buffer, f.fileName, f.fileMime);
        savedFiles.push({ fieldName: f.fieldName, fileName: f.fileName, key, buffer: f.buffer, fileMime: f.fileMime });
      } catch (blobErr) {
        console.error('[submit-quote] File save error for', f.fileName, ':', blobErr.message);
      }
    }

    // Route to the correct email template
    const formType = fields.formType || (fields.orderType === 'cart-order' ? 'cart' : 'quote');
    let mailBody;
    let attachments = [];

    if (formType === 'contact') {
      mailBody = buildContactEmail(fields);

    } else if (formType === 'cart' || fields.orderType === 'cart-order') {
      const stlFiles = savedFiles.filter(f => f.fieldName.startsWith('stlFile'));
      mailBody = buildCartOrderEmail(fields, stlFiles);

      attachments = stlFiles.map(f => ({ filename: f.fileName, content: f.buffer }));

      try {
        const orderStore = blobStore('orders');
        const orderId    = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let parsedItems  = [];
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
          createdAt:     new Date().toISOString(),
        }));
      } catch (saveErr) {
        console.error('[submit-quote] Order save error:', saveErr.message);
      }

    } else {
      const primary  = savedFiles.find(f => f.fieldName === 'file') || savedFiles[0];
      const fileName = primary?.fileName || null;
      mailBody = buildQuoteEmail(fields, fileName);

      if (primary?.buffer) {
        attachments = [{ filename: primary.fileName, content: primary.buffer }];
      }

      if (primary?.key) {
        try {
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

    await sendEmail({
      from:     FROM,
      to:       TO,
      replyTo:  fields.email || undefined,
      ...mailBody,
      ...(attachments.length ? { attachments } : {}),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('submit-quote error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Submission failed. Please try again.', detail: err.message }),
    };
  }
};
