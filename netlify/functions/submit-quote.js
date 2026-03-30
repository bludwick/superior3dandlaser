const busboy    = require('busboy');
const nodemailer = require('nodemailer');
const { getStore } = require('@netlify/blobs');

// Parse multipart form data from the event
function parseForm(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null;
    let fileName   = null;
    let fileMime   = null;

    const bb = busboy({ headers: event.headers });

    bb.on('field', (name, value) => { fields[name] = value; });

    bb.on('file', (name, stream, info) => {
      fileName = info.filename;
      fileMime = info.mimeType;
      const chunks = [];
      stream.on('data',  chunk => chunks.push(chunk));
      stream.on('end',   ()    => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('finish', () => resolve({ fields, fileBuffer, fileName, fileMime }));
    bb.on('error',  reject);

    const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    bb.write(body);
    bb.end();
  });
}

// ── Microsoft 365 SMTP transporter ───────────────────────────────────────────
// Requires SMTP AUTH to be enabled on the mailbox in M365 Admin Center:
// admin.exchange.microsoft.com → Mailboxes → [mailbox] → Manage email apps
// → Authenticated SMTP = ON
function makeTransporter() {
  return nodemailer.createTransport({
    host:       'smtp.office365.com',
    port:       587,
    secure:     false,
    requireTLS: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
  });
}

// ── Email builders ────────────────────────────────────────────────────────────

function buildContactEmail(fields) {
  return {
    to:      'sales@superior3dandlaser.com',
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

function buildQuoteEmail(fields, fileName, downloadUrl) {
  return {
    to:      'blake@superior3dandlaser.com',
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

${downloadUrl ? `Uploaded File: ${fileName}\nDownload Link: ${downloadUrl}` : 'No file attached.'}
==========================================
    `.trim(),
  };
}

function buildCartOrderEmail(fields) {
  return {
    to:      'blake@superior3dandlaser.com',
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
    const { fields, fileBuffer, fileName, fileMime } = await parseForm(event);

    // Save uploaded file to Netlify Blobs (quote form only)
    let downloadUrl = null;
    if (fileBuffer && fileName) {
      const store         = getStore({ name: 'uploads', consistency: 'strong' });
      const savedFileName = `${Date.now()}-${fileName}`;
      await store.set(savedFileName, fileBuffer, {
        metadata: { contentType: fileMime, originalName: fileName },
      });
      downloadUrl = `${process.env.SITE_URL}/.netlify/blobs/site:uploads/${savedFileName}`;
    }

    // Route to the correct email template
    const formType = fields.formType || (fields.orderType === 'cart-order' ? 'cart' : 'quote');
    let mailOptions;
    if (formType === 'contact') {
      mailOptions = buildContactEmail(fields);
    } else if (formType === 'cart' || fields.orderType === 'cart-order') {
      mailOptions = buildCartOrderEmail(fields);
    } else {
      mailOptions = buildQuoteEmail(fields, fileName, downloadUrl);
    }

    // Attach uploaded file directly to the email
    if (fileBuffer && fileName) {
      mailOptions.attachments = [{
        filename:    fileName,
        content:     fileBuffer,
        contentType: fileMime,
      }];
    }

    const transporter = makeTransporter();
    await transporter.sendMail({
      from: `Superior 3D and Laser <${process.env.SMTP_USER}>`,
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
