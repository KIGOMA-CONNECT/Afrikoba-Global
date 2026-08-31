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
          <h1>{t('brand.name')}</h1>
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