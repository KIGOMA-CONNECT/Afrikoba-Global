import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Verification() {
  const { t } = useT();
  const storedUser = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const [sellerId, setSellerId] = useState(storedUser.id || '');
  const [profile, setProfile] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const tierBadge = (tier) => {
    const cls = tier === 'AFRIKOBA_VERIFIED' ? 'success' : tier === 'ESTABLISHED' ? 'pending' : 'info';
    const label = tier === 'AFRIKOBA_VERIFIED' ? t('ver.tier_verified') : tier === 'ESTABLISHED' ? t('ver.tier_established') : t('ver.tier_unverified');
    return <span className={`badge ${cls}`}>{label}</span>;
  };

  const check = async (id) => {
    const target = id || sellerId;
    if (!target) { setMsg({ type: 'err', text: t('ver.error_noid') }); return; }
    try {
      const res = await api.get(`/v1/marketplace/sellers/${encodeURIComponent(target)}/verify`);
      setProfile(res.data);
      setMsg({ type: '', text: '' });
    } catch (err) {
      setMsg({ type: 'err', text: err.response?.data?.message || t('mkt.err_generic') });
      setProfile(null);
    }
  };

  useEffect(() => {
    if (storedUser.id) check(storedUser.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="page-head">
        <h2>{t('ver.title')}</h2>
        <p>{t('ver.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('ver.check_btn')}</h3>
          <div className="form-row">
            <div className="field">
              <label>Seller ID</label>
              <input type="number" value={sellerId} onChange={(e) => setSellerId(e.target.value)} />
            </div>
            <button className="btn" onClick={() => check(null)}>{t('ver.check_btn')}</button>
          </div>

          {profile && (
            <>
              <div className="stat" style={{ textAlign: 'center', marginTop: 14 }}>
                <div style={{ marginBottom: 6 }}>{tierBadge(profile.tier)}</div>
                <div className="label">
                  {t('ver.mytier')}: {profile.factor_count}/5
                  {profile.cached ? ` (${t('ver.cached')})` : ''}
                </div>
              </div>

              <h3 style={{ marginTop: 16 }}>{t('ver.factors')}</h3>
              <ul style={{ paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
                {(profile.factors || []).map((f) => (
                  <li key={f.key}>
                    <strong style={{ color: f.ok ? '#0b5d1e' : '#c0392b' }}>{f.ok ? '✓' : '✗'}</strong>{' '}
                    {f.label} <span className="roles-tag">— {f.detail}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="card">
          <h3>{t('ver.summary')}</h3>
          {profile && profile.summary ? (
            <table>
              <tbody>
                <tr><td>{t('ver.confirmed')}</td><td>{profile.summary.confirmed_orders}</td></tr>
                <tr><td>{t('ver.avg_rating')}</td><td>{profile.summary.avg_rating != null ? Number(profile.summary.avg_rating).toFixed(1) : '—'}</td></tr>
                <tr><td>{t('ver.reviews')}</td><td>{profile.summary.review_count}</td></tr>
                <tr><td>{t('ver.disputes')}</td><td>{profile.summary.open_disputes}</td></tr>
                <tr><td>{t('ver.days')}</td><td>{profile.summary.account_age_days}</td></tr>
              </tbody>
            </table>
          ) : (
            <p className="roles-tag">{t('ver.hint')}</p>
          )}
        </div>
      </div>
    </>
  );
}