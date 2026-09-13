import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const QUICK_ACTIONS = [
  { to: '/dashboard/wallet', key: 'dash.quick_topup' },
  { to: '/dashboard/wallet', key: 'dash.quick_send' },
  { to: '/dashboard/wallet', key: 'dash.quick_pay' },
  { to: '/dashboard/vicoba', key: 'dash.quick_group' },
  { to: '/dashboard/marketplace', key: 'dash.quick_buy' },
  { to: '/dashboard/projects', key: 'dash.quick_project' },
];

export default function Dashboard() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';
  const [stats, setStats] = useState(null);
  const [balance, setBalance] = useState(null);
  const [showBalance, setShowBalance] = useState(localStorage.getItem('afrikoba_show_balance') !== 'false');
  const [transactions, setTransactions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [health, setHealth] = useState(null);
  const [aiInsights, setAiInsights] = useState([]);

  const toggleBalance = () => {
    const newVal = !showBalance;
    setShowBalance(newVal);
    localStorage.setItem('afrikoba_show_balance', newVal);
  };

  useEffect(() => {
    if (isAdmin) {
      api.get('/admin/dashboard').then((r) => setStats(r.data.stats)).catch(() => {});
      return;
    }
    api.get('/wallet/balance').then((r) => setBalance(r.data.balance)).catch(() => {});
    api.get('/wallet/transactions?limit=6').then((r) => setTransactions(r.data.transactions || [])).catch(() => {});
    api.get('/vicoba/groups').then((r) => setGroups(r.data.groups || [])).catch(() => {});
    api.get('/banking/analytics/health').then((r) => setHealth(r.data.health)).catch(() => {});
    api.get('/ai/insights').then((r) => setAiInsights(r.data.insights || [])).catch(() => {});
  }, [isAdmin]);

  const recent = transactions.slice(0, 6);

  return (
    <>
      <div className="page-head">
        <h2>{isAdmin ? t('dashboard.welcome_admin', { name: user.full_name }) : t('dash.welcome', { name: user.full_name })}</h2>
        <p>{isAdmin ? t('dashboard.admin_summary') : t('dash.sub')}</p>
      </div>

      {isAdmin && stats && (
        <div className="grid grid-3" style={{ marginBottom: 16 }}>
          <div className="card stat"><div className="value">{stats.users}</div><div className="label">{t('dashboard.users')}</div></div>
          <div className="card stat"><div className="value">{stats.transactions.total}</div><div className="label">{t('dashboard.transactions_pending', { count: stats.transactions.pending })}</div></div>
          <div className="card stat"><div className="value">{stats.vicobaGroups}</div><div className="label">{t('dashboard.vicoba_groups')}</div></div>
        </div>
      )}

      {!isAdmin && (
        <div className="grid grid-2" style={{ marginBottom: 16, alignItems: 'stretch' }}>
          <div className="card section" style={{ margin: 0 }}>
            <h3>{t('dash.live')}</h3>
            {!balance && <p className="roles-tag">Inapakia...</p>}
            {balance && (
              <>
                <div className="value" style={{ fontSize: 30, marginTop: 6 }}>
                  {showBalance ? formatMoney(balance.wallet_balance) : 'TZS ***,***'}
                  <span onClick={toggleBalance} style={{ marginLeft: 10, cursor: 'pointer', fontSize: '0.55em', opacity: 0.7 }} title={showBalance ? t('dashboard.hide') : t('dashboard.show')}>{showBalance ? '👁️' : '🙈'}</span>
                </div>
                <div className="label">{t('dashboard.balance')}</div>
                <div className="inline-actions" style={{ marginTop: 10, gap: 14, flexWrap: 'wrap' }}>
                  <span className="roles-tag">{t('dashboard.collateral')}: <strong>{showBalance ? formatMoney(balance.locked_balance) : '***'}</strong></span>
                  <span className="roles-tag">{t('dashboard.currency')}: <strong>{balance.currency_code}</strong></span>
                </div>
              </>
            )}
            <div className="inline-actions" style={{ marginTop: 16, gap: 10, flexWrap: 'wrap' }}>
              {QUICK_ACTIONS.map((qa) => (
                <Link key={qa.key} to={qa.to} className="btn ghost" style={{ textDecoration: 'none' }}>{t(qa.key)}</Link>
              ))}
            </div>
          </div>

          <div className="card section" style={{ margin: 0 }}>
            <h3>{t('dash.groups')} <Link to="/dashboard/vicoba" className="roles-tag" style={{ float: 'right' }}>{t('dash.view_all')}</Link></h3>
            {groups.length === 0 && <p className="roles-tag">{t('vicoba.no_groups')}</p>}
            {groups.slice(0, 5).map((g) => (
              <div key={g.id} className="inline-actions" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <strong>{g.group_name}</strong>
                  <div className="roles-tag">{g.cycle_type} · {t('vicoba.share')} {formatMoney(g.share_value)} · {t('vicoba.members_count')}: {g.members_count || g.total_members_count || '?'}</div>
                </div>
                <Link to="/dashboard/vicoba" className="btn ghost">{t('vicoba.open')}</Link>
              </div>
            ))}
            <div className="inline-actions" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
              <Link to="/dashboard/saccos" className="btn ghost" style={{ textDecoration: 'none' }}>{t('nav.saccos')}</Link>
              <Link to="/dashboard/rosca" className="btn ghost" style={{ textDecoration: 'none' }}>{t('nav.rosca')}</Link>
            </div>
          </div>
        </div>
      )}

      {!isAdmin && (
        <div className="card section">
          <h3>{t('dash.recent')}</h3>
          {recent.length === 0 && <p className="roles-tag">{t('dash.no_recent')}</p>}
          {recent.length > 0 && (
            <table>
              <thead><tr><th>{t('dashboard.type')}</th><th>{t('vicoba.th_loan_status')}</th><th>Kiasi</th><th>Tarehe</th></tr></thead>
              <tbody>
                {recent.map((tr, i) => (
                  <tr key={tr.reference_id || tr.id || i}>
                    <td>{tr.type || '—'}</td>
                    <td><StatusBadge status={tr.status} /></td>
                    <td>{formatMoney(tr.wallet_amount != null ? tr.wallet_amount : tr.amount)}</td>
                    <td>{tr.created_at ? String(tr.created_at).slice(0, 10) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!isAdmin && aiInsights.length > 0 && (
        <div className="card section" style={{ marginTop: 16 }}>
          <h3>{t('dashboard.ai_insights')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            {aiInsights.slice(0, 3).map((ins) => (
              <div key={ins.id} style={{ padding: '12px 16px', borderRadius: 10, borderLeft: `4px solid ${ins.severity === 'alert' ? '#dc2626' : ins.severity === 'warning' ? '#d97706' : ins.severity === 'info' ? '#2563eb' : '#059669'}`, background: '#f8faf9' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 14 }}>{ins.title}</strong>
                  <span className={`badge ${ins.severity === 'alert' ? 'danger' : ins.severity === 'warning' ? 'info' : 'success'}`} style={{ fontSize: 11 }}>{ins.severity}</span>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7a70' }}>{ins.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isAdmin && health && (
        <div className="card section" style={{ marginTop: 16 }}>
          <h3>{t('health.title')}</h3>
          <div className="inline-actions" style={{ gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <span className="badge success">{t('health.income')}: {formatMoney(health.total_income)}</span>
            <span className="badge failed">{t('health.expenses')}: {formatMoney(health.total_expenses)}</span>
            <span className="badge info">{t('health.net_flow')}: {formatMoney(health.net_flow)}</span>
            <span className="badge success">{t('health.savings_rate')}: {health.savings_rate}%</span>
          </div>
        </div>
      )}
    </>
  );
}