import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const TX_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'P2P', 'BILL_PAYMENT', 'AIRTIME', 'SAVINGS_DEPOSIT', 'FIXED_DEPOSIT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'REWARD', 'REFERRAL_BONUS'];

export default function Reports() {
  const { t } = useT();
  const [tab, setTab] = useState('transactions');
  const [filters, setFilters] = useState({ startDate: '', endDate: '', type: '' });
  const [vicoba, setVicoba] = useState([]);
  const [rosca, setRosca] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('reports.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); };

  const loadSummaries = () => {
    api.get('/eco/export/vicoba').then((r) => setVicoba(r.data.summary || [])).catch(() => {});
    api.get('/eco/export/rosca').then((r) => setRosca(r.data.summary || [])).catch(() => {});
  };
  useEffect(() => { loadSummaries(); }, []);

  const exportCSV = async (e) => {
    e.preventDefault();
    const params = new URLSearchParams();
    params.set('format', 'csv');
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    if (filters.type) params.set('type', filters.type);
    try {
      const res = await api.get(`/eco/export/transactions?${params.toString()}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'transactions.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      ok(t('reports.download_started'));
    } catch (err) { error(err); }
  };

  const tabs = [
    { id: 'transactions', label: t('reports.transactions_tab') },
    { id: 'summaries', label: t('reports.summaries_tab') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>📊 {t('reports.title')}</h2>
        <p>{t('reports.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {tabs.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid #cbd5e1', cursor: 'pointer', fontWeight: 600, background: tab === tb.id ? '#0ea5e9' : '#fff', color: tab === tb.id ? '#fff' : '#334155' }}>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'transactions' && (
        <div className="card" style={{ maxWidth: 640 }}>
          <h3 style={{ margin: '0 0 12px' }}>{t('reports.export_transactions')}</h3>
          <form onSubmit={exportCSV} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ flex: 1, minWidth: 160 }}>{t('reports.start')}<input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} /></label>
              <label style={{ flex: 1, minWidth: 160 }}>{t('reports.end')}<input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} /></label>
            </div>
            <label>
              {t('reports.type')}
              <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
                <option value="">{t('reports.all_types')}</option>
                {TX_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
              </select>
            </label>
            <button className="btn" type="submit">⬇ {t('reports.download_csv')}</button>
            <p className="roles-tag" style={{ margin: 0 }}>{t('reports.csv_note')}</p>
          </form>
        </div>
      )}

      {tab === 'summaries' && (
        <div>
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 14px' }}>🏦 {t('reports.vicoba')}</h3>
            {vicoba.length === 0 ? (
              <p className="roles-tag">{t('reports.no_vicoba')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('reports.group')}</th>
                      <th>{t('reports.role')}</th>
                      <th>{t('reports.total_contributed')}</th>
                      <th>{t('reports.shares')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vicoba.map((v, i) => (
                      <tr key={v.group_id || i}>
                        <td><strong>{v.group_name}</strong></td>
                        <td>{v.role}</td>
                        <td>{money(v.total_contributed)}</td>
                        <td>{v.shares_owned}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{ margin: '0 0 14px' }}>🔄 {t('reports.rosca')}</h3>
            {rosca.length === 0 ? (
              <p className="roles-tag">{t('reports.no_rosca')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('reports.pool')}</th>
                      <th>{t('reports.status')}</th>
                      <th>{t('reports.position')}</th>
                      <th>{t('reports.total_contributed')}</th>
                      <th>{t('reports.total_received')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rosca.map((r, i) => (
                      <tr key={r.pool_id || i}>
                        <td><strong>{r.pool_name}</strong></td>
                        <td><span className={`badge ${r.status === 'OPEN' ? 'info' : 'success'}`}>{r.status}</span></td>
                        <td>{r.position}</td>
                        <td>{money(r.total_contributed)}</td>
                        <td>{money(r.total_received)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}