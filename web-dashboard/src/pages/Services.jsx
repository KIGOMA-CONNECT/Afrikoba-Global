import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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

  const toggle = async (e, key, active) => {
    e.preventDefault();
    e.stopPropagation();
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
          <Link
            key={svc.key}
            to={`/dashboard/services/${svc.key}`}
            className={`card svc-card ${!svc.active ? 'locked' : ''}`}
          >
            <div className="svc-card-top">
              <span className="svc-card-emoji">{svc.emoji}</span>
              <span className={`badge ${svc.active ? 'success' : svc.comingSoon ? 'pending' : 'info'}`}>
                {svc.active ? 'IMEWASHWA' : svc.comingSoon ? 'Inakuja' : 'HAIJAWASHWA'}
              </span>
            </div>
            <h3>{svc.swahili || svc.name}</h3>
            <p className="svc-card-tagline">{svc.tagline}</p>
            <div className="svc-card-footer">
              <span className="roles-tag">
                {svc.baseService ? 'Huduma ya msingi' : `KYC Level ${svc.requiresKyc}`}
              </span>
              {!svc.baseService && !svc.comingSoon && (
                <button
                  className={`btn svc-toggle ${svc.active ? 'ghost' : ''}`}
                  onClick={(e) => toggle(e, svc.key, svc.active)}
                  disabled={!svc.active && svc.key === 'WALLET'}
                >
                  {svc.active ? t('services.leave') : t('services.join')}
                </button>
              )}
              {svc.comingSoon && <span className="roles-tag">Hivi karibuni</span>}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}