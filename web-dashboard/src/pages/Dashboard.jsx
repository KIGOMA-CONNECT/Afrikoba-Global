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
  const [health, setHealth] = useState(null);

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
      api.get('/banking/analytics/health').then((r) => setHealth(r.data.health)).catch(() => {});
    }
  }, [isAdmin]);

  return (
    <>
      <div className="page-head">
        <h2>{isAdmin ? t('dashboard.welcome_admin', { name: user.full_name }) : t('dashboard.welcome_user', { name: user.full_name })}</h2>
        <p>{isAdmin ? t('dashboard.admin_summary') : t('dashboard.user_summary')}</p>
      </div>

      {isAdmin && !stats && (
        <div className="grid grid-3">
          {[1,2,3,4,5,6].map((i) => (
            <div className="card stat" key={i} style={{ opacity: 0.5 }}>
              <div className="value" style={{ background: 'var(--border)', borderRadius: 6, width: 80, height: 28, margin: '0 auto' }}>&nbsp;</div>
              <div className="label" style={{ background: 'var(--border)', borderRadius: 4, width: 60, height: 12, margin: '8px auto 0' }}>&nbsp;</div>
            </div>
          ))}
        </div>
      )}

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

      {!isAdmin && !balance && (
        <div className="grid grid-3">
          {[1,2,3].map((i) => (
            <div className="card stat" key={i} style={{ opacity: 0.5 }}>
              <div className="value" style={{ background: 'var(--border)', borderRadius: 6, width: 120, height: 28, margin: '0 auto' }}>&nbsp;</div>
              <div className="label" style={{ background: 'var(--border)', borderRadius: 4, width: 80, height: 12, margin: '8px auto 0' }}>&nbsp;</div>
            </div>
          ))}
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

      {!isAdmin && health && (
        <div className="card section" style={{ marginTop: 24 }}>
          <h3>{t('health.title')}</h3>
          <div className="grid grid-4" style={{ marginTop: 12, marginBottom: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <div className="card stat" style={{ padding: 12, textAlign: 'center' }}>
              <span className="label" style={{ fontSize: 11 }}>{t('health.income')}</span>
              <strong style={{ display: 'block', fontSize: 16, marginTop: 4 }}>{formatMoney(health.total_income)}</strong>
            </div>
            <div className="card stat" style={{ padding: 12, textAlign: 'center' }}>
              <span className="label" style={{ fontSize: 11 }}>{t('health.expenses')}</span>
              <strong style={{ display: 'block', fontSize: 16, marginTop: 4, color: '#dc2626' }}>{formatMoney(health.total_expenses)}</strong>
            </div>
            <div className="card stat" style={{ padding: 12, textAlign: 'center' }}>
              <span className="label" style={{ fontSize: 11 }}>{t('health.net_flow')}</span>
              <strong style={{ display: 'block', fontSize: 16, marginTop: 4, color: Number(health.net_flow) >= 0 ? 'var(--green)' : '#dc2626' }}>{formatMoney(health.net_flow)}</strong>
            </div>
            <div className="card stat" style={{ padding: 12, textAlign: 'center' }}>
              <span className="label" style={{ fontSize: 11 }}>{t('health.savings_rate')}</span>
              <strong style={{ display: 'block', fontSize: 16, marginTop: 4, color: Number(health.savings_rate) >= 20 ? 'var(--green)' : '#d97706' }}>{health.savings_rate}%</strong>
            </div>
          </div>

          {Number(health.net_flow) < 0 ? (
            <div className="alert" style={{ background: '#fef2f2', border: '1px solid #fecaca', padding: '12px 16px', borderRadius: 10, color: '#991b1b' }}>
              <strong>{t('health.recommend')}:</strong> {t('health.rec_negative', { expenses: formatMoney(health.total_expenses), income: formatMoney(health.total_income) })}
            </div>
          ) : Number(health.savings_rate) >= 20 ? (
            <div className="alert" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '12px 16px', borderRadius: 10, color: '#166534' }}>
              <strong>{t('health.recommend')}:</strong> {t('health.rec_excellent', { rate: health.savings_rate })}
            </div>
          ) : Number(health.savings_rate) >= 5 ? (
            <div className="alert" style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: '12px 16px', borderRadius: 10, color: '#92400e' }}>
              <strong>{t('health.recommend')}:</strong> {t('health.rec_good', { rate: health.savings_rate })}
            </div>
          ) : (
            <div className="alert" style={{ background: '#fef2f2', border: '1px solid #fecaca', padding: '12px 16px', borderRadius: 10, color: '#991b1b' }}>
              <strong>{t('health.recommend')}:</strong> {t('health.rec_poor', { rate: health.savings_rate })}
            </div>
          )}
        </div>
      )}
    </>
  );
}