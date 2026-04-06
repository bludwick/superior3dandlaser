/**
 * Netlify Edge Function — admin-auth
 * Guards all /admin/* routes. Verifies the admin_token httpOnly cookie
 * using HS256 JWT via the Web Crypto API (Deno runtime, no npm deps).
 */
export default async function adminAuth(request, context) {
  try {
    const url = new URL(request.url);

    // Let the login page and its direct assets pass through unauthenticated
    if (
      url.pathname === '/admin/login' ||
      url.pathname === '/admin/login.html' ||
      url.pathname.startsWith('/admin/login.')
    ) {
      return; // continue to origin
    }

    // Read JWT_SECRET from environment (Netlify edge function context)
    const secret =
      (typeof Netlify !== 'undefined' && Netlify.env
        ? Netlify.env.get('JWT_SECRET')
        : null) ??
      (typeof Deno !== 'undefined' ? Deno.env.get('JWT_SECRET') : null);

    if (!secret) {
      // JWT_SECRET not configured — block access
      return Response.redirect(new URL('/admin/login.html', request.url), 302);
    }

    const token = getCookie(request.headers.get('cookie') || '', 'admin_token');
    if (!token) {
      return Response.redirect(new URL('/admin/login.html', request.url), 302);
    }

    const valid = await verifyJWT(token, secret);
    if (!valid) {
      return Response.redirect(new URL('/admin/login.html', request.url), 302);
    }

    // Valid token — allow request to continue
  } catch (err) {
    // Unexpected runtime error — fail safe by redirecting to login
    console.error('admin-auth edge function error:', err);
    return Response.redirect(new URL('/admin/login.html', request.url), 302);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCookie(cookieHeader, name) {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const [headerB64, payloadB64, sigB64] = parts;

    // Import key for HMAC-SHA256 verification
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    // Verify signature over "header.payload"
    const sig  = base64UrlDecode(sigB64);
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const ok   = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!ok) return false;

    // Check expiry claim
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64)),
    );
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}
