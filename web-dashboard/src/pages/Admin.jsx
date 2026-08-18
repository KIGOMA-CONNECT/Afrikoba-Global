import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';

export default function Admin() {
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
        <h2>Utawala (Super Admin)</h2>
        <p>Usimamizi wa watumiaji, miamala na mapato ya mfumo</p>
      </div>

      {stats && (
        <div className="grid grid-4" style={{ marginBottom: 20 }}>
          <div className="card stat"><div className="value">{stats.users}</div><div className="label">Watumiaji</div></div>
          <div className="card stat"><div className="value">{formatMoney(stats.revenue.total_commission)}</div><div className="label">Kamisheni (1%)</div></div>
          <div className="card stat"><div className="value">{formatMoney(stats.revenue.total_platform_fees)}</div><div className="label">Ada za Jukwaa (2%)</div></div>
          <div className="card stat"><div className="value">{formatMoney(stats.revenue.total_maintenance_fees)}</div><div className="label">Ada za VICOBA</div></div>
        </div>
      )}

      <div className="card section">
        <h3>Watumiaji Wote</h3>
        <table>
          <thead><tr><th>ID</th><th>Jina</th><th>Simu</th><th>Email</th><th>Wajibu</th><th>KYC</th><th>Salio</th><th>Trust</th></tr></thead>
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
        <h3>Miamala Yote ya Mfumo</h3>
        <table>
          <thead><tr><th>Ref</th><th>Mteja</th><th>Aina</th><th>Kiasi</th><th>Ada</th><th>Hali</th><th>Tarehe</th></tr></thead>
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
