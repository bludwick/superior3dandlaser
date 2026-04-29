import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../utils/api';

export default function Register() {
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const { setUser } = useAuth();
  const navigate    = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      const data = await api.post('/api/customer/register', { name, email, password });
      setUser({ name: data.name, email });
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Registration failed. Please try again.');
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
          <div className="px-6 pt-6 pb-2 border-b border-[#e0e0e0]">
            <h2 className="text-lg font-semibold text-[#111]">Create an Account</h2>
            <p className="text-sm text-[#555] mt-1 mb-4">
              Track all your orders, quotes, and uploaded files in one place.
            </p>
          </div>

          <div className="p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#111] mb-1.5">Full Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Jane Smith"
                  className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors"
                />
              </div>
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
                  placeholder="At least 8 characters"
                  className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#111] mb-1.5">Confirm Password</label>
                <input
                  type="password"
                  required
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
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
                {loading ? 'Creating account…' : 'Create Account'}
              </button>
            </form>

            <p className="text-sm text-[#555] text-center mt-5">
              Already have an account?{' '}
              <Link to="/login" className="text-[#b91c1c] font-medium hover:underline">
                Sign in
              </Link>
            </p>
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
