import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import { useT } from '../i18n/LangProvider.jsx';

const FALLBACK = {
  WALLET: {
    key: 'WALLET', emoji: '💼', color: '#0b7a41',
    swahili: 'Wallet ya Fedha', name: 'Wallet',
    tagline: 'Malipo, salio na uhamisho wa papasapo - popote Tanzania.',
    description: 'Akaunti ya msingi ya fedha - salio, malipo, uhamisho na matumizi ya kila siku.',
    perks: ['Malipo na uhamisho wa papasapo (P2P)', 'Kumbukumbu kamili ya kila shilingi', 'Usalama wa juu na uthibitisho wa OTP/PIN'],
    cta: 'Fungua Wallet Yako', requiresKyc: 1, baseService: true, comingSoon: false,
  },
  VICOBA: {
    key: 'VICOBA', emoji: '🏦', color: '#155e9c',
    swahili: 'VICOBA (Kikundi)', name: 'VICOBA',
    tagline: 'Akiba na mikopo kwa nguvu ya pamoja - kikundi chako, usalama wako.',
    description: 'Jiunge na kikundi cha akiba na mikopo - weka hisa, pata mikopo yenye uwajibikaji wa pamoja.',
    perks: ['Weka hisa na pata mikopo ya kikundi', 'Mikopo ya Multi-Signature (mikopo salama)', 'Msimbo wa kujiunga + mialiko ya SMS'],
    cta: 'Jiunge na Kikundi', requiresKyc: 1, baseService: false, comingSoon: false,
  },
  ROSCA: {
    key: 'ROSCA', emoji: '🔄', color: '#0e8a8a',
    swahili: 'Upatu (ROSCA)', name: 'Upatu (ROSCA)',
    tagline: 'Upatu wa kisasa - zamu na malipo yako yote otomatiki.',
    description: 'Mzunguko wa fedha unaotegemewa - upatu wa kisasa wenye ratiba na malipo otomatiki.',
    perks: ['Ratiba ya zamu inajitengeneza otomatiki', 'Malipo yanatoka moja kwa moja kwenye wallet', 'Uwazi kamili - kila mzunguko unaonekana'],
    cta: 'Anza Upatu Wako', requiresKyc: 2, baseService: false, comingSoon: false,
  },
  P2P: {
    key: 'P2P', emoji: '📈', color: '#6d3fb8',
    swahili: 'Uwekezaji (P2P)', name: 'Uwekezaji (P2P)',
    tagline: 'Wekeza kwenye biashara halisi upate faida - na pata mkopo kwa riba nafuu.',
    description: 'Wekeza kwenye miradi ya kibiashara na upate faida - na pata mikopo kwa riba nafuu.',
    perks: ['Miradi iliyohakikiwa kwa hatua 4', 'Fedha zilizofungwa kwenye escrow', 'Mkataba wa PDF wa kisheria kwa kila uwekezaji'],
    cta: 'Wekeza Leo', requiresKyc: 2, baseService: false, comingSoon: false,
  },
  KILIMO: {
    key: 'KILIMO', emoji: '🌾', color: '#b26a00',
    swahili: 'Kilimo (Agri-Finance)', name: 'Kilimo (Agri-Finance)',
    tagline: 'Fedha za kilimo, pembejeo na mkopo unaolipishwa baada ya mavuno.',
    description: 'Fedha za kilimo, pembejeo na mkopo unaolipishwa baada ya mavuno. (Phase 5)',
    perks: ['Mkopo unaolipishwa baada ya mavuno', 'Pembejeo za kilimo kwa bei nzuri', 'Mashamba na wakulima waliothibitishwa'],
    cta: 'Inakuja hivi karibuni', requiresKyc: 2, baseService: false, comingSoon: true,
  },
};

export default function ServiceDetail() {
  const { key } = useParams();
  const { t } = useT();
  const navigate = useNavigate();
  const [svc, setSvc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/services/catalog').then((r) => {
      const found = r.data.catalog.find((s) => s.key === key);
      setSvc(found || FALLBACK[key] || null);
      setLoading(false);
    }).catch(() => {
      setSvc(FALLBACK[key] || null);
      setLoading(false);
    });
  }, [key]);

  const subscribe = async () => {
    setSubscribing(true);
    setMsg('');
    try {
      await api.post('/services/subscribe', { serviceKey: key });
      setSvc((prev) => ({ ...prev, active: true }));
      setMsg('Umejiunga na huduma hii. Karibu!');
      const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
      user.services = [...(user.services || []), key];
      localStorage.setItem('afrikoba_user', JSON.stringify(user));
    } catch (e) {
      setMsg(e.response?.data?.message || 'Hitilafu.');
    } finally {
      setSubscribing(false);
    }
  };

  if (loading) return <div className="page-head"><p>Inapakia...</p></div>;
  if (!svc) return (
    <div className="page-head">
      <p>Huduma haipatikani.</p>
      <Link to="/dashboard/services" className="btn ghost" style={{ marginTop: 12, display: 'inline-block' }}>{t('services.back')}</Link>
    </div>
  );

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Link to="/dashboard/services" className="roles-tag" style={{ color: 'var(--green)', fontWeight: 600 }}>
          ← {t('services.back')}
        </Link>
      </div>

      <div className="svc-detail">
        <div className="svc-detail-header" style={{ borderLeftColor: svc.color }}>
          <span className="svc-detail-emoji">{svc.emoji}</span>
          <div>
            <h2>{svc.swahili || svc.name}</h2>
            <p className="svc-detail-tagline">{svc.tagline}</p>
          </div>
        </div>

        <div className="svc-detail-body">
          <div className="svc-detail-desc">
            <h3>Maelezo</h3>
            <p>{svc.description}</p>
          </div>

          {svc.perks && svc.perks.length > 0 && (
            <div className="svc-detail-perks">
              <h3>Faida za Huduma</h3>
              <ul>
                {svc.perks.map((perk, i) => <li key={i}>{perk}</li>)}
              </ul>
            </div>
          )}

          <div className="svc-detail-meta">
            <div className="svc-meta-item">
              <span className="svc-meta-label">Kiwango cha KYC</span>
              <span className="svc-meta-value">{svc.baseService ? 'Huduma ya msingi' : `Level ${svc.requiresKyc}`}</span>
            </div>
            <div className="svc-meta-item">
              <span className="svc-meta-label">Hali</span>
              <span className={`badge ${svc.active ? 'success' : svc.comingSoon ? 'pending' : 'info'}`}>
                {svc.active ? 'IMEWASHWA' : svc.comingSoon ? 'Inakuja hivi karibuni' : 'HAIJAWASHWA'}
              </span>
            </div>
          </div>

          {msg && <div className={`msg ${msg.includes('Hitilafu') || msg.includes('Kamilisha') ? 'warn' : 'ok'}`}>{msg}</div>}

          <div className="svc-detail-actions">
            {svc.comingSoon ? (
              <button className="btn" disabled>Inakuja hivi karibuni</button>
            ) : svc.active ? (
              <div className="svc-active-row">
                <span className="badge success" style={{ fontSize: 13, padding: '6px 14px' }}>✓ Huduma hii imeashwa</span>
                {svc.key !== 'WALLET' && (
                  <Link to={`/dashboard/${svc.key.toLowerCase()}`} className="btn">
                    Fungua {svc.swahili || svc.name}
                  </Link>
                )}
              </div>
            ) : (
              <button className="btn" onClick={subscribe} disabled={subscribing}>
                {subscribing ? 'Inajiunga...' : svc.cta || 'Jiunge Sasa'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}