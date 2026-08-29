import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const PUBLIC_SITE_URL = 'https://afrikoba.com';

function shareText(svc) {
  const link = `${PUBLIC_SITE_URL}/join?service=${svc.key}`;
  const perks = svc.perks.map((p) => `• ${p}`).join('\n');
  return `${svc.emoji} ${svc.swahili} — AFRIKOBA GLOBAL!\n\n${svc.tagline}\n\n${perks}\n\nJiunge sasa: ${link}`;
}

export default function Promotions() {
  const { t } = useT();
  const [offers, setOffers] = useState([]);
  const [active, setActive] = useState([]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/marketing/offers').then((r) => setOffers(r.data.offers)).catch(() => {});
    api.get('/services/catalog').then((r) => {
      const act = r.data.catalog.filter((s) => s.active).map((s) => s.key);
      setActive(act);
      const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
      user.services = act;
      localStorage.setItem('afrikoba_user', JSON.stringify(user));
    }).catch(() => {});
  }, []);

  const subscribe = async (key) => {
    setMsg('');
    try {
      await api.post('/services/subscribe', { serviceKey: key });
      setMsg('Umejiunga na huduma hii. Karibu!');
      setTimeout(() => {
        api.get('/services/catalog').then((r) => {
          setActive(r.data.catalog.filter((s) => s.active).map((s) => s.key));
        }).catch(() => {});
      }, 700);
    } catch (e) {
      setMsg(e.response?.data?.message || 'Hitilafu.');
    }
  };

  const copyShare = async (svc) => {
    const text = shareText(svc);
    try {
      await navigator.clipboard.writeText(text);
      setMsg(`Ujumbe wa ${svc.swahili} umenakiliwa — tayari kwa SMS/WhatsApp.`);
    } catch {
      setMsg('Haukuweza kunakili. Nakili kwa mkono: ' + text);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>{t('promotions.title')}</h2>
        <p>{t('promotions.sub')}</p>
      </div>

      {msg && <div className={`msg ${msg.includes('Umejiunga') || msg.includes('imenakiliwa') ? 'ok' : 'warn'}`}>{msg}</div>}

      <div className="grid grid-2">
        {offers.map((svc) => {
          const isOn = active.includes(svc.key);
          return (
            <div key={svc.key} className={`card ${!isOn ? 'locked' : ''}`} style={{ borderTop: `4px solid ${svc.color}` }}>
              <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>{svc.emoji} {svc.swahili}</h3>
                <span className={`badge ${isOn ? 'success' : 'info'}`}>{isOn ? 'IMEWASHWA' : 'HAIJAWASHWA'}</span>
              </div>
              <p style={{ fontStyle: 'italic', color: svc.color }}>{svc.tagline}</p>
              <p className="roles-tag">{svc.description}</p>

              <ul style={{ paddingLeft: 18, margin: '10px 0 14px', fontSize: 13, lineHeight: 1.8 }}>
                {svc.perks.map((p, i) => <li key={i}>{p}</li>)}
              </ul>

              <div className="inline-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
                {svc.comingSoon ? (
                  <span className="roles-tag">{svc.cta}</span>
                ) : isOn ? (
                  <span className="badge success">Uko ndani ✓</span>
                ) : (
                  <button className="btn" onClick={() => subscribe(svc.key)}>{svc.cta}</button>
                )}
                <button className="btn ghost" onClick={() => copyShare(svc)}>📣 Nakili Mwaliko</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card section">
        <h3>Kwa nje ya mfumo (API ya Matangazo)</h3>
        <p className="roles-tag">
          Data hizi pia zinapatikana kwa umma kupitia <code>GET /api/marketing/offers</code> - unaweza
          kuzitumia kwenye website, landing pages, banners na adverts bila kuingia mfumo.
        </p>
        <p style={{ fontSize: 13 }}>📣 Share: <strong>Afrikoba Global - Digital Banking & Upatu. {PUBLIC_SITE_URL}</strong></p>
      </div>
    </>
  );
}
