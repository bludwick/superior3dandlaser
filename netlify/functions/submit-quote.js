const busboy = require('busboy');
const nodemailer = require('nodemailer');
const { getStore } = require('@netlify/blobs');

// Parse multipart form data from the event
function parseForm(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null;
    let fileName = null;
    let fileMime = null;

    const bb = busboy({ headers: event.headers });

    bb.on('field', (name, value) => {
      fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      fileName = info.filename;
      fileMime = info.mimeType;
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('finish', () => resolve({ fields, fileBuffer, fileName, fileMime }));
    bb.on('error', reject);

    const body = Buffer.from(
      event.body,
      event.isBase64Encoded ? 'base64' : 'utf8'
    );
    bb.write(body);
    bb.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { fields, fileBuffer, fileName, fileMime } = await parseForm(event);

    // Save file to Netlify Blobs (persistent uploads store)
    let downloadUrl = null;
    let savedFileName = null;
    if (fileBuffer && fileName) {
      const store = getStore({ name: 'uploads', consistency: 'strong' });
      savedFileName = `${Date.now()}-${fileName}`;
      await store.set(savedFileName, fileBuffer, {
        metadata: { contentType: fileMime, originalName: fileName }
      });
      downloadUrl = `${process.env.SITE_URL}/.netlify/blobs/site:uploads/${savedFileName}`;
    }

    // Build email body
    const emailBody = `
New Quote Request — Superior 3D and Laser
==========================================

Name:        ${fields.firstName || ''} ${fields.lastName || ''}
Email:       ${fields.email || ''}
Phone:       ${fields.phone || 'Not provided'}
Service:     ${fields.service || ''}
Quantity:    ${fields.quantity || 'Not provided'}
Timeline:    ${fields.timeline || 'Not provided'}
Material:    ${fields.material || 'Not provided'}

Project Description:
${fields.message || ''}

${downloadUrl ? `Uploaded File: ${fileName}\nDownload Link: ${downloadUrl}` : 'No file attached.'}
==========================================
    `.trim();

    // Send email via Microsoft 365 SMTP
    const transporter = nodemailer.createTransport({
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: { ciphers: 'SSLv3' },
    });

    const mailOptions = {
      from: process.env.SMTP_USER,
      to: 'blake@superior3dandlaser.com',
      subject: `New Quote Request — ${fields.firstName || ''} ${fields.lastName || ''}`,
      text: emailBody,
    };

    // Attach file directly to email as well
    if (fileBuffer && fileName) {
      mailOptions.attachments = [{
        filename: fileName,
        content: fileBuffer,
        contentType: fileMime,
      }];
    }

    await transporter.sendMail(mailOptions);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error('submit-quote error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Submission failed. Please try again.' }),
    };
  }
};
