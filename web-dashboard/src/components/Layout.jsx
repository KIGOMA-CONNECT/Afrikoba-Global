import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/LangProvider.jsx';

const NAV_GROUPS = [
  {
    groupKey: 'nav.g_dashboard',
    entries: [
      { to: '/dashboard', key: 'nav.dashboard', end: true },
    ],
  },
  {
    groupKey: 'nav.g_finance',
    entries: [
      { to: '/dashboard/wallet', key: 'nav.wallet' },
      {
        submenu: 'nav.s_payments',
        items: [
          { to: '/dashboard/network', key: 'nav.network' },
          { to: '/dashboard/remittance', key: 'nav.remittance' },
        ],
      },
      {
        submenu: 'nav.s_savings',
        items: [
          { to: '/dashboard/savings', key: 'nav.savings' },
          { to: '/dashboard/vaults', key: 'nav.vaults' },
          { to: '/dashboard/challenges', key: 'nav.challenges' },
        ],
      },
      { to: '/dashboard/loans', key: 'nav.loans' },
      { to: '/dashboard/credit', key: 'nav.credit' },
      { to: '/dashboard/budget', key: 'nav.budget' },
      { to: '/dashboard/cards', key: 'nav.cards' },
      { to: '/dashboard/fx', key: 'nav.fx' },
      { to: '/dashboard/banking', key: 'nav.banking' },
    ],
  },
  {
    groupKey: 'nav.g_groups',
    entries: [
      { to: '/dashboard/vicoba', key: 'nav.vicoba', svc: 'VICOBA' },
      { to: '/dashboard/rosca', key: 'nav.rosca', svc: 'ROSCA' },
      { to: '/dashboard/saccos', key: 'nav.saccos' },
      { to: '/dashboard/circles', key: 'nav.circles' },
      { to: '/dashboard/family', key: 'nav.family' },
      { to: '/dashboard/governance', key: 'nav.governance' },
    ],
  },
  {
    groupKey: 'nav.g_market',
    entries: [
      { to: '/dashboard/marketplace', key: 'nav.marketplace' },
      { to: '/dashboard/secondary', key: 'nav.secondary' },
      { to: '/dashboard/financing', key: 'nav.financing' },
      { to: '/dashboard/verification', key: 'nav.verification' },
      { to: '/dashboard/merchant', key: 'nav.merchant' },
      { to: '/dashboard/procurement', key: 'nav.procurement' },
      { to: '/dashboard/disputes', key: 'nav.disputes' },
    ],
  },
  {
    groupKey: 'nav.g_biz',
    entries: [
      { to: '/dashboard/business', key: 'nav.business' },
      { to: '/dashboard/payroll', key: 'nav.payroll', admin: true },
      { to: '/dashboard/bills', key: 'nav.bills' },
      { to: '/dashboard/bill-splits', key: 'nav.bill_splits' },
      { to: '/dashboard/subscriptions', key: 'nav.subscriptions' },
      { to: '/dashboard/insurance', key: 'nav.insurance' },
    ],
  },
  {
    groupKey: 'nav.g_projects',
    entries: [
      { to: '/dashboard/projects', key: 'nav.projects' },
      { to: '/dashboard/p2p', key: 'nav.p2p', svc: 'P2P' },
      { to: '/dashboard/kilimo', key: 'nav.kilimo' },
      { to: '/dashboard/events', key: 'nav.events' },
      { to: '/dashboard/passport', key: 'nav.passport' },
      { to: '/dashboard/rewards', key: 'nav.rewards' },
      { to: '/dashboard/referrals', key: 'nav.referrals' },
    ],
  },
  {
    groupKey: 'nav.g_comm',
    entries: [
      { to: '/dashboard/notifications', key: 'nav.notifications' },
      { to: '/dashboard/chat', key: 'nav.chat' },
      { to: '/dashboard/promotions', key: 'nav.promotions' },
      { to: '/dashboard/support', key: 'nav.support' },
      { to: '/dashboard/reports', key: 'nav.reports' },
      { to: '/dashboard/insights', key: 'nav.insights' },
    ],
  },
  {
    groupKey: 'nav.g_settings',
    entries: [
      { to: '/dashboard/settings', key: 'nav.settings' },
      { to: '/dashboard/services', key: 'nav.services' },
      { to: '/dashboard/kyc', key: 'nav.kyc' },
      { to: '/dashboard/devices', key: 'nav.devices' },
      { to: '/dashboard/security', key: 'nav.security' },
      { to: '/dashboard/offline', key: 'nav.offline' },
      { to: '/dashboard/developer', key: 'nav.developer', roles: ['ADMIN', 'OPERATOR', 'OPS', 'COMPLIANCE', 'SUPPORT', 'DEVELOPER'] },
      {
        submenu: 'nav.s_admin',
        items: [
          { to: '/dashboard/admin', key: 'nav.admin', admin: true },
          { to: '/dashboard/ops', key: 'nav.ops', admin: true },
          { to: '/dashboard/risk', key: 'nav.risk', admin: true },
          { to: '/dashboard/fraud-ops', key: 'nav.fraud_ops', roles: ['ADMIN', 'COMPLIANCE'] },
          { to: '/dashboard/features', key: 'nav.features', admin: true },
          { to: '/dashboard/experiments', key: 'nav.experiments', admin: true },
          { to: '/dashboard/four-eyes', key: 'nav.four_eyes', admin: true },
          { to: '/dashboard/admin/events', key: 'nav.events_admin', admin: true },
          { to: '/dashboard/recurrence', key: 'nav.recurrence', admin: true },
        ],
      },
    ],
  },
];

