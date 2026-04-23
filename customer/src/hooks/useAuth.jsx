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
    const emailLower = email.toLowerCase();
    const data = await api.post('/api/customer/login', { email: emailLower, password });
    // Mark demo mode if logged in as demo@example.com
    if (emailLower === 'demo@example.com') {
      sessionStorage.setItem('demo_user', 'true');
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
