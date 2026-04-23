exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const isProd = (process.env.URL || '').startsWith('https://');
  const cookieParts = [
    'customer_token=',
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Max-Age=0',
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
