const jwt = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { jobId } = event.queryStringParameters || {};
  if (!jobId) {
    return jsonResponse(400, { error: 'Missing job ID' });
  }

  // ── Verify customer JWT from cookie (for account access) ────────────────────
  const token = getCookie(event.headers['cookie'] || '', 'customer_token');
  const guestToken = event.queryStringParameters?.guestToken;

  let customerEmail = null;
  let accessible = false;

  // Try account JWT
  if (token) {
    const jwtSecret = process.env.JWT_SECRET || '';
    try {
      const decoded = jwt.verify(token, jwtSecret);
      customerEmail = decoded.sub;
    } catch {
      // Invalid JWT, try guest token
    }
  }

  // Try guest token
  if (!customerEmail && guestToken) {
    // Guest token format: projectNumber_email
    const [projectNumber, email] = guestToken.split('_');
    if (projectNumber && email) {
      customerEmail = email;
    }
  }

  if (!customerEmail) return authError();

  // ── Lookup order/job ───────────────────────────────────────────────────────
  try {
    const bs = blobStore('orders');
    const { blobs } = await bs.list();

    let order = null;
    for (const blob of blobs) {
      try {
        const text = await bs.get(blob.key);
        const ord = text ? JSON.parse(text) : null;
        if (ord && ord.id === jobId && ord.customerEmail.toLowerCase() === customerEmail.toLowerCase()) {
          order = ord;
          break;
        }
      } catch {
        // Skip invalid orders
      }
    }

    if (!order) {
      return jsonResponse(404, { error: 'Invoice not found' });
    }

    // Generate invoice HTML
    const invoiceHtml = generateInvoiceHtml(order);

    return jsonResponse(200, {
      html: invoiceHtml,
      order: {
        id: order.id,
        projectNumber: order.projectNumber,
        projectName: order.projectName,
        customerName: order.customerName,
        createdAt: order.createdAt,
      },
    });
  } catch (err) {
    console.error('[customer-invoice] Error:', err.message);
    return jsonResponse(500, { error: 'Failed to load invoice' });
  }
};

function generateInvoiceHtml(order) {
  const formattedDate = new Date(order.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const itemsHtml = order.items
    .map(item => `
      <tr>
        <td style="text-align: left; padding: 8px;">${item.partName || item.projectName || 'Item'}</td>
        <td style="text-align: center; padding: 8px;">${item.material || '-'}</td>
        <td style="text-align: center; padding: 8px;">${item.color || '-'}</td>
        <td style="text-align: center; padding: 8px;">${item.qty || 1}</td>
        <td style="text-align: right; padding: 8px;">$${(item.unitPrice || 0).toFixed(2)}</td>
        <td style="text-align: right; padding: 8px;">$${(item.lineTotal || 0).toFixed(2)}</td>
      </tr>
    `)
    .join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #fff; }
        .container { max-width: 900px; margin: 0 auto; }
        .header { border-bottom: 2px solid #b91c1c; margin-bottom: 30px; padding-bottom: 20px; }
        .header h1 { margin: 0; color: #b91c1c; font-size: 28px; }
        .company-name { color: #666; font-size: 14px; margin-top: 5px; }
        .invoice-details { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 30px; }
        .section-title { font-weight: bold; color: #333; font-size: 12px; text-transform: uppercase; margin-bottom: 8px; }
        .invoice-details p { margin: 5px 0; color: #666; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        th { background: #f1f1f1; text-align: left; padding: 10px; border-bottom: 1px solid #ddd; font-size: 12px; font-weight: bold; }
        td { padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; }
        .totals { display: grid; grid-template-columns: 1fr 200px; gap: 20px; }
        .totals-section { text-align: right; }
        .totals-section p { margin: 8px 0; font-size: 13px; color: #666; }
        .totals-section .total { font-size: 16px; font-weight: bold; color: #333; border-top: 2px solid #b91c1c; padding-top: 8px; }
        .status-badge { display: inline-block; padding: 5px 10px; border-radius: 4px; font-size: 12px; font-weight: bold; }
        .status-pending { background: #fff3cd; color: #856404; }
        .status-printing { background: #cce5ff; color: #004085; }
        .status-ready { background: #d4edda; color: #155724; }
        .status-complete { background: #d4edda; color: #155724; }
        .footer { margin-top: 40px; border-top: 1px solid #ddd; padding-top: 20px; text-align: center; color: #999; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>INVOICE</h1>
          <p class="company-name">Superior 3D and Laser</p>
        </div>

        <div class="invoice-details">
          <div>
            <p class="section-title">Invoice From</p>
            <p><strong>Superior 3D and Laser</strong></p>
            <p>sales@superior3dandlaser.com</p>
          </div>
          <div>
            <p class="section-title">Invoice Details</p>
            <p><strong>Project #:</strong> ${order.projectNumber || order.id}</p>
            <p><strong>Project Name:</strong> ${order.projectName || 'N/A'}</p>
            <p><strong>Date:</strong> ${formattedDate}</p>
            <p><strong>Status:</strong> <span class="status-badge status-${(order.status || 'pending').toLowerCase()}">${order.status || 'Pending'}</span></p>
          </div>
        </div>

        <div class="invoice-details">
          <div>
            <p class="section-title">Bill To</p>
            <p><strong>${order.customerName || 'N/A'}</strong></p>
            <p>${order.customerEmail || ''}</p>
            <p>${order.phone || ''}</p>
            <p>${order.address || ''}</p>
          </div>
          <div>
            <p class="section-title">Payment Status</p>
            <p><strong>${order.paymentStatus === 'paid' ? '✓ Paid' : 'Unpaid'}</strong></p>
            ${order.paidAt ? `<p><strong>Paid On:</strong> ${new Date(order.paidAt).toLocaleDateString()}</p>` : ''}
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th>Material</th>
              <th>Color</th>
              <th>Qty</th>
              <th>Unit Price</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <div class="totals">
          <div></div>
          <div class="totals-section">
            <p><strong>Subtotal:</strong> $${(order.subtotal || 0).toFixed(2)}</p>
            <p><strong>Tax:</strong> $${(order.tax || 0).toFixed(2)}</p>
            <p class="total"><strong>Total:</strong> $${(order.total || 0).toFixed(2)}</p>
          </div>
        </div>

        ${order.notes ? `<div style="margin-top: 30px; padding: 15px; background: #f9f9f9; border-radius: 4px;">
          <p style="margin: 0; color: #666; font-size: 12px;"><strong>Notes:</strong></p>
          <p style="margin: 8px 0; color: #666; font-size: 13px;">${order.notes}</p>
        </div>` : ''}

        <div class="footer">
          <p>Thank you for your business! superior3dandlaser.com</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function getCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[2]) : null;
}

function authError() {
  return jsonResponse(401, { error: 'Unauthorized' });
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
