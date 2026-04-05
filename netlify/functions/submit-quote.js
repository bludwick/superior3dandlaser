const busboy        = require('busboy');
const { getStore }  = require('@netlify/blobs');
const { Resend }    = require('resend');

// Parse multipart form data from the event — returns all files as an array
function parseForm(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files  = [];

    const bb = busboy({ headers: event.headers });

    bb.on('field', (name, value) => { fields[name] = value; });

    bb.on('file', (fieldName, stream, info) => {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        if (chunks.length) {
          files.push({
            buffer:    Buffer.concat(chunks),
            name:      info.filename,
            mime:      info.mimeType,
            fieldName,
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
    to:      ['ludwick.blake@gmail.com'],
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
    to:      ['ludwick.blake@gmail.com'],
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

function buildCartOrderEmail(fields) {
  return {
    to:      ['ludwick.blake@gmail.com'],
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

    const formType = fields.formType || (fields.orderType === 'cart-order' ? 'cart' : 'quote');
    let mailOptions;

    if (formType === 'contact') {
      // ── Contact form — no file upload ──────────────────────────────────────
      mailOptions = buildContactEmail(fields);

    } else if (formType === 'cart' || fields.orderType === 'cart-order') {
      // ── Cart order — may include STL files (stl_0, stl_1, …) ──────────────
      mailOptions = buildCartOrderEmail(fields);

      const stlFiles = files.filter(f => f.fieldName.startsWith('stl_'));
      if (stlFiles.length) {
        // Save each STL to Netlify Blobs (best-effort — failure won't block email)
        try {
          const store = getStore('uploads');
          await Promise.all(stlFiles.map(f => {
            const savedName = `cart-${Date.now()}-${f.name}`;
            return store.set(savedName, f.buffer, {
              metadata: { contentType: f.mime || 'application/octet-stream', originalName: f.name },
            });
          }));
        } catch (blobErr) {
          console.error('Blobs upload error (cart):', blobErr.message, blobErr.stack);
        }

        // Attach all STL files to the email
        mailOptions.attachments = stlFiles.map(f => ({
          filename: f.name,
          content:  f.buffer.toString('base64'),
        }));

        // Append file names to email body
        mailOptions.text += `\n\n--- Attached STL Files ---\n${stlFiles.map(f => f.name).join('\n')}`;
      }

    } else {
      // ── Quote form — single file upload ───────────────────────────────────
      const quoteFile = files[0];

      if (quoteFile) {
        // Save to Netlify Blobs (best-effort — failure won't block email)
        try {
          const store     = getStore('uploads');
          const savedName = `${Date.now()}-${quoteFile.name}`;
          await store.set(savedName, quoteFile.buffer, {
            metadata: { contentType: quoteFile.mime, originalName: quoteFile.name },
          });
        } catch (blobErr) {
          console.error('Blobs upload error (quote):', blobErr.message, blobErr.stack);
        }
      }

      mailOptions = buildQuoteEmail(fields, quoteFile?.name);

      if (quoteFile) {
        mailOptions.attachments = [{
          filename: quoteFile.name,
          content:  quoteFile.buffer.toString('base64'),
        }];
      }
    }

    await sendEmail({
      from:     'Superior 3D and Laser <sales@superiormetrology.com>',
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
