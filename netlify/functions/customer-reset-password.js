const bcrypt       = require('bcryptjs');
const { getStore } = require('@netlify/blobs');

function store(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let token, newPassword;
  try {
    ({ token, newPassword } = JSON.parse(event.body || '{}'));
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  token       = (token       || '').trim();
  newPassword = (newPassword || '');

  if (!token || !newPassword) {
    return json(400, { error: 'Token and new password are required' });
  }
  if (newPassword.length < 8) {
    return json(400, { error: 'Password must be at least 8 characters' });
  }

  const authStore = store('customer-auth');

  const tokenData = await authStore.get(`reset_${token}`, { type: 'json' }).catch(() => null);
  if (!tokenData) {
    return json(400, { error: 'Invalid or expired reset link. Please request a new one.' });
  }

  if (Date.now() > tokenData.expiry) {
    await authStore.delete(`reset_${token}`).catch(() => {});
    return json(400, { error: 'This reset link has expired. Please request a new one.' });
  }

  const email   = tokenData.email;
  const account = await authStore.get(email, { type: 'json' }).catch(() => null);
  if (!account) {
    return json(400, { error: 'Account not found.' });
  }

  account.passwordHash = await bcrypt.hash(newPassword, 12);
  account.passwordChangedAt = new Date().toISOString();

  await authStore.setJSON(email, account);
  await authStore.delete(`reset_${token}`).catch(() => {});

  return json(200, { ok: true, message: 'Password updated. You can now sign in.' });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
