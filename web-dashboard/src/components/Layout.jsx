import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/LangProvider.jsx';

export default function Layout() {
  const navigate = useNavigate();
  const { t, lang, setLang } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');

  const logout = () => {
    localStorage.removeItem('afrikoba_token');
    localStorage.removeItem('afrikoba_user');
    navigate('/login');
  };

  const isAdmin = user.role === 'ADMIN';

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <h1>{t('brand.name')}</h1>
          <p>{t('brand.tagline')}</p>
        </div>
        <nav className="nav">
          <NavLink to="/" end>{t('nav.dashboard')}</NavLink>
          <NavLink to="/wallet">{t('nav.wallet')}</NavLink>
          <NavLink to="/services">{t('nav.services')}</NavLink>
          <NavLink to="/promotions">{t('nav.promotions')}</NavLink>
          <NavLink to="/vicoba">{t('nav.vicoba')}</NavLink>
          <NavLink to="/rosca">{t('nav.rosca')}</NavLink>
          <NavLink to="/p2p">{t('nav.p2p')}</NavLink>
          <NavLink to="/referrals">{t('nav.referrals')}</NavLink>
          <NavLink to="/notifications">{t('nav.notifications')}</NavLink>
          {isAdmin && <NavLink to="/admin">{t('nav.admin')}</NavLink>}
          <NavLink to="/settings">{t('nav.settings')}</NavLink>
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
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}