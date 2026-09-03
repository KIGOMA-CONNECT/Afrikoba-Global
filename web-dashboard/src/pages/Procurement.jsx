import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

function money(v) {
  return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function Procurement() {
  const { t } = useT();
  const [tab, setTab] = useState('marketplace');
  const [requests, setRequests] = useState([]);
  const [mine, setMine] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [financing, setFinancing] = useState([]);
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [supForm, setSupForm] = useState({ business_name: '', category: '', description: '' });
  const [reqForm, setReqForm] = useState({ title: '', description: '', category: '', quantity: '1', budget_cap: '', deadline: '' });
  const [bidForm, setBidForm] = useState({ amount: '', delivery_days: '', note: '' });
  const [finForm, setFinForm] = useState({ amount: '', term_months: '', annual_rate: '10', supplier_id: '' });
  const [activeReq, setActiveReq] = useState(null);

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('proc.error') });
  const ok = (text) => { setMsg({ type: 'ok', text }); };

  const load = () => {
    api.get('/procurement/requests').then((r) => setRequests(r.data.requests || [])).catch(() => {});
    api.get('/procurement/requests', { params: { mine: true } }).then((r) => setMine(r.data.requests || [])).catch(() => {});
    api.get('/procurement/suppliers').then((r) => setSuppliers(r.data.suppliers || [])).catch(() => {});
    api.get('/procurement/financing').then((r) => setFinancing(r.data.financing || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const registerSupplier = async (e) => {
    e.preventDefault();
    try {
      await api.post('/procurement/suppliers', supForm);
      ok(t('proc.supplier_ok'));
      setSupForm({ business_name: '', category: '', description: '' });
      load();
    } catch (err) { error(err); }
  };

  const createRequest = async (e) => {
    e.preventDefault();
    try {
      await api.post('/procurement/requests', reqForm);
      ok(t('proc.request_ok'));
      setReqForm({ title: '', description: '', category: '', quantity: '1', budget_cap: '', deadline: '' });
      load();
    } catch (err) { error(err); }
  };

  const publishRequest = async (id) => {
    try {
      await api.post(`/procurement/requests/${id}/publish`);
      ok(t('proc.published_ok'));
      load();
    } catch (err) { error(err); }
  };

  const showDetail = async (id) => {
    try {
      const r = await api.get(`/procurement/requests/${id}`);
      setDetail(r.data);
      setActiveReq(id);
      setBidForm({ amount: '', delivery_days: '', note: '' });
    } catch (err) { error(err); }
  };

  const submitBid = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/procurement/requests/${activeReq}/bids`, bidForm);
      ok(t('proc.bid_ok'));
      showDetail(activeReq);
      load();
    } catch (err) { error(err); }
  };

  const award = async (reqId, bidId) => {
    try {
      await api.post(`/procurement/requests/${reqId}/award/${bidId}`);
      ok(t('proc.award_ok'));
      showDetail(reqId);
      load();
    } catch (err) { error(err); }
  };

  const requestFinancing = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/procurement/financing', { ...finForm, unique_reference: `sfin-web-${Date.now()}` });
      ok(`${t('proc.financing_ok')} ${r.data.financing_id}`);
      setFinForm({ amount: '', term_months: '', annual_rate: '10', supplier_id: '' });
      load();
    } catch (err) { error(err); }
  };

  const tabs = [
    { id: 'marketplace', label: t('proc.marketplace_tab') },
    { id: 'myrequests', label: t('proc.myrequests_tab') },
    { id: 'myfinancing', label: t('proc.financing_tab') },
  ];

  return (
    <div>
      <div className="page-head">
        <h2>🛒 {t('proc.title')}</h2>
        <p>{t('proc.sub')}</p>
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

      {tab === 'marketplace' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 16, marginBottom: 18 }}>
            {/* Register supplier */}
            <div className="card">
              <h3 style={{ margin: '0 0 12px' }}>{t('proc.register_supplier')}</h3>
              <form onSubmit={registerSupplier} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label>{t('proc.business_name')}<input value={supForm.business_name} onChange={(e) => setSupForm({ ...supForm, business_name: e.target.value })} required /></label>
                <label>{t('proc.category')}<input value={supForm.category} onChange={(e) => setSupForm({ ...supForm, category: e.target.value })} /></label>
                <label>{t('proc.description')}<textarea rows="2" value={supForm.description} onChange={(e) => setSupForm({ ...supForm, description: e.target.value })} /></label>
                <button className="btn" type="submit">{t('proc.register')}</button>
              </form>
            </div>
            {/* Supplier directory */}
            <div className="card">
              <h3 style={{ margin: '0 0 12px' }}>{t('proc.supplier_dir')}</h3>
              {suppliers.length === 0 && <p className="roles-tag">{t('proc.no_supplier')}</p>}
              {suppliers.map((s) => (
                <div key={s.id} className="card" style={{ marginBottom: 10, padding: 12 }}>
                  <strong>{s.business_name}</strong> <span className={`badge ${s.verified ? 'success' : 'warning'}`}>{s.verified ? t('proc.verified') : t('proc.pending')}</span>
                  <div className="roles-tag" style={{ margin: '4px 0 0' }}>{s.category || '—'} · ⭐ {Number(s.rating) || 0}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Create RFQ */}
          <div className="card" style={{ marginBottom: 18 }}>
            <h3 style={{ margin: '0 0 12px' }}>{t('proc.new_request')}</h3>
            <form onSubmit={createRequest} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
              <label style={{ gridColumn: '1 / -1' }}>{t('proc.req_title')}<input value={reqForm.title} onChange={(e) => setReqForm({ ...reqForm, title: e.target.value })} required /></label>
              <label style={{ gridColumn: '1 / -1' }}>{t('proc.description')}<textarea rows="2" value={reqForm.description} onChange={(e) => setReqForm({ ...reqForm, description: e.target.value })} /></label>
              <label>{t('proc.category')}<input value={reqForm.category} onChange={(e) => setReqForm({ ...reqForm, category: e.target.value })} /></label>
              <label>{t('proc.quantity')}<input type="number" value={reqForm.quantity} onChange={(e) => setReqForm({ ...reqForm, quantity: e.target.value })} /></label>
              <label>{t('proc.budget_cap')}<input type="number" value={reqForm.budget_cap} onChange={(e) => setReqForm({ ...reqForm, budget_cap: e.target.value })} /></label>
              <label>{t('proc.deadline')}<input type="date" value={reqForm.deadline} onChange={(e) => setReqForm({ ...reqForm, deadline: e.target.value })} /></label>
              <div style={{ gridColumn: '1 / -1' }}><button className="btn" type="submit">{t('proc.create')}</button></div>
            </form>
          </div>

          {/* Request marketplace */}
          <div className="card">
            <h3 style={{ margin: '0 0 14px' }}>{t('proc.marketplace_tab')}</h3>
            {requests.length === 0 ? (
              <p className="roles-tag">{t('proc.no_requests')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('proc.title')}</th>
                      <th>{t('proc.category')}</th>
                      <th>{t('proc.qty')}</th>
                      <th>{t('proc.budget_cap')}</th>
                      <th>{t('proc.deadline')}</th>
                      <th>{t('proc.status')}</th>
                      <th>{t('proc.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{r.title}</strong></td>
                        <td>{r.category || '—'}</td>
                        <td>{money(r.quantity)}</td>
                        <td>{money(r.budget_cap)}</td>
                        <td>{r.deadline ? new Date(r.deadline).toLocaleDateString() : '—'}</td>
                        <td><span className="badge info">{r.status}</span></td>
                        <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => showDetail(r.id)}>{t('proc.bid')}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {detail && (
              <div style={{ marginTop: 18, borderTop: '1px solid #e2e8f0', paddingTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ margin: 0 }}>{detail.request.title}</h4>
                  <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setDetail(null)}>{t('proc.close')}</button>
                </div>
                <p className="roles-tag" style={{ margin: '8px 0 0' }}>{detail.request.description || ''}</p>
                {['OPEN', 'ACCEPTING_BIDS'].includes(detail.request.status) && (
                  <form onSubmit={submitBid} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginTop: 14 }}>
                    <label>{t('proc.amount')}<input type="number" value={bidForm.amount} onChange={(e) => setBidForm({ ...bidForm, amount: e.target.value })} required /></label>
                    <label>{t('proc.delivery_days')}<input type="number" value={bidForm.delivery_days} onChange={(e) => setBidForm({ ...bidForm, delivery_days: e.target.value })} /></label>
                    <label style={{ gridColumn: '1 / -1' }}>{t('proc.note')}<input value={bidForm.note} onChange={(e) => setBidForm({ ...bidForm, note: e.target.value })} /></label>
                    <div style={{ gridColumn: '1 / -1' }}><button className="btn" type="submit">{t('proc.submit_bid')}</button></div>
                  </form>
                )}
                <h5 style={{ margin: '16px 0 8px' }}>{t('proc.bids')} ({detail.bids.length})</h5>
                {detail.bids.length === 0 ? <p className="roles-tag">{t('proc.no_bids')}</p> : (
                  <table className="table">
                    <thead><tr><th>{t('proc.supplier')}</th><th>{t('proc.amount')}</th><th>{t('proc.delivery_days')}</th><th>{t('proc.status')}</th><th>{t('proc.actions')}</th></tr></thead>
                    <tbody>
                      {detail.bids.map((b) => (
                        <tr key={b.id}>
                          <td>{b.business_name}</td>
                          <td>{money(b.amount)}</td>
                          <td>{b.delivery_days ?? '—'}</td>
                          <td><span className="badge info">{b.status}</span></td>
                          <td>
                            {detail.request.buyer_user_id === detail.request.buyer_user_id && detail.request.status === 'ACCEPTING_BIDS' && b.status === 'PENDING' && (
                              <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => award(detail.request.id, b.id)}>{t('proc.award')}</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'myrequests' && (
        <div className="card">
          <h3 style={{ margin: '0 0 14px' }}>{t('proc.myrequests_tab')}</h3>
          {mine.length === 0 ? (
            <p className="roles-tag">{t('proc.no_requests')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('proc.title')}</th>
                    <th>{t('proc.category')}</th>
                    <th>{t('proc.budget_cap')}</th>
                    <th>{t('proc.status')}</th>
                    <th>{t('proc.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.title}</strong></td>
                      <td>{r.category || '—'}</td>
                      <td>{money(r.budget_cap)}</td>
                      <td><span className="badge info">{r.status}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {r.status === 'DRAFT' && <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => publishRequest(r.id)}>{t('proc.publish')}</button>}
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => showDetail(r.id)}>{t('proc.view')}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'myfinancing' && (
        <div>
          <div className="card" style={{ marginBottom: 18 }}>
            <h3 style={{ margin: '0 0 12px' }}>{t('proc.finance_request')}</h3>
            <form onSubmit={requestFinancing} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
              <label>{t('proc.supplier')}
                <select value={finForm.supplier_id} onChange={(e) => setFinForm({ ...finForm, supplier_id: e.target.value })} required>
                  <option value=""></option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.business_name}</option>)}
                </select>
              </label>
              <label>{t('proc.amount')}<input type="number" value={finForm.amount} onChange={(e) => setFinForm({ ...finForm, amount: e.target.value })} required /></label>
              <label>{t('proc.term_months')}<input type="number" value={finForm.term_months} onChange={(e) => setFinForm({ ...finForm, term_months: e.target.value })} /></label>
              <label>{t('proc.annual_rate')}<input type="number" value={finForm.annual_rate} onChange={(e) => setFinForm({ ...finForm, annual_rate: e.target.value })} /></label>
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'flex-end' }}><button className="btn" type="submit">{t('proc.finance_apply')}</button></div>
            </form>
          </div>

          <div className="card">
            <h3 style={{ margin: '0 0 14px' }}>{t('proc.financing_history')}</h3>
            {financing.length === 0 ? (
              <p className="roles-tag">{t('proc.no_financing')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('proc.supplier')}</th>
                      <th>{t('proc.amount')}</th>
                      <th>{t('proc.term_months')}</th>
                      <th>{t('proc.annual_rate')}</th>
                      <th>{t('proc.status')}</th>
                      <th>{t('proc.ref')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {financing.map((f) => (
                      <tr key={f.id}>
                        <td><strong>{f.business_name}</strong></td>
                        <td>{money(f.amount)}</td>
                        <td>{f.term_months ?? '—'}</td>
                        <td>{f.annual_rate ?? '—'}%</td>
                        <td><span className="badge info">{f.status}</span></td>
                        <td className="roles-tag">{f.unique_reference}</td>
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
