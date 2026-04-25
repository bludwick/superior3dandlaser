const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');

const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let email, password;
  try {
    ({ email, password } = JSON.parse(event.body || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  if (!email || !password) {
    return jsonResponse(400, { error: 'Email and password are required' });
  }

  // ── Rate limiting (persisted via Netlify Blobs) ────────────────────────────
  const ip    = (event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const rlKey = `rl_${ip.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  let store;
  let attempts = { count: 0, firstAt: Date.now() };

  try {
    store = getStore({ name: 'admin-auth', consistency: 'strong' });
    const stored = await store.get(rlKey, { type: 'json' });
    if (stored) attempts = stored;
  } catch {
    // Blobs unavailable — proceed without rate limiting
  }

  // Reset window if expired
  if (Date.now() - attempts.firstAt > LOCKOUT_MS) {
    attempts = { count: 0, firstAt: Date.now() };
  }

  if (attempts.count >= MAX_ATTEMPTS) {
    return jsonResponse(429, { error: 'Too many attempts. Try again in 15 minutes.' });
  }

  // ── Credential check ───────────────────────────────────────────────────────
  const adminEmail    = process.env.ADMIN_EMAIL         || '';
  const adminHash     = process.env.ADMIN_PASSWORD_HASH || '';
  const adminPassword = process.env.ADMIN_PASSWORD      || '';
  const jwtSecret     = process.env.JWT_SECRET           || '';

  let passwordOk = false;
  if (email === adminEmail) {
    if (adminHash) {
      // Prefer bcrypt hash comparison
      try { passwordOk = await bcrypt.compare(password, adminHash); } catch { /* invalid hash → false */ }
    } else if (adminPassword) {
      // Plain-text fallback (use when hash contains chars that break env var tools)
      passwordOk = password === adminPassword;
    }
  } else {
    // Run dummy bcrypt to prevent timing-based email enumeration
    try { await bcrypt.compare(password, '$2b$12$invalidhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'); } catch { /* no-op */ }
  }

  const success = email === adminEmail && passwordOk;

  if (!success) {
    attempts.count += 1;
    if (store) {
      try { await store.set(rlKey, attempts); } catch { /* best-effort */ }
    }
    return jsonResponse(401, { error: 'Invalid email or password' });
  }

  // ── Password verified — generate and send OTP ─────────────────────────────
  if (store) {
    try { await store.delete(rlKey); } catch { /* best-effort */ }
  }

  const otp    = String(crypto.randomInt(100000, 1000000));
  const otpKey = `otp_${adminEmail.replace(/[^a-zA-Z0-9]/g, '_')}`;

  if (store) {
    try {
      await store.set(otpKey, { code: otp, expiresAt: Date.now() + OTP_EXPIRY_MS, attempts: 0 });
    } catch { /* best-effort — proceed so login isn't broken if Blobs hiccup */ }
  }

  try {
    await sendOTPEmail(adminEmail, otp);
  } catch (err) {
    console.error('[2FA] Failed to send OTP email:', err.message);
    return jsonResponse(500, { error: 'Failed to send verification code. Please try again.' });
  }

  const pendingToken = jwt.sign({ sub: adminEmail, type: 'otp_pending' }, jwtSecret, { expiresIn: '10m' });

  return jsonResponse(200, { step: 'otp', pendingToken });
};

async function sendOTPEmail(toEmail, code) {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const from = process.env.EMAIL_FROM || 'Superior 3D and Laser <sales@superior3dandlaser.com>';
  await transporter.sendMail({
    from,
    to:      toEmail,
    subject: 'Your Admin Sign-In Code',
    text:    `Your verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, someone may have your admin credentials.`,
    html: `
      <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">
        <p style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#b91c1c;margin:0 0 8px">Superior 3D and Laser · Admin</p>
        <h2 style="margin:0 0 12px;font-size:22px;color:#111">Sign-In Verification</h2>
        <p style="color:#555;margin:0 0 24px;font-size:15px">Enter this code to complete your admin sign-in.</p>
        <div style="background:#f8f8f8;border:1px solid #e0e0e0;border-radius:8px;padding:20px 24px;text-align:center;margin-bottom:24px">
          <span style="font-size:40px;font-weight:900;letter-spacing:10px;color:#111;font-variant-numeric:tabular-nums">${code}</span>
        </div>
        <p style="color:#555;font-size:13px;margin:0 0 8px">This code expires in <strong>10 minutes</strong>.</p>
        <p style="color:#999;font-size:12px;margin:0">If you did not attempt to sign in, your admin credentials may be compromised. Change your password immediately.</p>
      </div>`,
  });
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
