import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api } from '../utils/api';
import { formatDate } from '../utils/dateFormat';

export default function Account({ profile }) {
  const { user } = useAuth();
  const [name, setName]       = useState(profile?.name  || user?.name  || '');
  const [phone, setPhone]     = useState(profile?.phone || '');
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState('');

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await api.put('/api/customer/profile', { name, phone });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message || 'Failed to save changes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-[#111] mb-8">Account Settings</h1>

      <div className="bg-white rounded-xl border border-[#e0e0e0] overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-[#e0e0e0]">
          <h2 className="font-semibold text-[#111]">Profile Information</h2>
        </div>
        <form onSubmit={handleSave} className="px-6 py-5 space-y-5">
          <div>
            <label className="block text-sm font-medium text-[#111] mb-1.5">Email</label>
            <input
              type="email"
              value={profile?.email || user?.email || ''}
              disabled
              className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg bg-[#f8f8f8] text-[#555] cursor-not-allowed"
            />
            <p className="text-xs text-[#555] mt-1">Email cannot be changed. Contact support if needed.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[#111] mb-1.5">Full Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#111] mb-1.5">Phone</label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="(555) 000-0000"
              className="w-full px-3.5 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors"
            />
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}
          {saved && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
              Changes saved successfully.
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 bg-[#b91c1c] text-white text-sm font-medium rounded-lg hover:bg-[#dc2626] transition-colors disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </form>
      </div>

      {profile?.createdAt && (
        <div className="bg-[#f8f8f8] rounded-xl border border-[#e0e0e0] px-6 py-4 text-sm text-[#555]">
          <p>Member since <strong>{formatDate(profile.createdAt)}</strong></p>
          {profile.lastLogin && <p className="mt-0.5">Last login: {formatDate(profile.lastLogin)}</p>}
        </div>
      )}
    </div>
  );
}
