import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Layout from './components/Layout.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Wallet = lazy(() => import('./pages/Wallet.jsx'));
const Vicoba = lazy(() => import('./pages/Vicoba.jsx'));
const Rosca = lazy(() => import('./pages/Rosca.jsx'));
const P2p = lazy(() => import('./pages/P2p.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const Services = lazy(() => import('./pages/Services.jsx'));
const Promotions = lazy(() => import('./pages/Promotions.jsx'));
const Notifications = lazy(() => import('./pages/Notifications.jsx'));
const Referrals = lazy(() => import('./pages/Referrals.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));

function RequireAuth({ children }) {
  const token = localStorage.getItem('afrikoba_token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

function DashboardLoader() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh', color: '#6b7a70', fontSize: 14 }}>
      Inapakia...
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Suspense fallback={<DashboardLoader />}><Dashboard /></Suspense>} />
        <Route path="services" element={<Suspense fallback={<DashboardLoader />}><Services /></Suspense>} />
        <Route path="promotions" element={<Suspense fallback={<DashboardLoader />}><Promotions /></Suspense>} />
        <Route path="wallet" element={<Suspense fallback={<DashboardLoader />}><Wallet /></Suspense>} />
        <Route path="vicoba" element={<Suspense fallback={<DashboardLoader />}><Vicoba /></Suspense>} />
        <Route path="rosca" element={<Suspense fallback={<DashboardLoader />}><Rosca /></Suspense>} />
        <Route path="p2p" element={<Suspense fallback={<DashboardLoader />}><P2p /></Suspense>} />
        <Route path="admin" element={<Suspense fallback={<DashboardLoader />}><Admin /></Suspense>} />
        <Route path="notifications" element={<Suspense fallback={<DashboardLoader />}><Notifications /></Suspense>} />
        <Route path="referrals" element={<Suspense fallback={<DashboardLoader />}><Referrals /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={<DashboardLoader />}><Settings /></Suspense>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}