import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function Badge({ status }) {
  const cls = { PENDING: 'warning', APPROVED: 'info', ACTIVE: 'success', COMPLETED: 'success', CANCELLED: 'danger', PROCESSING: 'warning', REJECTED: 'danger' }[status] || 'info';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export default function Network() {
  const { t } = useT();
  const [tab, setTab] = useState('agent');
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [agent, setAgent] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [batches, setBatches] = useState([]);
  const [scheduled, setScheduled] = useState([]);

  // forms
  const [aForm, setAForm] = useState({ business_name: '', owner_name: '', phone: '', email: '', region: '', district: '', ward: '' });
  const [cashForm, setCashForm] = useState({ phone: '', amount: '' });
  const [settleForm, setSettleForm] = useState({ amount: '', type: 'DEPOSIT' });
  const [bulkForm, setBulkForm] = useState({ batch_name: '', description: '', recipients: '' });
  const [schedForm, setSchedForm] = useState({ recipient_phone: '', amount: '', type: 'TRANSFER', description: '', scheduled_for: '', recurrence: 'ONCE' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('network.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); loadLists(); };

  const loadLists = () => {
    api.get('/network/agents/dashboard').then((r) => { setDashboard(r.data.dashboard); }).catch(() => {});
    api.get('/network/bulk').then((r) => setBatches(r.data.batches || [])).catch(() => {});
    api.get('/network/scheduled').then((r) => setScheduled(r.data.scheduled || [])).catch(() => {});
  };

  const checkAgent = () => {
    api.get('/network/agents/dashboard')
      .then((r) => { setDashboard(r.data.dashboard); setAgent(true); })
      .catch((e) => {
        if (e.response?.status === 403) setAgent(false);
      });
  };

  useEffect(() => {
    checkAgent();
    loadLists();
    // eslint-disable-next-line
  }, []);

  const applyAgent = async (e) => {
    e.preventDefault();
    try {
      await api.post('/network/agents/apply', aForm);
      ok(t('network.agent_applied'));
      setAgent(true);
      checkAgent();
    } catch (err) { error(err); }
  };

  const cashIn = async (e) => {
    e.preventDefault();
    try { await api.post('/network/agents/cash-in', cashForm); ok(t('network.cashin_ok')); setCashForm({ phone: '', amount: '' }); }
    catch (err) { error(err); }
  };
  const cashOut = async (e) => {
    e.preventDefault();
    try { await api.post('/network/agents/cash-out', cashForm); ok(t('network.cashout_ok')); setCashForm({ phone: '', amount: '' }); }
    catch (err) { error(err); }
  };
  const settle = async (e) => {
    e.preventDefault();
    try { await api.post('/network/agents/settlement', settleForm); ok(t('network.settlement_ok')); setSettleForm({ amount: '', type: 'DEPOSIT' }); }
    catch (err) { error(err); }
  };

  const createBulk = async (e) => {
    e.preventDefault();
    try {
      const lines = bulkForm.recipients.split('\n').map((l) => l.trim()).filter(Boolean);
      const recipients = lines.map((l) => {
        const [phone, amount, ...rest] = l.split(/[\s,]+/);
        return { phone, amount: Number(amount), name: rest.join(' ') || null };
      });
      await api.post('/network/bulk', { batch_name: bulkForm.batch_name, description: bulkForm.description, recipients });
      ok(t('network.bulk_created'));
      setBulkForm({ batch_name: '', description: '', recipients: '' });
    } catch (err) { error(err); }
  };

  const processBulk = async (id) => {
    try { await api.post(`/network/bulk/${id}/process`); ok(t('network.bulk_processed')); }
    catch (err) { error(err); }
  };

  const createSched = async (e) => {
    e.preventDefault();
    try {
      await api.post('/network/scheduled', schedForm);
      ok(t('network.sched_created'));
      setSchedForm({ recipient_phone: '', amount: '', type: 'TRANSFER', description: '', scheduled_for: '', recurrence: 'ONCE' });
    } catch (err) { error(err); }
  };

  const cancelSched = async (id) => {
    try { await api.delete(`/network/scheduled/${id}`); ok(t('network.sched_cancelled')); }
    catch (err) { error(err); }
  };

  const tabs = [
    { id: 'agent', label: t('network.agent_tab') },
    { id: 'bulk', label: t('network.bulk_tab') },
    { id: 'scheduled', label: t('network.sched_tab') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>{t('network.title')}</h2>
        <p>{t('network.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {tabs.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid #cbd5e1', cursor: 'pointer', fontWeight: 600, background: tab === tb.id ? '#0ea5e9' : '#fff', color: tab === tb.id ? '#fff' : '#334155' }}>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'agent' && (
        <div>
          {!agent ? (
            <div className="card" style={{ maxWidth: 560 }}>
              <h3 style={{ marginBottom: 12 }}>{t('network.agent_apply')}</h3>
              <form onSubmit={applyAgent} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>{t('network.business_name')}<input value={aForm.business_name} onChange={(e) => setAForm({ ...aForm, business_name: e.target.value })} required /></label>
                <label>{t('network.owner_name')}<input value={aForm.owner_name} onChange={(e) => setAForm({ ...aForm, owner_name: e.target.value })} required /></label>
                <label>{t('network.phone')}<input value={aForm.phone} onChange={(e) => setAForm({ ...aForm, phone: e.target.value })} required /></label>
                <label>Email<input value={aForm.email} onChange={(e) => setAForm({ ...aForm, email: e.target.value })} /></label>
                <label>{t('network.region')}<input value={aForm.region} onChange={(e) => setAForm({ ...aForm, region: e.target.value })} /></label>
                <label>{t('network.district')}<input value={aForm.district} onChange={(e) => setAForm({ ...aForm, district: e.target.value })} /></label>
                <label>{t('network.ward')}<input value={aForm.ward} onChange={(e) => setAForm({ ...aForm, ward: e.target.value })} /></label>
                <button className="btn" type="submit">{t('network.agent_submit')}</button>
              </form>
            </div>
          ) : (
            <div>
              {dashboard && (
                <div className="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14, marginBottom: 24 }}>
                  <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('network.balance')}</p><h3 style={{ margin: 0, marginTop: 4 }}>{money(dashboard.balance)}</h3></div>
                  <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('network.commission')}</p><h3 style={{ margin: 0, marginTop: 4 }}>{money(dashboard.commission_earned)}</h3></div>
                  <div className="card" style={{ padding: 18 }}><p className="roles-tag" style={{ margin: 0 }}>{t('network.txn_count')}</p><h3 style={{ margin: 0, marginTop: 4 }}>{dashboard.transaction_count ?? 0}</h3></div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16, marginBottom: 24 }}>
                <div className="card">
                  <h3 style={{ marginBottom: 12 }}>{t('network.cash_in')}</h3>
                  <form onSubmit={cashIn} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label>{t('network.phone')}<input value={cashForm.phone} onChange={(e) => setCashForm({ ...cashForm, phone: e.target.value })} required /></label>
                    <label>{t('network.amount')}<input type="number" value={cashForm.amount} onChange={(e) => setCashForm({ ...cashForm, amount: e.target.value })} required /></label>
                    <button className="btn" type="submit">{t('network.cash_in')}</button>
                  </form>
                </div>
                <div className="card">
                  <h3 style={{ marginBottom: 12 }}>{t('network.cash_out')}</h3>
                  <form onSubmit={cashOut} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label>{t('network.phone')}<input value={cashForm.phone} onChange={(e) => setCashForm({ ...cashForm, phone: e.target.value })} required /></label>
                    <label>{t('network.amount')}<input type="number" value={cashForm.amount} onChange={(e) => setCashForm({ ...cashForm, amount: e.target.value })} required /></label>
                    <button className="btn" type="submit">{t('network.cash_out')}</button>
                  </form>
                </div>
                <div className="card">
                  <h3 style={{ marginBottom: 12 }}>{t('network.settlement')}</h3>
                  <form onSubmit={settle} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label>{t('network.amount')}<input type="number" value={settleForm.amount} onChange={(e) => setSettleForm({ ...settleForm, amount: e.target.value })} required /></label>
                    <label>{t('network.settle_type')}
                      <select value={settleForm.type} onChange={(e) => setSettleForm({ ...settleForm, type: e.target.value })}>
                        <option value="DEPOSIT">Deposit</option>
                        <option value="WITHDRAWAL">Withdrawal</option>
                      </select>
                    </label>
                    <button className="btn" type="submit">{t('network.settling')}</button>
                  </form>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'bulk' && (
        <div>
          <div className="card" style={{ marginBottom: 24 }}>
            <h3 style={{ marginBottom: 12 }}>{t('network.bulk_create')}</h3>
            <form onSubmit={createBulk} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>{t('network.batch_name')}<input value={bulkForm.batch_name} onChange={(e) => setBulkForm({ ...bulkForm, batch_name: e.target.value })} required /></label>
              <label>{t('network.batch_desc')}<input value={bulkForm.description} onChange={(e) => setBulkForm({ ...bulkForm, description: e.target.value })} /></label>
              <label>{t('network.recipients')}
                <textarea rows={5} value={bulkForm.recipients} onChange={(e) => setBulkForm({ ...bulkForm, recipients: e.target.value })} placeholder="255700000001 5000 Jina&#10;255700000002 10000" required style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontFamily: 'monospace' }} />
              </label>
              <button className="btn" type="submit">{t('network.bulk_submit')}</button>
            </form>
          </div>

          <h3 style={{ margin: '0 0 14px' }}>{t('network.bulk_yours')}</h3>
          <div className="card">
            {batches.length === 0 ? (
              <p className="roles-tag">{t('network.bulk_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('network.batch_name')}</th>
                      <th>{t('network.bulk_total')}</th>
                      <th>{t('network.bulk_count')}</th>
                      <th>{t('network.status')}</th>
                      <th>{t('network.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id}>
                        <td><strong>{b.batch_name}</strong></td>
                        <td>{money(b.total_amount)}</td>
                        <td>{b.recipient_count}</td>
                        <td><Badge status={b.status} /></td>
                        <td>
                          {b.status === 'PENDING' && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => processBulk(b.id)}>{t('network.process')}</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'scheduled' && (
        <div>
          <div className="card" style={{ marginBottom: 24 }}>
            <h3 style={{ marginBottom: 12 }}>{t('network.sched_create')}</h3>
            <form onSubmit={createSched} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
              <label>{t('network.phone')}<input value={schedForm.recipient_phone} onChange={(e) => setSchedForm({ ...schedForm, recipient_phone: e.target.value })} /></label>
              <label>{t('network.amount')}<input type="number" value={schedForm.amount} onChange={(e) => setSchedForm({ ...schedForm, amount: e.target.value })} required /></label>
              <label>{t('network.sched_date')}<input type="datetime-local" value={schedForm.scheduled_for} onChange={(e) => setSchedForm({ ...schedForm, scheduled_for: e.target.value })} required /></label>
              <label>{t('network.recurrence')}
                <select value={schedForm.recurrence} onChange={(e) => setSchedForm({ ...schedForm, recurrence: e.target.value })}>
                  <option value="ONCE">{t('network.once')}</option>
                  <option value="DAILY">Daily</option>
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </label>
              <label style={{ gridColumn: '1 / -1' }}>{t('network.batch_desc')}<input value={schedForm.description} onChange={(e) => setSchedForm({ ...schedForm, description: e.target.value })} /></label>
              <div style={{ gridColumn: '1 / -1' }}><button className="btn" type="submit">{t('network.sched_submit')}</button></div>
            </form>
          </div>

          <h3 style={{ margin: '0 0 14px' }}>{t('network.sched_yours')}</h3>
          <div className="card">
            {scheduled.length === 0 ? (
              <p className="roles-tag">{t('network.sched_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('network.phone')}</th>
                      <th>{t('network.amount')}</th>
                      <th>{t('network.sched_date')}</th>
                      <th>{t('network.recurrence')}</th>
                      <th>{t('network.status')}</th>
                      <th>{t('network.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheduled.map((s) => (
                      <tr key={s.id}>
                        <td>{s.recipient_phone || '—'}</td>
                        <td>{money(s.amount)}</td>
                        <td>{new Date(s.scheduled_for).toLocaleString()}</td>
                        <td>{s.recurrence}</td>
                        <td><Badge status={s.status} /></td>
                        <td>
                          {s.status === 'ACTIVE' && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => cancelSched(s.id)}>{t('network.cancel')}</button>
                          )}
                        </td>
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