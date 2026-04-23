import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useGuest } from '../hooks/useGuest';

export default function Login() {
  const [tab, setTab]           = useState('account');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [projNum, setProjNum]   = useState('');
  const [gEmail, setGEmail]     = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const { login }       = useAuth();
  const { guestLogin }  = useGuest();
  const navigate        = useNavigate();

  async function handleAccountLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
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
    <div className="min-h-screen bg-[#f1f1f1] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-[#b91c1c]">Superior 3D and Laser</h1>
          <p className="text-[#555] text-sm mt-1">Customer Portal</p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-[#e0e0e0]">
            <button
              onClick={() => { setTab('account'); setError(''); }}
              className={`flex-1 py-4 text-sm font-medium transition-colors ${
                tab === 'account'
                  ? 'text-[#b91c1c] border-b-2 border-[#b91c1c] bg-white'
                  : 'text-[#555] hover:text-[#111] bg-[#f8f8f8]'
              }`}
            >
              Account Login
            </button>
            <button
              onClick={() => { setTab('guest'); setError(''); }}
              className={`flex-1 py-4 text-sm font-medium transition-colors ${
                tab === 'guest'
                  ? 'text-[#b91c1c] border-b-2 border-[#b91c1c] bg-white'
                  : 'text-[#555] hover:text-[#111] bg-[#f8f8f8]'
              }`}
            >
              Guest Access
            </button>
          </div>

          <div className="p-6">
            {tab === 'account' ? (
              <>
                <p className="text-sm text-[#555] mb-5">
                  Log in to view all your orders, quotes, and uploaded files.
                </p>

                <form onSubmit={handleAccountLogin} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-[#111] mb-1.5">Email</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[#111] mb-1.5">Password</label>
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors"
                    />
                  </div>

                  {error && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2.5 bg-[#b91c1c] text-white text-sm font-medium rounded-lg hover:bg-[#dc2626] transition-colors disabled:opacity-60"
                  >
                    {loading ? 'Signing in…' : 'Sign In'}
                  </button>
                </form>

                <p className="text-xs text-[#555] text-center mt-4">
                  Demo: use{' '}
                  <button
                    className="text-[#b91c1c] underline"
                    onClick={() => { setEmail('demo@example.com'); setPassword('demo'); }}
                  >
                    demo@example.com
                  </button>{' '}
                  to preview with sample data.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-[#555] mb-5">
                  Enter your project number from your receipt to view a specific order without an account.
                </p>

                <form onSubmit={handleGuestLogin} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-[#111] mb-1.5">Project Number</label>
                    <input
                      type="text"
                      required
                      value={projNum}
                      onChange={e => setProjNum(e.target.value)}
                      placeholder="e.g. P-1042"
                      className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[#111] mb-1.5">Email Address</label>
                    <input
                      type="email"
                      required
                      value={gEmail}
                      onChange={e => setGEmail(e.target.value)}
                      placeholder="Email used for the order"
                      className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors"
                    />
                  </div>

                  {error && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2.5 bg-[#b91c1c] text-white text-sm font-medium rounded-lg hover:bg-[#dc2626] transition-colors disabled:opacity-60"
                  >
                    {loading ? 'Looking up order…' : 'Access Order'}
                  </button>
                </form>

                <p className="text-xs text-[#555] text-center mt-4">
                  Your project number is printed on your order receipt or confirmation email.
                </p>
              </>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-[#555] mt-4">
          Need help?{' '}
          <a href="mailto:sales@superior3dandlaser.com" className="text-[#b91c1c] hover:underline">
            Contact us
          </a>
        </p>
      </div>
    </div>
  );
}
