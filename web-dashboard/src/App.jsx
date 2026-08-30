import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Wallet from './pages/Wallet.jsx';
import Vicoba from './pages/Vicoba.jsx';
import Rosca from './pages/Rosca.jsx';
import P2p from './pages/P2p.jsx';
import Admin from './pages/Admin.jsx';
import Services from './pages/Services.jsx';
import Promotions from './pages/Promotions.jsx';
import Notifications from './pages/Notifications.jsx';
import Referrals from './pages/Referrals.jsx';
import Settings from './pages/Settings.jsx';

function RequireAuth({ children }) {
  const token = localStorage.getItem('afrikoba_token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
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
        <Route index element={<Dashboard />} />
        <Route path="services" element={<Services />} />
        <Route path="promotions" element={<Promotions />} />
        <Route path="wallet" element={<Wallet />} />
        <Route path="vicoba" element={<Vicoba />} />
        <Route path="rosca" element={<Rosca />} />
        <Route path="p2p" element={<P2p />} />
        <Route path="admin" element={<Admin />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="referrals" element={<Referrals />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}