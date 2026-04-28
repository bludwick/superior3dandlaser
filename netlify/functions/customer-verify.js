const { getStore } = require('@netlify/blobs');

function store(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = (event.queryStringParameters || {}).token || '';
  if (!token) {
    return json(400, { error: 'Verification token is required' });
  }

  const authStore = store('customer-auth');

  const tokenData = await authStore.get(`verify_${token}`, { type: 'json' }).catch(() => null);
  if (!tokenData) {
    return json(400, { error: 'Invalid or expired verification link. Please register again.' });
  }

  if (Date.now() > tokenData.expiry) {
    await authStore.delete(`verify_${token}`).catch(() => {});
    return json(400, { error: 'This verification link has expired. Please register again.' });
  }

  const email   = tokenData.email;
  const account = await authStore.get(email, { type: 'json' }).catch(() => null);

  if (!account) {
    return json(400, { error: 'Account not found. Please register again.' });
  }

  if (account.verified) {
    return json(200, { ok: true, message: 'Email already verified. You can sign in.' });
  }

  // Activate the account
  account.verified = true;
  delete account.verifyToken;
  delete account.verifyExpiry;
  account.verifiedAt = new Date().toISOString();

  await authStore.setJSON(email, account);
  await authStore.delete(`verify_${token}`).catch(() => {});

  return json(200, { ok: true, message: 'Email verified. You can now sign in.' });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
