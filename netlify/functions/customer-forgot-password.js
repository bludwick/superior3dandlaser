const crypto       = require('crypto');
const nodemailer   = require('nodemailer');
const { getStore } = require('@netlify/blobs');

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function store(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) throw new Error('SMTP not configured');
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let email;
  try {
    ({ email } = JSON.parse(event.body || '{}'));
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  email = (email || '').trim().toLowerCase();
  if (!email) {
    return json(400, { error: 'Email address is required' });
  }

  // Always return 200 to prevent email enumeration
  const authStore = store('customer-auth');
  const account   = await authStore.get(email, { type: 'json' }).catch(() => null);

  if (!account || !account.verified) {
    // Silently succeed — don't reveal whether the account exists
    return json(200, { ok: true });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const expiry     = Date.now() + TOKEN_TTL_MS;

  await authStore.setJSON(`reset_${resetToken}`, { email, expiry });

  await sendResetEmail(email, account.name || email, resetToken);

  return json(200, { ok: true });
};

async function sendResetEmail(email, name, token) {
  const siteUrl  = (process.env.SITE_URL || 'https://superior3dandlaser.com').replace(/\/$/, '');
  const link     = `${siteUrl}/reset-password.html?token=${token}`;
  const fromAddr = process.env.EMAIL_FROM || 'Superior 3D and Laser <sales@superior3dandlaser.com>';

  const html = `
    <div style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden;">
      <div style="background:#b91c1c;padding:24px 32px;">
        <p style="color:rgba(255,255,255,.7);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin:0 0 4px;">Superior 3D and Laser</p>
        <p style="color:#fff;font-size:20px;font-weight:800;margin:0;">Reset Your Password</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#111;font-size:15px;margin:0 0 16px;">Hi ${esc(name)},</p>
        <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px;">
          We received a request to reset your password. Click the button below to choose a new one.
        </p>
        <a href="${link}" style="display:inline-block;background:#b91c1c;color:#fff;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.02em;">
          Reset Password →
        </a>
        <p style="color:#999;font-size:12px;margin:24px 0 0;line-height:1.5;">
          This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password won't change.
        </p>
        <p style="color:#ccc;font-size:11px;margin:12px 0 0;word-break:break-all;">
          Or copy this link: ${link}
        </p>
      </div>
    </div>`;

  const text = `Hi ${name},\n\nReset your Superior 3D and Laser password:\n${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`;

  const transporter = createTransport();
  await transporter.sendMail({
    from:    fromAddr,
    to:      email,
    subject: 'Reset your password — Superior 3D and Laser',
    text,
    html,
  });
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
