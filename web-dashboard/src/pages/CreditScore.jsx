import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

function ScoreGauge({ score, color }) {
  const r = 70;
  const circumference = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(850, score)) / 850;
  const offset = circumference * (1 - filled);

  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <div style={{ position: 'relative', width: 180, height: 180, margin: '8px auto' }}>
        <svg width="180" height="180" viewBox="0 0 180 180">
          <circle cx="90" cy="90" r={r} fill="none" stroke="#e8ece8" strokeWidth="14" />
          <circle
            cx="90" cy="90" r={r} fill="none"
            stroke={color} strokeWidth="14" strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
            transform="rotate(-90 90 90)"
            style={{ transition: 'stroke-dashoffset 0.8s ease' }}
          />
        </svg>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}>
          <strong style={{ fontSize: 42, fontWeight: 900, color: '#0f172a', lineHeight: 1 }}>{score}</strong>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>/ 850</span>
        </div>
      </div>
    </div>
  );
}

export default function CreditScore() {
  const { t } = useT();
  const [passport, setPassport] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const load = (silent) => {
    api.get('/passport')
      .then((r) => setPassport(r.data.passport))
      .catch(() => { if (!silent) setMsg({ type: 'err', text: t('credit.error') }); });
  };

  useEffect(() => { load(true); }, []);

  const recalc = async () => {
    try {
      const res = await api.post('/passport/recalculate');
      setPassport(res.data.passport);
      setMsg({ type: 'ok', text: t('credit.recalc_ok') });
      setTimeout(() => setMsg({ type: '', text: '' }), 3000);
    } catch (e) {
      setMsg({ type: 'err', text: e.response?.data?.message || t('credit.error') });
    }
  };

  if (!passport) {
    return (
      <>
        <div className="page-head"><h2>{t('credit.title')}</h2><p>{t('credit.sub')}</p></div>
        <div className="card"><p className="roles-tag">{t('credit.loading')}</p></div>
      </>
    );
  }

  const cap = passport.capacity || {};
  const ident = passport.identity || {};
  const beh = passport.behaviour || {};
  const ratingColor = passport.color || '#4CAF50';
  const behaviorText = t('credit.behaviour_meta', {
    s: beh.savings ?? 0, r: beh.repayment ?? 0, g: beh.groups ?? 0, t: beh.regularity ?? 0,
  });

  const pillars = [
    { key: 'p_identity', sub: 'identity_sub', score: ident.confidence ?? 0, icon: '🪪', color: '#0b7a41' },
    { key: 'p_behaviour', sub: 'behaviour_sub', value: behaviorText, icon: '📈', color: '#155e9c' },
    { key: 'p_capacity', sub: 'capacity_sub', money: cap.disposable ?? 0, icon: '🏦', color: '#d97706' },
  ];

  return (
    <>
      <div className="page-head">
        <h2>{t('credit.title')}</h2>
        <p>{t('credit.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <ScoreGauge score={passport.afrikobaScore} color={ratingColor} />
        <div className="card">
          <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{passport.label || passport.label_sw}</h3>
            <span className="roles-tag">{t('credit.version', { v: passport.version ?? 1 })}</span>
          </div>
          <p className="roles-tag" style={{ marginTop: 8 }}>{t('credit.calculated', { date: new Date(passport.calculatedAt).toLocaleString('en-GB') })}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <span className={`badge ${ident.phoneVerified ? 'success' : 'info'}`}>📱 {t('credit.phone')}: {ident.phoneVerified ? t('credit.verified') : t('credit.not_verified')}</span>
            <span className={`badge ${ident.nidaPresent ? 'success' : 'info'}`}>🪪 {t('credit.nida')}: {ident.nidaPresent ? t('credit.verified') : t('credit.not_verified')}</span>
            <span className="badge info">{t('credit.kpc', { level: ident.kycLevel ?? 0 })}</span>
            <span className="badge info">{t('credit.age_days', { days: ident.accountAgeDays ?? 0 })}</span>
          </div>
          <button className="btn" style={{ marginTop: 16 }} onClick={recalc}>{t('credit.recalc')}</button>
        </div>
        <div className="card">
          <h3>{t('credit.pillars')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pillars.map((p) => (
              <div key={p.key} className="inline-actions" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <div>
                  <strong style={{ fontSize: 13 }}>{p.icon} {t(`credit.${p.key}`)}</strong>
                  <div className="roles-tag" style={{ fontSize: 11 }}>{p.value || (p.money !== undefined ? formatMoney(p.money) : `${p.score}/100`)}</div>
                </div>
                <span className="roles-tag" style={{ fontSize: 11, color: 'var(--muted)' }}>{t(`credit.${p.sub}`)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-2 section">
        <div className="card">
          <h3>{t('credit.capacity_title')}</h3>
          <table>
            <tbody>
              <tr><td>{t('credit.incomes')}</td><td><strong>{formatMoney(cap.monthlyIncome ?? 0)}</strong></td></tr>
              <tr><td>{t('credit.cashflow')}</td><td>{formatMoney(cap.cashflow ?? 0)}</td></tr>
              <tr><td>{t('credit.obligations')}</td><td>{formatMoney(cap.obligations ?? 0)}</td></tr>
              <tr><td>{t('credit.disposable')}</td><td><strong style={{ color: 'var(--green)' }}>{formatMoney(cap.disposable ?? 0)}</strong></td></tr>
            </tbody>
          </table>
          {(passport.triggers && passport.triggers.length > 0) ? (
            <>
              <h3 style={{ marginTop: 18 }}>{t('credit.triggers')}</h3>
              <ul style={{ paddingLeft: 18, fontSize: 13, color: 'var(--muted)', lineHeight: 1.8 }}>
                {passport.triggers.map((tr, i) => <li key={i}>{tr}</li>)}
              </ul>
            </>
          ) : (
            <p className="roles-tag" style={{ marginTop: 14 }}>{t('credit.empty_triggers')}</p>
          )}
        </div>

        <div className="card">
          <h3>{t('credit.dimensions')}</h3>
          <p className="roles-tag" style={{ marginBottom: 10 }}>{t('credit.dim_hint')}</p>
          <table>
            <thead>
              <tr>
                <th>{t('credit.dimension')}</th>
                <th>{t('credit.band')}</th>
                <th>{t('credit.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {(passport.dimensions || []).map((d, i) => (
                <tr key={i}>
                  <td>{d.dimension}</td>
                  <td><span className="badge info">{d.band}</span></td>
                  <td style={{ fontSize: 12, color: 'var(--muted)' }}>{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
