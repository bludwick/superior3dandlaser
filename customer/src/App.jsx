import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { GuestProvider, useGuest } from './hooks/useGuest';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Orders from './pages/Orders';
import Quotes from './pages/Quotes';
import CADModels from './pages/CADModels';
import Account from './pages/Account';
import GuestOrder from './pages/GuestOrder';
import { api } from './utils/api';
import { SAMPLE_ORDERS, SAMPLE_PROFILE } from './utils/sampleData';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function GuestRoute({ children }) {
  const { guestOrder } = useGuest();
  if (!guestOrder) return <Navigate to="/login" replace />;
  return children;
}

function AppContent() {
  const { user, loading } = useAuth();
  const [orders, setOrders]   = useState([]);
  const [profile, setProfile] = useState(null);
  const [dataLoaded, setDataLoaded] = useState(false);

  useEffect(() => {
    if (!user || dataLoaded) return;

    const isDemo = sessionStorage.getItem('demo_user');
    if (isDemo) {
      setOrders(SAMPLE_ORDERS);
      setProfile(SAMPLE_PROFILE);
      setDataLoaded(true);
      return;
    }

    Promise.all([
      api.get('/api/customer/orders').catch(() => SAMPLE_ORDERS),
      api.get('/api/customer/profile').catch(() => SAMPLE_PROFILE),
    ]).then(([ordersData, profileData]) => {
      setOrders(ordersData);
      setProfile(profileData);
      setDataLoaded(true);
    });
  }, [user, dataLoaded]);

  return (
    <Routes>
      <Route path="/login"       element={<Login />} />
      <Route path="/guest-order" element={
        <GuestRoute>
          <GuestOrder />
        </GuestRoute>
      } />

      <Route path="/dashboard" element={
        <ProtectedRoute>
          <Layout><Dashboard orders={orders} /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/orders" element={
        <ProtectedRoute>
          <Layout><Orders orders={orders} title="Orders" /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/quotes" element={
        <ProtectedRoute>
          <Layout><Quotes orders={orders} /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/models" element={
        <ProtectedRoute>
          <Layout><CADModels orders={orders} /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/account" element={
        <ProtectedRoute>
          <Layout><Account profile={profile} /></Layout>
        </ProtectedRoute>
      } />

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/portal">
      <AuthProvider>
        <GuestProvider>
          <AppContent />
        </GuestProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-[#f1f1f1] flex items-center justify-center">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-[#b91c1c] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-[#555] text-sm">Loading…</p>
      </div>
    </div>
  );
}
