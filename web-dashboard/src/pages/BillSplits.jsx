import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function BillSplits() {
  const { t } = useT();
  const [tab, setTab] = useState('list');
  const [splits, setSplits] = useState([]);
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [cForm, setCForm] = useState({ title: '', total_amount: '', phones: '' });
  const [payAmount, setPayAmount] = useState('');

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('splits.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); };

  const load = () => {
    api.get('/bill-splits').then((r) => setSplits(r.data.splits || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const openDetail = async (id) => {
    try {
      const r = await api.get(`/bill-splits/${id}`);
      setDetail(r.data);
    } catch (err) { error(err); }
    setTab('detail');
  };

  const create = async (e) => {
    e.preventDefault();
    const participant_phones = cForm.phones.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await api.post('/bill-splits', { title: cForm.title, total_amount: cForm.total_amount, participant_phones });
      ok(t('splits.created'));
      setCForm({ title: '', total_amount: '', phones: '' });
      load();
    } catch (err) { error(err); }
  };

  const pay = async (id) => {
    try {
      await api.post(`/bill-splits/${id}/pay`, { amount: payAmount });
      ok(t('splits.paid_ok'));
      const rd = await api.get(`/bill-splits/${id}`);
      setDetail(rd.data);
      load();
    } catch (err) { error(err); }
  };

  const tabs = [
    { id: 'list', label: t('splits.list_tab') },
    { id: 'create', label: t('splits.create_tab') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>🧾 {t('splits.title')}</h2>
        <p>{t('splits.sub')}</p>
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

      {tab === 'list' && (
        <div className="card">
          <h3 style={{ margin: '0 0 14px' }}>{t('splits.your_splits')}</h3>
          {splits.length === 0 ? (
            <p className="roles-tag">{t('splits.empty')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('splits.title_field')}</th>
                    <th>{t('splits.total')}</th>
                    <th>{t('splits.per_person')}</th>
                    <th>{t('splits.participants')}</th>
                    <th>{t('splits.role')}</th>
                    <th>{t('splits.my_status')}</th>
                    <th>{t('splits.date')}</th>
                    <th>{t('splits.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {splits.map((s) => (
                    <tr key={s.id}>
                      <td><strong>{s.title}</strong></td>
                      <td>{money(s.total_amount)}</td>
                      <td>{money(s.per_person)}</td>
                      <td>{s.split_count}</td>
                      <td><span className={`badge ${s.role === 'CREATOR' ? 'info' : 'warning'}`}>{s.role}</span></td>
                      <td>
                        {s.role === 'PARTICIPANT' ? (
                          <span className={`badge ${s.my_status === 'PAID' ? 'success' : s.my_status === 'PENDING' ? 'warning' : 'danger'}`}>
                            {s.my_status || s.status}
                          </span>
                        ) : (
                          <span className={`badge ${s.status === 'COMPLETED' ? 'success' : 'info'}`}>{s.status}</span>
                        )}
                      </td>
                      <td>{new Date(s.created_at).toLocaleDateString()}</td>
                      <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => openDetail(s.id)}>{t('splits.view')}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'create' && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h3 style={{ margin: '0 0 12px' }}>{t('splits.create_tab')}</h3>
          <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('splits.title_field')}<input value={cForm.title} onChange={(e) => setCForm({ ...cForm, title: e.target.value })} required /></label>
            <label>{t('splits.total')}<input type="number" value={cForm.total_amount} onChange={(e) => setCForm({ ...cForm, total_amount: e.target.value })} required /></label>
            <label>{t('splits.phones')}
              <textarea rows="3" value={cForm.phones} onChange={(e) => setCForm({ ...cForm, phones: e.target.value })} placeholder="0711122233, 0711444555, …" />
              <small className="roles-tag" style={{ marginTop: 4 }}>{t('splits.phones_note')}</small>
            </label>
            <button className="btn" type="submit">{t('splits.create')}</button>
          </form>
        </div>
      )}

      {tab === 'detail' && detail && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>{detail.split.title}</h3>
            <button className="btn btn-secondary" onClick={() => { setTab('list'); setDetail(null); }}>{t('splits.back')}</button>
          </div>
          <p className="roles-tag" style={{ margin: '0 0 16px' }}>
            {t('splits.total')}: <strong>{money(detail.split.total_amount)}</strong> · {t('splits.per_person')}: <strong>{money(detail.split.per_person)}</strong> · {t('splits.participants')}: {detail.split.split_count}
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('splits.name')}</th>
                  <th>{t('splits.phone')}</th>
                  <th>{t('splits.owed')}</th>
                  <th>{t('splits.paid')}</th>
                  <th>{t('splits.status')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.participants.map((p, i) => (
                  <tr key={p.id || i}>
                    <td>{p.name || '—'}</td>
                    <td>{p.phone || '—'}</td>
                    <td>{money(p.amount_owed)}</td>
                    <td>{money(p.amount_paid)}</td>
                    <td><span className={`badge ${p.status === 'PAID' ? 'success' : 'warning'}`}>{p.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); pay(detail.split.id); }} style={{ display: 'flex', gap: 8, marginTop: 16, maxWidth: 360, alignItems: 'flex-end' }}>
            <label style={{ flex: 1 }}>
              {t('splits.pay_amount')}
              <input type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} required />
            </label>
            <button className="btn" type="submit">{t('splits.pay')}</button>
          </form>
        </div>
      )}
    </div>
  );
}