import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useGuest } from '../hooks/useGuest';

export default function Login() {
  const [tab, setTab]           = useState('account');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [projNum, setProjNum]   = useState('');
  const [gEmail, setGEmail]     = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const { login }      = useAuth();
  const { guestLogin } = useGuest();
  const navigate       = useNavigate();

  async function handleAccountLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  }

  async function handleGuestLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await guestLogin(projNum.trim(), gEmail.trim());
      navigate('/guest-order');
    } catch (err) {
      setError(err.message || 'Order not found. Please check your project number and email.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f1f1f1',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      position: 'relative',
    }}>
      {/* Subtle grid background matching admin login */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none',
        backgroundImage: 'linear-gradient(#e0e0e0 1px, transparent 1px), linear-gradient(90deg, #e0e0e0 1px, transparent 1px)',
        backgroundSize: '48px 48px', opacity: 0.18,
      }} />

      <div style={{
        position: 'relative',
        background: '#fff',
        border: '1px solid #e0e0e0',
        borderRadius: 16,
        boxShadow: '0 4px 24px rgba(0,0,0,.08)',
        padding: '44px 40px 40px',
        width: '100%',
        maxWidth: 420,
        margin: 20,
      }}>
        {/* Logo area */}
        <div style={{ marginBottom: 32 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#b91c1c', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Superior 3D and Laser
          </span>
          <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1.1, letterSpacing: '-0.02em', marginTop: 4 }}>
            Customer <span style={{ color: '#b91c1c' }}>Portal</span>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #e0e0e0', marginBottom: 28 }}>
          {[
            { key: 'account', label: 'Sign In' },
            { key: 'guest',   label: 'Guest Access' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setError(''); }}
              style={{
                flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600,
                border: 'none', background: 'none', cursor: 'pointer',
                color: tab === t.key ? '#b91c1c' : '#777',
                borderBottom: tab === t.key ? '2px solid #b91c1c' : '2px solid transparent',
                marginBottom: -1, transition: 'color .15s',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'account' ? (
          <form onSubmit={handleAccountLogin} noValidate>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 22 }}>
              Sign in to view your orders, quotes, and uploaded files.
            </p>

            <Field label="Email Address">
              <input
                type="email" required autoComplete="email"
                placeholder="you@example.com"
                value={email} onChange={e => setEmail(e.target.value)}
                style={inputStyle}
                onFocus={e => e.target.style.borderColor = '#b91c1c'}
                onBlur={e => e.target.style.borderColor = '#e0e0e0'}
              />
            </Field>

            <Field label="Password">
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  type={showPw ? 'text' : 'password'} required autoComplete="current-password"
                  placeholder="••••••••"
                  value={password} onChange={e => setPassword(e.target.value)}
                  style={{ ...inputStyle, paddingRight: 42 }}
                  onFocus={e => e.target.style.borderColor = '#b91c1c'}
                  onBlur={e => e.target.style.borderColor = '#e0e0e0'}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(p => !p)}
                  style={{ position: 'absolute', right: 10, background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 14, padding: '2px 4px' }}
                >
                  {showPw ? '🙈' : '👁'}
                </button>
              </div>
            </Field>

            {error && <ErrorBox>{error}</ErrorBox>}

            <button type="submit" disabled={loading} style={btnStyle(loading)}>
              {loading ? <Spinner /> : 'Sign In →'}
            </button>

            <p style={{ fontSize: 12, color: '#999', textAlign: 'center', marginTop: 16 }}>
              Demo:{' '}
              <button
                type="button"
                style={{ color: '#b91c1c', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}
                onClick={() => { setEmail('demo@example.com'); setPassword('demo'); }}
              >
                demo@example.com
              </button>{' '}
              to preview with sample data.
            </p>
          </form>
        ) : (
          <form onSubmit={handleGuestLogin} noValidate>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 22 }}>
              Enter your project number from your receipt to view a specific order — no account needed.
            </p>

            <Field label="Project Number">
              <input
                type="text" required
                placeholder="e.g. P-1042"
                value={projNum} onChange={e => setProjNum(e.target.value)}
                style={{ ...inputStyle, fontFamily: 'monospace' }}
                onFocus={e => e.target.style.borderColor = '#b91c1c'}
                onBlur={e => e.target.style.borderColor = '#e0e0e0'}
              />
            </Field>

            <Field label="Email Address">
              <input
                type="email" required autoComplete="email"
                placeholder="Email used when ordering"
                value={gEmail} onChange={e => setGEmail(e.target.value)}
                style={inputStyle}
                onFocus={e => e.target.style.borderColor = '#b91c1c'}
                onBlur={e => e.target.style.borderColor = '#e0e0e0'}
              />
            </Field>

            {error && <ErrorBox>{error}</ErrorBox>}

            <button type="submit" disabled={loading} style={btnStyle(loading)}>
              {loading ? <Spinner /> : 'Access Order →'}
            </button>

            <p style={{ fontSize: 12, color: '#999', textAlign: 'center', marginTop: 16 }}>
              Your project number is on your order receipt or confirmation email.
            </p>
          </form>
        )}

        <a href="/" style={{ display: 'block', textAlign: 'center', marginTop: 22, fontSize: 12, color: '#999', textDecoration: 'none' }}
          onMouseEnter={e => e.target.style.color = '#b91c1c'}
          onMouseLeave={e => e.target.style.color = '#999'}
        >
          ← Back to site
        </a>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#777', marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function ErrorBox({ children }) {
  return (
    <div style={{
      background: 'rgba(220,38,38,.05)', border: '1px solid rgba(220,38,38,.25)',
      borderRadius: 8, padding: '11px 14px', fontSize: 13, color: '#dc2626',
      fontWeight: 600, marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 16, height: 16,
      border: '2.5px solid rgba(255,255,255,.4)', borderTopColor: '#fff',
      borderRadius: '50%', animation: 'spin .7s linear infinite',
    }} />
  );
}

function btnStyle(loading) {
  return {
    width: '100%', padding: 12,
    background: loading ? '#b91c1c99' : '#b91c1c',
    color: '#fff', border: 'none', borderRadius: 8,
    fontSize: 14, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
    letterSpacing: '0.02em', marginTop: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    transition: 'background .2s, transform .15s, box-shadow .2s',
    fontFamily: "inherit",
  };
}

const inputStyle = {
  width: '100%', padding: '10px 13px',
  background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8,
  color: '#111', fontFamily: 'inherit', fontSize: 14,
  outline: 'none', transition: 'border-color .2s, box-shadow .2s',
  boxSizing: 'border-box',
};