function isVisible(item, user, activeServices) {
  if (item.admin && user.role !== 'ADMIN') return false;
  if (item.roles && !item.roles.includes(user.role)) return false;
  if (item.svc && !activeServices.includes(item.svc)) return false;
  return true;
}

function leafActive(leaf, pathname) {
  const exact = leaf.end || leaf.to === '/dashboard';
  return exact ? pathname === leaf.to : pathname === leaf.to || pathname.startsWith(`${leaf.to}/`);
}

function findEntryInGroup(group, pathname) {
  const exactLeaf = group.entries.some((e) => {
    if (e.submenu) return e.items.some((i) => leafActive(i, pathname));
    return leafActive(e, pathname);
  });
  const fallback = exactLeaf ? 'exact' : 'prefix';
  for (const e of group.entries) {
    if (e.submenu) {
      const leaf = e.items.find((i) => leafActive(i, pathname) && (fallback === 'exact' ? i.to === pathname || i.end : true));
      if (leaf) return { leaf, submenu: e.submenu };
    } else if (leafActive(e, pathname) && (fallback === 'exact' ? e.to === pathname || e.end : true)) {
      return { leaf: e };
    }
  }
  return null;
}

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang, setLang } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => ({ 'nav.g_dashboard': true }));

  const logout = () => {
    localStorage.removeItem('afrikoba_token');
    localStorage.removeItem('afrikoba_user');
    navigate('/login');
  };

  const activeServices = user.services || [];
  const closeSidebar = () => setSidebarOpen(false);

  const crumbGroup = NAV_GROUPS.find((g) => findEntryInGroup(g, location.pathname));
  const crumb = crumbGroup ? { group: crumbGroup.groupKey, ...findEntryInGroup(crumbGroup, location.pathname) } : null;
  const activeGroup = crumbGroup?.groupKey;

  useEffect(() => {
    if (activeGroup) {
      setOpenGroups((o) => (o[activeGroup] ? o : { ...o, [activeGroup]: true }));
    }
  }, [activeGroup, location.pathname]);

  const toggleGroup = (key) => setOpenGroups((o) => ({ ...o, [key]: !o[key] }));

  const visibleEntries = (entries) =>
    entries
      .map((e) => {
        if (e.submenu) {
          const items = e.items.filter((i) => isVisible(i, user, activeServices));
          return items.length ? { submenu: e.submenu, items } : null;
        }
        return isVisible(e, user, activeServices) ? e : null;
      })
      .filter(Boolean);

  const groups = NAV_GROUPS.map((g) => ({ groupKey: g.groupKey, entries: visibleEntries(g.entries) })).filter(
    (g) => g.entries.length > 0
  );

  const renderLeaf = (item) => (
    <NavLink key={item.to} to={item.to} end={item.end} onClick={closeSidebar} className={({ isActive }) => (isActive ? 'active' : '')}>
      {t(item.key)}
    </NavLink>
  );

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
          {groups.map((g) => {
            const isOpen = !!openGroups[g.groupKey];
            return (
              <div key={g.groupKey} className={`nav-group${isOpen ? ' open' : ''}`}>
                <button type="button" className="nav-group-label" aria-expanded={isOpen} onClick={() => toggleGroup(g.groupKey)}>
                  <span>{t(g.groupKey)}</span>
                  <span className="nav-chevron">{isOpen ? '\u25BE' : '\u25B8'}</span>
                </button>
                {isOpen &&
                  g.entries.map((e) =>
                    e.submenu ? (
                      <div key={e.submenu} className="nav-submenu">
                        <div className="nav-submenu-label">{t(e.submenu)}</div>
                        {e.items.map(renderLeaf)}
                      </div>
                    ) : (
                      renderLeaf(e)
                    )
                  )}
              </div>
            );
          })}
        </nav>
        <div className="lang-switcher">
          <span>{t('lang.label')}:</span>
          <button className={`lang-btn${lang === 'sw' ? ' active' : ''}`} onClick={() => setLang('sw')}>{t('lang.sw')}</button>
          <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')}>{t('lang.en')}</button>
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
        <button className="hamburger" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
        {crumb && (
          <div className="breadcrumb" aria-label="Breadcrumb">
            <span className="bc-crumb">{t(crumb.group)}</span>
            {crumb.submenu && <span className="bc-sep">/</span>}
            {crumb.submenu && <span className="bc-crumb">{t(crumb.submenu)}</span>}
            <span className="bc-sep">/</span>
            <span className="bc-here">{t(crumb.leaf.key)}</span>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}