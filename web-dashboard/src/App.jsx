import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Layout from './components/Layout.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

// H20: Offline indicator
function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', handleStatus);
    window.addEventListener('offline', handleStatus);
    return () => {
      window.removeEventListener('online', handleStatus);
      window.removeEventListener('offline', handleStatus);
    };
  }, []);

  if (isOnline) return null;
  return (
    <div style={{ position: 'fixed', bottom: 10, right: 10, background: '#e74c3c', color: 'white', padding: '10px 20px', borderRadius: 5, zIndex: 9999 }}>
      Uko nje ya mtandao.
    </div>
  );
}

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
const ServiceDetail = lazy(() => import('./pages/ServiceDetail.jsx'));
const Marketplace = lazy(() => import('./pages/Marketplace.jsx'));
const Financing = lazy(() => import('./pages/Financing.jsx'));
const Verification = lazy(() => import('./pages/Verification.jsx'));
const CreditScore = lazy(() => import('./pages/CreditScore.jsx'));
const Budget = lazy(() => import('./pages/Budget.jsx'));
const Vaults = lazy(() => import('./pages/Vaults.jsx'));
const Merchant = lazy(() => import('./pages/Merchant.jsx'));
const Cards = lazy(() => import('./pages/Cards.jsx'));
const Subscriptions = lazy(() => import('./pages/Subscriptions.jsx'));
const Family = lazy(() => import('./pages/Family.jsx'));
const Passport = lazy(() => import('./pages/Passport.jsx'));
const Support = lazy(() => import('./pages/Support.jsx'));
const Insurance = lazy(() => import('./pages/Insurance.jsx'));
const Business = lazy(() => import('./pages/Business.jsx'));
const Fx = lazy(() => import('./pages/Fx.jsx'));
const Offline = lazy(() => import('./pages/Offline.jsx'));
const Rewards = lazy(() => import('./pages/Rewards.jsx'));
const Loans = lazy(() => import('./pages/Loans.jsx'));
const Network = lazy(() => import('./pages/Network.jsx'));
const Insights = lazy(() => import('./pages/Insights.jsx'));
const Remittance = lazy(() => import('./pages/Remittance.jsx'));
const Challenges = lazy(() => import('./pages/Challenges.jsx'));
const Bills = lazy(() => import('./pages/Bills.jsx'));
const Banking = lazy(() => import('./pages/Banking.jsx'));

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

function Page({ children }) {
  return <ErrorBoundary><Suspense fallback={<DashboardLoader />}>{children}</Suspense></ErrorBoundary>;
}

export default function App() {
  return (
    <>
      <OfflineIndicator />
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
        <Route index element={<Page><Dashboard /></Page>} />
        <Route path="services" element={<Page><Services /></Page>} />
        <Route path="services/:key" element={<Page><ServiceDetail /></Page>} />
        <Route path="promotions" element={<Page><Promotions /></Page>} />
        <Route path="wallet" element={<Page><Wallet /></Page>} />
        <Route path="vicoba" element={<Page><Vicoba /></Page>} />
        <Route path="rosca" element={<Page><Rosca /></Page>} />
        <Route path="p2p" element={<Page><P2p /></Page>} />
        <Route path="admin" element={<Page><Admin /></Page>} />
        <Route path="notifications" element={<Page><Notifications /></Page>} />
        <Route path="referrals" element={<Page><Referrals /></Page>} />
        <Route path="marketplace" element={<Page><Marketplace /></Page>} />
        <Route path="financing" element={<Page><Financing /></Page>} />
        <Route path="verification" element={<Page><Verification /></Page>} />
        <Route path="credit" element={<Page><CreditScore /></Page>} />
        <Route path="budget" element={<Page><Budget /></Page>} />
        <Route path="vaults" element={<Page><Vaults /></Page>} />
        <Route path="merchant" element={<Page><Merchant /></Page>} />
        <Route path="cards" element={<Page><Cards /></Page>} />
        <Route path="subscriptions" element={<Page><Subscriptions /></Page>} />
        <Route path="family" element={<Page><Family /></Page>} />
        <Route path="passport" element={<Page><Passport /></Page>} />
        <Route path="support" element={<Page><Support /></Page>} />
        <Route path="insurance" element={<Page><Insurance /></Page>} />
        <Route path="business" element={<Page><Business /></Page>} />
        <Route path="fx" element={<Page><Fx /></Page>} />
        <Route path="offline" element={<Page><Offline /></Page>} />
        <Route path="rewards" element={<Page><Rewards /></Page>} />
        <Route path="loans" element={<Page><Loans /></Page>} />
        <Route path="network" element={<Page><Network /></Page>} />
        <Route path="insights" element={<Page><Insights /></Page>} />
        <Route path="remittance" element={<Page><Remittance /></Page>} />
        <Route path="challenges" element={<Page><Challenges /></Page>} />
        <Route path="bills" element={<Page><Bills /></Page>} />
        <Route path="banking" element={<Page><Banking /></Page>} />
        <Route path="settings" element={<Page><Settings /></Page>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}