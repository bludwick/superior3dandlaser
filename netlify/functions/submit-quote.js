const busboy           = require('busboy');
const { getStore }     = require('@netlify/blobs');
const { Resend }       = require('resend');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

function blobStore(name) {
  const opts = { name };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

// Parse multipart form data — returns all files as an array
function parseForm(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files  = []; // [{ fieldName, buffer, fileName, fileMime }]

    const bb = busboy({ headers: event.headers });

    bb.on('field', (name, value) => { fields[name] = value; });

    bb.on('file', (fieldName, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        if (chunks.length > 0) {
          files.push({
            fieldName,
            buffer:   Buffer.concat(chunks),
            fileName: filename,
            fileMime: mimeType,
          });
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

// Save a file buffer to the Supabase 'Uploads' storage bucket
async function saveBlobFile(buffer, fileName, fileMime) {
  const supabase = getSupabase();
  const path     = `${Date.now()}-${fileName}`;
  const { error } = await supabase.storage
    .from('Uploads')
    .upload(path, buffer, { contentType: fileMime, upsert: false });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  return { key: path };
}

// ── Resend email sender ───────────────────────────────────────────────────────
async function sendEmail(payload) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend: ${error.message} (${error.name})`);
  return data;
}

// ── Email builders ────────────────────────────────────────────────────────────

function buildContactEmail(fields) {
  return {
    to:      ['sales@superior3dandlaser.com'],
    subject: `New Contact Message — ${fields.firstName || ''} ${fields.lastName || ''}`.trim(),
    text: `
New Contact Message — Superior 3D and Laser
============================================

Name:     ${fields.firstName || ''} ${fields.lastName || ''}
Email:    ${fields.email    || ''}
Phone:    ${fields.phone    || 'Not provided'}
Service:  ${fields.service  || 'Not specified'}

Message:
${fields.message || ''}

============================================
    `.trim(),
  };
}

function buildQuoteEmail(fields, fileName) {
  return {
    to:      ['sales@superior3dandlaser.com'],
    subject: `New Quote Request — ${fields.firstName || ''} ${fields.lastName || ''}`.trim(),
    text: `
New Quote Request — Superior 3D and Laser
==========================================

Name:        ${fields.firstName || ''} ${fields.lastName || ''}
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
  };
}

function buildCartOrderEmail(fields, stlFiles) {
  const filesSection = stlFiles && stlFiles.length > 0
    ? `\n--- Attached STL Files (${stlFiles.length}) ---\n` +
      stlFiles.map(f => f.fileName).join('\n')
    : '';

  return {
    to:      ['sales@superior3dandlaser.com'],
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
Subtotal:    ${fields.subtotal    || ''}
Tax (8.5%):  ${fields.tax         || ''}
ORDER TOTAL: ${fields.orderTotal  || ''}

--- Notes ---
${fields.orderNotes || 'None'}
${filesSection}
Payment Status: ${fields.paymentStatus || 'Pending'}
${fields.paymentId ? `Payment ID: ${fields.paymentId}` : ''}
===============================================
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

    // Save all uploaded files to Netlify Blobs
    const savedFiles = [];
    for (const f of files) {
      try {
        const { key } = await saveBlobFile(f.buffer, f.fileName, f.fileMime);
        savedFiles.push({ fieldName: f.fieldName, fileName: f.fileName, key, buffer: f.buffer, fileMime: f.fileMime });
      } catch (blobErr) {
        console.error('[submit-quote] Blob save error for', f.fileName, ':', blobErr.message, blobErr.stack);
      }
    }

    // Route to the correct email template
    const formType = fields.formType || (fields.orderType === 'cart-order' ? 'cart' : 'quote');
    let mailOptions;

    if (formType === 'contact') {
      mailOptions = buildContactEmail(fields);

    } else if (formType === 'cart' || fields.orderType === 'cart-order') {
      // STL files for cart orders are appended as stlFile_<itemId>
      const stlFiles = savedFiles.filter(f => f.fieldName.startsWith('stlFile'));
      mailOptions = buildCartOrderEmail(fields, stlFiles);

      // Attach STL files directly to the email
      if (stlFiles.length) {
        mailOptions.attachments = stlFiles.map(f => ({
          filename: f.fileName,
          content:  f.buffer.toString('base64'),
        }));
      }

      // Save order to Netlify Blobs for admin dashboard
      try {
        const orderStore = blobStore('orders');
        const orderId    = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const orderKey   = `order_${orderId}`;
        let parsedItems  = [];
        try { parsedItems = JSON.parse(fields.itemsJson || '[]'); } catch { /* best-effort */ }
        await orderStore.set(orderKey, JSON.stringify({
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
      // Quote form — primary file is the one named 'file'
      const primary  = savedFiles.find(f => f.fieldName === 'file') || savedFiles[0];
      const fileName = primary?.fileName || null;
      mailOptions = buildQuoteEmail(fields, fileName);

      // Attach file directly to the email
      if (primary?.buffer) {
        mailOptions.attachments = [{
          filename: primary.fileName,
          content:  primary.buffer.toString('base64'),
        }];
      }

      // Save order record to Blobs so it appears in the admin dashboard
      if (primary?.key) {
        try {
          const orderStore = blobStore('orders');
          const orderId    = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const orderKey   = `order_${orderId}`;
          await orderStore.set(orderKey, JSON.stringify({
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
      from:     'Superior 3D and Laser <sales@superior3dandlaser.com>',
      reply_to: 'sales@superior3dandlaser.com',
      ...mailOptions,
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
