const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');
const { getStore } = require('@netlify/blobs');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

  let name, email, password, phone, company;
  try {
    ({ name, email, password, phone, company } = JSON.parse(event.body || '{}'));
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  name    = (name    || '').trim();
  email   = (email   || '').trim().toLowerCase();
  password = (password || '');
  phone   = (phone   || '').trim();
  company = (company || '').trim();

  if (!name || !email || !password) {
    return json(400, { error: 'Name, email, and password are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'Please enter a valid email address' });
  }
  if (password.length < 8) {
    return json(400, { error: 'Password must be at least 8 characters' });
  }

  const authStore = store('customer-auth');

  // Reject if account already exists (pending or active)
  const existing = await authStore.get(email, { type: 'json' }).catch(() => null);
  if (existing) {
    if (existing.verified) {
      return json(409, { error: 'An account with this email already exists. Try signing in.' });
    }
    // Resend verification if account is pending (not yet verified)
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiry      = Date.now() + TOKEN_TTL_MS;
    existing.verifyToken  = verifyToken;
    existing.verifyExpiry = expiry;
    await authStore.setJSON(email, existing);
    await authStore.setJSON(`verify_${verifyToken}`, { email, expiry });
    await sendVerificationEmail(email, existing.name, verifyToken);
    return json(201, { ok: true, message: 'Verification email resent. Check your inbox.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const verifyToken  = crypto.randomBytes(32).toString('hex');
  const expiry       = Date.now() + TOKEN_TTL_MS;

  const account = {
    name,
    email,
    passwordHash,
    phone,
    company,
    verified:     false,
    verifyToken,
    verifyExpiry: expiry,
    createdAt:    new Date().toISOString(),
  };

  await authStore.setJSON(email, account);
  await authStore.setJSON(`verify_${verifyToken}`, { email, expiry });

  await sendVerificationEmail(email, name, verifyToken);

  return json(201, { ok: true, message: 'Account created. Check your email to verify.' });
};

async function sendVerificationEmail(email, name, token) {
  const siteUrl  = (process.env.SITE_URL || 'https://superior3dandlaser.com').replace(/\/$/, '');
  const link     = `${siteUrl}/verify-email.html?token=${token}`;
  const fromAddr = process.env.EMAIL_FROM || 'Superior 3D and Laser <sales@superior3dandlaser.com>';

  const html = `
    <div style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden;">
      <div style="background:#b91c1c;padding:24px 32px;">
        <p style="color:rgba(255,255,255,.7);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin:0 0 4px;">Superior 3D and Laser</p>
        <p style="color:#fff;font-size:20px;font-weight:800;margin:0;">Verify Your Email</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#111;font-size:15px;margin:0 0 16px;">Hi ${esc(name)},</p>
        <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px;">
          Thanks for creating an account! Click the button below to verify your email address and activate your account.
        </p>
        <a href="${link}" style="display:inline-block;background:#b91c1c;color:#fff;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.02em;">
          Verify Email Address →
        </a>
        <p style="color:#999;font-size:12px;margin:24px 0 0;line-height:1.5;">
          This link expires in 24 hours. If you didn't create an account, you can ignore this email.
        </p>
        <p style="color:#ccc;font-size:11px;margin:12px 0 0;word-break:break-all;">
          Or copy this link: ${link}
        </p>
      </div>
    </div>`;

  const text = `Hi ${name},\n\nVerify your Superior 3D and Laser account:\n${link}\n\nThis link expires in 24 hours.`;

  const transporter = createTransport();
  await transporter.sendMail({
    from:    fromAddr,
    to:      email,
    subject: 'Verify your email — Superior 3D and Laser',
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
