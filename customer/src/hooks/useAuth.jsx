import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../utils/api';
import { SAMPLE_PROFILE } from '../utils/sampleData';

const DEMO_USER = { email: SAMPLE_PROFILE.email, name: SAMPLE_PROFILE.name };

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Restore demo session instantly — no API call needed
    if (sessionStorage.getItem('demo_user') === 'true') {
      setUser(DEMO_USER);
      setLoading(false);
      return;
    }
    // Try to restore a real session from the JWT cookie
    api.get('/api/customer/profile')
      .then(profile => setUser({ email: profile.email, name: profile.name }))
      .catch(() => { /* not logged in */ })
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const emailLower = email.toLowerCase();
    // Demo shortcut — bypass API entirely
    if (emailLower === 'demo@example.com') {
      sessionStorage.setItem('demo_user', 'true');
      setUser(DEMO_USER);
      return;
    }
    const data = await api.post('/api/login', { email: emailLower, password });
    if (data.role === 'admin') {
      window.location.href = '/admin/';
      return;
    }
    setUser({ email: emailLower, name: data.name });
  }

  async function logout() {
    sessionStorage.removeItem('demo_user');
    sessionStorage.removeItem('guest_data');
    sessionStorage.removeItem('guest_token');
    try { await api.post('/api/customer/logout', {}); } catch { /* best-effort */ }
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
