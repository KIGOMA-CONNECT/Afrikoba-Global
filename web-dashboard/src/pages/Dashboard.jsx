import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';

export default function Dashboard() {
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';
  const [stats, setStats] = useState(null);
  const [balance, setBalance] = useState(null);
  const [services, setServices] = useState([]);

  useEffect(() => {
    if (isAdmin) {
      api.get('/admin/dashboard').then((r) => setStats(r.data.stats)).catch(() => {});
    } else {
      api.get('/wallet/balance').then((r) => setBalance(r.data.balance)).catch(() => {});
      api.get('/services/catalog').then((r) => setServices(r.data.catalog)).catch(() => {});
    }
  }, [isAdmin]);

  return (
    <>
      <div className="page-head">
        <h2>Karibu, {user.full_name}</h2>
        <p>{user.role === 'ADMIN' ? 'Muhtasari wa mfumo mzima' : 'Salio na miamala yako'}</p>
      </div>

      {isAdmin && stats && (
        <div className="grid grid-3">
          <div className="card stat">
            <div className="value">{stats.users}</div>
            <div className="label">Watumiaji</div>
          </div>
          <div className="card stat">
            <div className="value">{stats.transactions.total}</div>
            <div className="label">Miamala ({stats.transactions.pending} PENDING)</div>
          </div>
          <div className="card stat">
            <div className="value">{stats.roscaPools}</div>
            <div className="label">Mizunguko (ROSCA)</div>
          </div>
          <div className="card stat">
            <div className="value">{stats.projects}</div>
            <div className="label">Miradi (P2P)</div>
          </div>
          <div className="card stat">
            <div className="value">{stats.vicobaGroups}</div>
            <div className="label">Vikundi vya VICOBA</div>
          </div>
          <div className="card stat">
            <div className="value">{formatMoney(stats.revenue.total_commission + stats.revenue.total_platform_fees + stats.revenue.total_maintenance_fees)}</div>
            <div className="label">Mapato ya Kampuni</div>
          </div>
        </div>
      )}

      {!isAdmin && balance && (
        <div className="grid grid-3">
          <div className="card stat">
            <div className="value">{formatMoney(balance.wallet_balance)}</div>
            <div className="label">Salio la Wallet</div>
          </div>
          <div className="card stat">
            <div className="value">{formatMoney(balance.locked_balance)}</div>
            <div className="label">Fedha Zilizofungwa (Collateral)</div>
          </div>
          <div className="card stat">
            <div className="value">{balance.currency_code}</div>
            <div className="label">Sarafu</div>
          </div>
        </div>
      )}

      {!isAdmin && services.length > 0 && (
        <div className="card section">
          <h3>Huduma Zako <Link to="/services" className="roles-tag" style={{ float: 'right' }}>Dhibiti →</Link></h3>
          <div className="inline-actions" style={{ gap: 10, flexWrap: 'wrap' }}>
            {services.map((svc) => (
              <span key={svc.key} className={`badge ${svc.active ? 'success' : 'info'}`}>
                {svc.swahili || svc.name} — {svc.active ? 'IMEWASHWA' : 'HAIJAWASHWA'}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
