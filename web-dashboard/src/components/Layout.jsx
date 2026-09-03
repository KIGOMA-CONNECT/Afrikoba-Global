import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/LangProvider.jsx';

export default function Layout() {
  const navigate = useNavigate();
  const { t, lang, setLang } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const logout = () => {
    localStorage.removeItem('afrikoba_token');
    localStorage.removeItem('afrikoba_user');
    navigate('/login');
  };

  const isAdmin = user.role === 'ADMIN';
  const activeServices = user.services || [];

  const navItems = [
    { to: '/dashboard', key: 'nav.dashboard', end: true, always: true },
    { to: '/dashboard/wallet', key: 'nav.wallet', always: true },
    { to: '/dashboard/services', key: 'nav.services', always: true },
    { to: '/dashboard/promotions', key: 'nav.promotions', always: true },
    { to: '/dashboard/vicoba', key: 'nav.vicoba', svc: 'VICOBA' },
    { to: '/dashboard/rosca', key: 'nav.rosca', svc: 'ROSCA' },
    { to: '/dashboard/p2p', key: 'nav.p2p', svc: 'P2P' },
    { to: '/dashboard/referrals', key: 'nav.referrals', always: true },
    { to: '/dashboard/marketplace', key: 'nav.marketplace', always: true },
    { to: '/dashboard/financing', key: 'nav.financing', always: true },
    { to: '/dashboard/verification', key: 'nav.verification', always: true },
    { to: '/dashboard/credit', key: 'nav.credit', always: true },
    { to: '/dashboard/budget', key: 'nav.budget', always: true },
    { to: '/dashboard/vaults', key: 'nav.vaults', always: true },
    { to: '/dashboard/merchant', key: 'nav.merchant', always: true },
    { to: '/dashboard/cards', key: 'nav.cards', always: true },
    { to: '/dashboard/subscriptions', key: 'nav.subscriptions', always: true },
    { to: '/dashboard/family', key: 'nav.family', always: true },
    { to: '/dashboard/passport', key: 'nav.passport', always: true },
    { to: '/dashboard/support', key: 'nav.support', always: true },
    { to: '/dashboard/insurance', key: 'nav.insurance', always: true },
    { to: '/dashboard/business', key: 'nav.business', always: true },
    { to: '/dashboard/fx', key: 'nav.fx', always: true },
    { to: '/dashboard/offline', key: 'nav.offline', always: true },
    { to: '/dashboard/rewards', key: 'nav.rewards', always: true },
    { to: '/dashboard/loans', key: 'nav.loans', always: true },
    { to: '/dashboard/network', key: 'nav.network', always: true },
    { to: '/dashboard/insights', key: 'nav.insights', always: true },
    { to: '/dashboard/remittance', key: 'nav.remittance', always: true },
    { to: '/dashboard/challenges', key: 'nav.challenges', always: true },
    { to: '/dashboard/bills', key: 'nav.bills', always: true },
    { to: '/dashboard/banking', key: 'nav.banking', always: true },
    { to: '/dashboard/notifications', key: 'nav.notifications', always: true },
    { to: '/dashboard/admin', key: 'nav.admin', admin: true },
    { to: '/dashboard/settings', key: 'nav.settings', always: true },
  ];

  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="layout">
      {sidebarOpen && <div className="sidebar-overlay" onClick={closeSidebar} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/afrikoba-icon.png" alt="Afrikoba" style={{ width: 32, height: 32, borderRadius: 6 }} onError={(e) => { e.target.style.display = 'none'; }} />
            <h1>{t('brand.name')}</h1>
          </div>
          <p>{t('brand.tagline')}</p>
        </div>
        <nav className="nav">
          {navItems.map((item) => {
            if (item.admin && !isAdmin) return null;
            if (item.svc && !activeServices.includes(item.svc)) return null;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={closeSidebar}
              >
                {t(item.key)}
              </NavLink>
            );
          })}
        </nav>
        <div className="lang-switcher">
          <span>{t('lang.label')}:</span>
          <button
            className={`lang-btn${lang === 'sw' ? ' active' : ''}`}
            onClick={() => setLang('sw')}
          >
            {t('lang.sw')}
          </button>
          <button
            className={`lang-btn${lang === 'en' ? ' active' : ''}`}
            onClick={() => setLang('en')}
          >
            {t('lang.en')}
          </button>
        </div>
        <div className="sidebar-user">
          <strong>{user.full_name}</strong>
          <div className="roles-tag">{user.role}</div>
          <div className="logout" onClick={logout}>{t('nav.logout')}</div>
        </div>
        <div className="footer-badges">
          <div className="badge-item">🔒 <span>SSL 256-bit</span></div>
          <div className="badge-item">🛡️ <span>BOT Regulated</span></div>
          <div className="badge-item">✅ <span>NIDA Verified</span></div>
        </div>
      </aside>
      <main className="content">
        <button className="hamburger" onClick={() => setSidebarOpen(!sidebarOpen)}>
          ☰
        </button>
        <Outlet />
      </main>
    </div>
  );
}