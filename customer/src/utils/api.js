const BASE = '';

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[2]) : null;
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  const guestToken = sessionStorage.getItem('guest_token');
  if (guestToken) headers['X-Guest-Token'] = guestToken;

  const res = await fetch(BASE + path, {
    credentials: 'include',
    ...options,
    headers,
  });

  if (res.status === 401) {
    // Clear stale auth
    sessionStorage.removeItem('guest_data');
    sessionStorage.removeItem('guest_token');
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

export const api = {
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }),
  get:  (path)       => request(path, { method: 'GET' }),
  put:  (path, body) => request(path, { method: 'PUT',  body: JSON.stringify(body) }),
};
