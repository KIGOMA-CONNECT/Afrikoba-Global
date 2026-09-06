import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const DOC_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE', 'UTILITY_BILL', 'SELFIE'];
const LEVEL_COLOR = { 1: '#8b8b8b', 2: '#0b7a41', 3: '#2563eb' };
const STATUS_COLOR = { PENDING: '#d97706', APPROVED: '#0b7a41', REJECTED: '#dc2626', EXPIRED: '#9f1239' };

const EMPTY_DOC = { document_type: 'NATIONAL_ID', document_url: '', document_number: '', issued_country: 'TZ', expires_at: '' };

export default function Kyc() {
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';
  const { t } = useT();
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [tab, setTab] = useState('mine');
  const [profile, setProfile] = useState({ kyc_level: 1, nida_number: '', residential_address: '', id_document_url: '' });
  const [docForm, setDocForm] = useState(EMPTY_DOC);
  const [docs, setDocs] = useState([]);
  const [pending, setPending] = useState([]);
  const [stats, setStats] = useState({ total: 0, pending: 0, approved: 0, rejected: 0, expired: 0 });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('kyc.error') });
  const flash = (text) => { setMsg({ type: 'ok', text }); setTimeout(() => setMsg({ type: '', text: '' }), 3500); };

  const load = () => {
    api.get('/advanced/kyc/status').then((r) => setProfile({ kyc_level: r.data.kyc_level, nida_number: r.data.nida_number || '', residential_address: r.data.residential_address || '', id_document_url: r.data.id_document_url || '' })).catch(() => {});
    api.get('/advanced/kyc/documents').then((r) => setDocs(r.data.documents)).catch(() => {});
    if (isAdmin) {
      api.get('/advanced/admin/kyc/pending').then((r) => setPending(r.data.documents)).catch(() => {});
      api.get('/advanced/admin/kyc/stats').then((r) => setStats(r.data.stats)).catch(() => {});
    }
  };
  useEffect(() => { load(); }, []);

  const badge = (label, color) => (
    <span className="badge" style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>{label}</span>
  );

  const saveProfile = async () => {
    try {
      const r = await api.post('/advanced/kyc/profile', { nida_number: profile.nida_number, residential_address: profile.residential_address, id_document_url: profile.id_document_url });
      setProfile((p) => ({ ...p, ...r.data.profile }));
      flash(t('kyc.profile_saved'));
    } catch (err) { error(err); }
  };

  const upload = async () => {
    try {
      await api.post('/advanced/kyc/documents', { ...docForm });
      flash(t('kyc.uploaded'));
      setDocForm(EMPTY_DOC);
      load();
    } catch (err) { error(err); }
  };

  const decide = async (id, status) => {
    const reason = status === 'REJECTED' ? (window.prompt(t('kyc.reject_reason_ph'), '') || '') : undefined;
    try {
      await api.put(`/advanced/admin/kyc/${id}/verify`, { status, rejection_reason: reason || null });
      flash(status === 'APPROVED' ? t('kyc.verified') : t('kyc.rejected'));
      load();
    } catch (err) { error(err); }
  };

  const TABS = [
    { key: 'mine', label: t('kyc.tab_mine') },
    { key: 'review', label: t('kyc.tab_review'), admin: true, n: pending.length },
  ].filter((x) => !x.admin || isAdmin);

  return (
    <div>
      <div className="page-head">
        <h2>{t('kyc.title')}</h2>
        <p>{t('kyc.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 24, flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button key={tb.key} className={`btn ${tab === tb.key ? '' : 'btn-secondary'}`} onClick={() => setTab(tb.key)} style={{ fontSize: 13 }}>
            {tb.label}{tb.n != null && tb.n > 0 ? ` (${tb.n})` : ''}
          </button>
        ))}
      </div>

      {tab === 'mine' && (
        <>
          <div className="card section">
            <h3>{t('kyc.identity_title')}</h3>
            <p className="roles-tag">{t('kyc.level')}: {badge(`L${profile.kyc_level}`, LEVEL_COLOR[profile.kyc_level] || LEVEL_COLOR[1])}</p>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: 10 }}>
              <input className="input" placeholder="NIDA #" value={profile.nida_number} onChange={(e) => setProfile({ ...profile, nida_number: e.target.value })} />
              <input className="input" placeholder={t('kyc.address_ph')} value={profile.residential_address} onChange={(e) => setProfile({ ...profile, residential_address: e.target.value })} />
              <input className="input" placeholder={t('kyc.doc_url_ph')} value={profile.id_document_url} onChange={(e) => setProfile({ ...profile, id_document_url: e.target.value })} />
            </div>
            <button className="btn" style={{ marginTop: 10, fontSize: 13 }} onClick={saveProfile}>{t('kyc.save_profile')}</button>
          </div>

          <div className="card section">
            <h3>{t('kyc.docs_title')}</h3>
            {docs.length === 0 && <p className="roles-tag">{t('kyc.no_docs')}</p>}
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr><th>{t('kyc.doc_type')}</th><th>#</th><th>{t('kyc.country')}</th><th>{t('kyc.status')}</th><th>{t('kyc.reason')}</th><th>{t('kyc.submitted')}</th></tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.document_type}</td>
                    <td>{d.document_number || '-'}</td>
                    <td>{d.issued_country}</td>
                    <td>{badge(d.status, STATUS_COLOR[d.status] || STATUS_COLOR.PENDING)}</td>
                    <td>{d.rejection_reason || d.reviewer_note || '-'}</td>
                    <td>{new Date(d.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginTop: 14 }}>
              <select className="input" value={docForm.document_type} onChange={(e) => setDocForm({ ...docForm, document_type: e.target.value })}>
                {DOC_TYPES.map((dt) => <option key={dt} value={dt}>{dt}</option>)}
              </select>
              <input className="input" placeholder={t('kyc.file_url_ph')} value={docForm.document_url} onChange={(e) => setDocForm({ ...docForm, document_url: e.target.value })} />
              <input className="input" placeholder={t('kyc.doc_number_ph')} value={docForm.document_number} onChange={(e) => setDocForm({ ...docForm, document_number: e.target.value })} />
              <input className="input" type="date" value={docForm.expires_at} onChange={(e) => setDocForm({ ...docForm, expires_at: e.target.value })} />
            </div>
            <button className="btn" style={{ marginTop: 10, fontSize: 13 }} onClick={upload}>{t('kyc.upload_btn')}</button>
          </div>
        </>
      )}

      {tab === 'review' && (
<div className="card section">
            <h3>{t('kyc.review_title')}</h3>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={async () => { try { const r = await api.post('/advanced/admin/kyc/sweep'); flash(`Sweep: ${r.data.expired || 0} expired, ${r.data.downgraded || 0} downgraded`); load(); } catch (err) { error(err); } }}>Sweep (expiry)</button>
              <div className="badge" style={{ background: '#2563eb22', color: '#2563eb', border: '1px solid #2563eb55' }}>{t('kyc.pending_q')}: {stats.pending}</div>
              <div className="badge" style={{ background: '#0b7a4122', color: '#0b7a41', border: '1px solid #0b7a4155' }}>{t('kyc.approved_q')}: {stats.approved}</div>
              <div className="badge" style={{ background: '#dc262622', color: '#dc2626', border: '1px solid #dc262655' }}>{t('kyc.rejected_q')}: {stats.rejected}</div>
              <div className="badge" style={{ background: '#9f123922', color: '#9f1239', border: '1px solid #9f123955' }}>Expired: {stats.expired}</div>
              <div className="badge" style={{ background: '#8b8b8b22', color: '#8b8b8b', border: '1px solid #8b8b8b55' }}>{t('kyc.total_q')}: {stats.total}</div>
            </div>
          {pending.length === 0 && <p className="roles-tag">{t('kyc.no_pending')}</p>}
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr><th>ID</th><th>{t('kyc.claimant')}</th><th>{t('kyc.phone')}</th><th>{t('kyc.doc_type')}</th><th>#</th><th>{t('kyc.status')}</th><th>{t('kyc.actions')}</th></tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr key={d.id}>
                  <td>#{d.id}</td>
                  <td>{d.full_name}</td>
                  <td>{d.phone_number}</td>
                  <td>{d.document_type}</td>
                  <td>{d.document_number || '-'}</td>
                  <td>{badge(d.status, STATUS_COLOR[d.status] || STATUS_COLOR.PENDING)}</td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn btn-success" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => decide(d.id, 'APPROVED')}>✓ {t('kyc.approve_btn')}</button>
                    <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => decide(d.id, 'REJECTED')}>✕ {t('kyc.reject_btn')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}