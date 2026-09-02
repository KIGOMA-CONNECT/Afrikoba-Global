import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Admin() {
  const { t } = useT();
  const [users, setUsers] = useState([]);
  const [txs, setTxs] = useState([]);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    api.get('/admin/users').then((r) => setUsers(r.data.users)).catch(() => {});
    api.get('/admin/transactions').then((r) => setTxs(r.data.transactions)).catch(() => {});
    api.get('/admin/dashboard').then((r) => setStats(r.data.stats)).catch(() => {});
  }, []);

  return (
    <>
      <div className="page-head">
        <h2>{t('admin.title')}</h2>
        <p>{t('admin.sub')}</p>
      </div>

      {stats && (
        <div className="grid grid-4" style={{ marginBottom: 20 }}>
          <div className="card stat"><div className="value">{stats.users}</div><div className="label">{t('admin.users')}</div></div>
          <div className="card stat"><div className="value">{formatMoney(stats.revenue.total_commission)}</div><div className="label">{t('admin.commission')}</div></div>
          <div className="card stat"><div className="value">{formatMoney(stats.revenue.total_platform_fees)}</div><div className="label">{t('admin.platform_fees')}</div></div>
          <div className="card stat"><div className="value">{formatMoney(stats.revenue.total_maintenance_fees)}</div><div className="label">{t('admin.maintenance_fees')}</div></div>
        </div>
      )}

      <div className="card section">
        <h3>{t('admin.all_users')}</h3>
        <table>
          <thead><tr><th>ID</th><th>{t('admin.th_name')}</th><th>{t('admin.th_phone')}</th><th>{t('admin.th_email')}</th><th>{t('admin.th_role')}</th><th>{t('admin.th_kyc')}</th><th>{t('admin.th_balance')}</th><th>{t('admin.th_trust')}</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>{u.full_name}</td>
                <td>{u.phone_number}</td>
                <td>{u.email || '-'}</td>
                <td>{u.role}</td>
                <td>L{u.kyc_level}</td>
                <td>{formatMoney(u.wallet_balance)}</td>
                <td>{u.trust_score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card section">
        <h3>{t('admin.all_transactions')}</h3>
        <table>
          <thead><tr><th>{t('admin.th_ref')}</th><th>{t('admin.th_user')}</th><th>{t('admin.th_type')}</th><th>{t('admin.th_amount')}</th><th>{t('admin.th_fee')}</th><th>{t('admin.th_status')}</th><th>{t('admin.th_date')}</th></tr></thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id}>
                <td>{t.reference_id}</td>
                <td>{t.full_name}<div className="roles-tag">{t.phone_number}</div></td>
                <td>{t.type}</td>
                <td>{formatMoney(t.wallet_amount)}</td>
                <td>{formatMoney(t.commission)}</td>
                <td><StatusBadge status={t.status} /></td>
                <td>{new Date(t.created_at).toLocaleString('en-GB')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
