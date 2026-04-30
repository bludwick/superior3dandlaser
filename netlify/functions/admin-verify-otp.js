const jwt          = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');

const OTP_EXPIRY_MS  = 10 * 60 * 1000; // 10 minutes
const MAX_OTP_TRIES  = 5;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid request body' }); }

  const { otp, pendingToken, resend } = body;

  if (!pendingToken) {
    return jsonResponse(400, { error: 'Missing session token. Please sign in again.' });
  }

  const jwtSecret = process.env.JWT_SECRET || '';

  // ── Verify pending token ───────────────────────────────────────────────────
  let payload;
  try {
    payload = jwt.verify(pendingToken, jwtSecret);
  } catch {
    return jsonResponse(401, { error: 'Session expired. Please sign in again.' });
  }

  if (payload.type !== 'otp_pending' || !payload.sub) {
    return jsonResponse(401, { error: 'Invalid session. Please sign in again.' });
  }

  const adminEmail = payload.sub;
  const otpKey     = `otp_${adminEmail.replace(/[^a-zA-Z0-9]/g, '_')}`;

  let store;
  try {
    store = getStore({ name: 'admin-auth', consistency: 'strong' });
  } catch {
    return jsonResponse(500, { error: 'Server error. Please try again.' });
  }

  // ── Resend flow ────────────────────────────────────────────────────────────
  if (resend) {
    const newCode = String(crypto.randomInt(100000, 1000000));
    try {
      await store.set(otpKey, { code: newCode, expiresAt: Date.now() + OTP_EXPIRY_MS, attempts: 0 });
    } catch { /* best-effort */ }

    try {
      await sendOTPEmail(adminEmail, newCode);
    } catch (err) {
      console.error('[2FA] Resend failed:', err.message);
      return jsonResponse(500, { error: 'Failed to resend code. Please try again.' });
    }

    const newPending = jwt.sign({ sub: adminEmail, type: 'otp_pending' }, jwtSecret, { expiresIn: '10m' });
    return jsonResponse(200, { step: 'otp', pendingToken: newPending });
  }

  // ── Verify OTP ────────────────────────────────────────────────────────────
  if (!otp || !/^\d{6}$/.test(otp)) {
    return jsonResponse(400, { error: 'Please enter a valid 6-digit code.' });
  }

  let stored;
  try {
    stored = await store.get(otpKey, { type: 'json' });
  } catch {
    stored = null;
  }

  if (!stored) {
    return jsonResponse(401, { error: 'Code expired. Please sign in again.' });
  }

  if (Date.now() > stored.expiresAt) {
    try { await store.delete(otpKey); } catch { /* best-effort */ }
    return jsonResponse(401, { error: 'Code expired. Please sign in again.' });
  }

  if (stored.attempts >= MAX_OTP_TRIES) {
    try { await store.delete(otpKey); } catch { /* best-effort */ }
    return jsonResponse(429, { error: 'Too many incorrect attempts. Please sign in again.' });
  }

  if (otp !== stored.code) {
    const newAttempts = stored.attempts + 1;
    try { await store.set(otpKey, { ...stored, attempts: newAttempts }); } catch { /* best-effort */ }
    const left = MAX_OTP_TRIES - newAttempts;
    return jsonResponse(401, {
      error: left > 0
        ? `Incorrect code — ${left} attempt${left !== 1 ? 's' : ''} remaining.`
        : 'Too many incorrect attempts. Please sign in again.',
    });
  }

  // ── OTP correct — issue full admin token ───────────────────────────────────
  try { await store.delete(otpKey); } catch { /* best-effort */ }

  const token  = jwt.sign({ sub: adminEmail }, jwtSecret, { expiresIn: '8h' });
  const isProd = (process.env.URL || '').startsWith('https://');
  const cookieParts = [
    `admin_token=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${8 * 60 * 60}`,
  ];
  if (isProd) cookieParts.push('Secure');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieParts.join('; '),
    },
    body: JSON.stringify({ ok: true }),
  };
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
