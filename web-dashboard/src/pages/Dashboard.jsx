import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Dashboard() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';
  const [stats, setStats] = useState(null);
  const [balance, setBalance] = useState(null);
  const [showBalance, setShowBalance] = useState(localStorage.getItem('afrikoba_show_balance') !== 'false');
  const [holdings, setHoldings] = useState(null);

  const toggleBalance = () => {
    const newVal = !showBalance;
    setShowBalance(newVal);
    localStorage.setItem('afrikoba_show_balance', newVal);
  };
  const [services, setServices] = useState([]);

  useEffect(() => {
    if (isAdmin) {
      api.get('/admin/dashboard').then((r) => setStats(r.data.stats)).catch(() => {});
    } else {
      api.get('/wallet/balance').then((r) => setBalance(r.data.balance)).catch(() => {});
      api.get('/currency/my-holdings').then((r) => setHoldings(r.data)).catch(() => {});
      api.get('/services/catalog').then((r) => setServices(r.data.catalog)).catch(() => {});
    }
  }, [isAdmin]);

  return (
    <>
      <div className="page-head">
        <h2>{isAdmin ? t('dashboard.welcome_admin', { name: user.full_name }) : t('dashboard.welcome_user', { name: user.full_name })}</h2>
        <p>{isAdmin ? t('dashboard.admin_summary') : t('dashboard.user_summary')}</p>
      </div>

      {isAdmin && stats && (
        <div className="grid grid-3">
          <div className="card stat">
            <div className="value">{stats.users}</div>
            <div className="label">{t('dashboard.users')}</div>
          </div>
          <div className="card stat">
            <div className="value">{stats.transactions.total}</div>
            <div className="label">{t('dashboard.transactions_pending', { count: stats.transactions.pending })}</div>
          </div>
          <div className="card stat">
            <div className="value">{stats.roscaPools}</div>
            <div className="label">{t('dashboard.rosca_pools')}</div>
          </div>
          <div className="card stat">
            <div className="value">{stats.projects}</div>
            <div className="label">{t('dashboard.projects')}</div>
          </div>
          <div className="card stat">
            <div className="value">{stats.vicobaGroups}</div>
            <div className="label">{t('dashboard.vicoba_groups')}</div>
          </div>
          <div className="card stat">
            <div className="value">{formatMoney(stats.revenue.total_commission + stats.revenue.total_platform_fees + stats.revenue.total_maintenance_fees)}</div>
            <div className="label">{t('dashboard.company_revenue')}</div>
          </div>
        </div>
      )}

      {!isAdmin && balance && (
        <div className="grid grid-3">
          <div className="card stat glass-card">
            <div className="value">
              {showBalance ? formatMoney(balance.wallet_balance) : 'TZS ***,***'}
              <span 
                onClick={toggleBalance} 
                style={{ marginLeft: 10, cursor: 'pointer', fontSize: '0.6em', opacity: 0.7 }}
                title={showBalance ? t('dashboard.hide') : t('dashboard.show')}
              >
                {showBalance ? '👁️' : '🙈'}
              </span>
            </div>
            <div className="label">{t('dashboard.balance')}</div>
          </div>
          <div className="card stat">
            <div className="value">{formatMoney(balance.locked_balance)}</div>
            <div className="label">{t('dashboard.collateral')}</div>
          </div>
          <div className="card stat">
            <div className="value">{balance.currency_code}</div>
            <div className="label">{t('dashboard.currency')}</div>
          </div>
        </div>
      )}

      {!isAdmin && holdings && holdings.currencies && holdings.currencies.length > 0 && (
        <div className="card section">
          <h3>{t('dashboard.holdings')}</h3>
          <div className="inline-actions" style={{ gap: 10, flexWrap: 'wrap' }}>
            {holdings.currencies.map((row) => (
              <span key={row.currency} className="badge success">
                {row.currency} {formatMoney(row.balance)} — {t('dashboard.rate_to_tzs')}: {row.rateToTzs ? Number(row.rateToTzs).toFixed(4) : '—'} | {t('dashboard.tzs_value')}: {row.tzsValue ? formatMoney(row.tzsValue) : '—'}
              </span>
            ))}
          </div>
          <p style={{ marginTop: 10, fontSize: 13, color: 'var(--muted)' }}>
            {t('dashboard.portfolio_tzs')}: <strong>{formatMoney(holdings.tzsTotal)}</strong>
          </p>
        </div>
      )}

      {!isAdmin && services.length > 0 && (
        <div className="card section">
          <h3>{t('dashboard.your_services')} <Link to="/dashboard/services" className="roles-tag" style={{ float: 'right' }}>{t('dashboard.manage')}</Link></h3>
          <div className="inline-actions" style={{ gap: 10, flexWrap: 'wrap' }}>
            {services.map((svc) => (
              <span key={svc.key} className={`badge ${svc.active ? 'success' : 'info'}`}>
                {svc.swahili || svc.name} — {svc.active ? t('dashboard.on') : t('dashboard.off')}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}