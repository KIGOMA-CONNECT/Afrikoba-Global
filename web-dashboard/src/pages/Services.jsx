import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

export default function Services() {
  const { t } = useT();
  const [catalog, setCatalog] = useState([]);
  const [msg, setMsg] = useState('');

  const refresh = () => {
    api.get('/services/catalog').then((r) => {
      setCatalog(r.data.catalog);
      const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
      const active = r.data.catalog.filter((s) => s.active).map((s) => s.key);
      user.services = active;
      localStorage.setItem('afrikoba_user', JSON.stringify(user));
    }).catch(() => {});
  };

  useEffect(() => { refresh(); }, []);

  const toggle = async (key, active) => {
    setMsg('');
    try {
      if (active) {
        await api.post('/services/unsubscribe', { serviceKey: key });
      } else {
        await api.post('/services/subscribe', { serviceKey: key });
      }
      setMsg(active ? 'Umeondoka kwenye huduma hiyo.' : 'Umejiunga na huduma hiyo.');
      setTimeout(refresh, 600);
    } catch (e) {
      setMsg(e.response?.data?.message || 'Hitilafu.');
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>{t('services.title')}</h2>
        <p>{t('services.sub')}</p>
      </div>

      {msg && <div className={`msg ${msg.startsWith('Kamilisha') ? 'warn' : 'ok'}`}>{msg}</div>}

      <div className="grid grid-2">
        {catalog.map((svc) => (
          <div key={svc.key} className={`card ${!svc.active ? 'locked' : ''}`}>
            <h3>{svc.swahili || svc.name}</h3>
            <p>{svc.description}</p>
            <div className="roles-tag" style={{ marginBottom: 12 }}>
              {svc.baseService ? 'Huduma ya msingi' : `KYC Level ${svc.requiresKyc} inahitajika`}
              {svc.comingSoon && ' · Inakuja hivi karibuni'}
            </div>
            <div className="inline-actions">
              <span className={`badge ${svc.active ? 'success' : 'info'}`}>
                {svc.active ? 'IMEWASHWA' : 'HAIJAWASHWA'}
              </span>
              {!svc.baseService && !svc.comingSoon && (
                <button
                  className={`btn ${svc.active ? 'ghost' : ''}`}
                  onClick={() => toggle(svc.key, svc.active)}
                  disabled={!svc.active && svc.key === 'WALLET'}
                >
                  {svc.active ? t('services.leave') : t('services.join')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
