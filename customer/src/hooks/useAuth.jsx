import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../utils/api';
import { SAMPLE_PROFILE } from '../utils/sampleData';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);   // { email, name }
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Try to restore session from cookie by fetching profile
    api.get('/api/customer/profile')
      .then(profile => setUser({ email: profile.email, name: profile.name }))
      .catch(() => {
        // Not logged in via cookie — check sample mode
        const demo = sessionStorage.getItem('demo_user');
        if (demo) setUser(JSON.parse(demo));
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    // Demo shortcut: any credentials with demo@example.com
    if (email === 'demo@example.com') {
      const demoUser = { email: SAMPLE_PROFILE.email, name: SAMPLE_PROFILE.name };
      sessionStorage.setItem('demo_user', JSON.stringify(demoUser));
      setUser(demoUser);
      return;
    }
    const data = await api.post('/api/customer/login', { email, password });
    setUser({ email, name: data.name });
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
