exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Clear the cookie by setting Max-Age=0
  const cookie = 'admin_token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
    body: JSON.stringify({ ok: true }),
  };
};
