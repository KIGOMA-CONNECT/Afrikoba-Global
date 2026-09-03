import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function PaymentLink() {
  const { code } = useParams();
  const { t } = useT();
  const [link, setLink] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get(`/merchant/payment-links/${code}`)
      .then((r) => { setLink(r.data.link); if (r.data.link.amount) setAmount(String(r.data.link.amount)); })
      .catch((e) => setError(e.response?.data?.message || 'Kiungo hakipatikani.'))
      .finally(() => setLoading(false));
  }, [code]);

  const pay = async (e) => {
    e.preventDefault();
    const token = localStorage.getItem('afrikoba_token');
    if (!token) { window.location.href = '/login'; return; }
    setPaying(true);
    setMsg('');
    try {
      const r = await api.post(`/merchant/payment-links/${code}/pay`, { amount: amount ? Number(amount) : undefined });
      setResult(r.data);
    } catch (e) {
      setMsg(e.response?.data?.message || 'Malipo yameshindikana.');
    } finally { setPaying(false); }
  };

  if (loading) return (
    <div style={{ display:'flex',justifyContent:'center',alignItems:'center',minHeight:'80vh',color:'#6b7a70',fontSize:14 }}>Inapakia...</div>
  );

  if (error) return (
    <div style={{ maxWidth:420,margin:'10vh auto',textAlign:'center',padding:24 }}>
      <p style={{ fontSize:28 }}>🔗</p>
      <h3 style={{ marginTop:8 }}>{t('pl.not_found')}</h3>
      <p style={{ color:'#6b7a70' }}>{error}</p>
      <Link to="/login" className="btn" style={{ marginTop:16 }}>{t('pl.go_home')}</Link>
    </div>
  );

  if (result) return (
    <div style={{ maxWidth:420,margin:'10vh auto',textAlign:'center',padding:24 }}>
      <p style={{ fontSize:42 }}>✅</p>
      <h2 style={{ marginTop:12 }}>{t('pl.success')}</h2>
      <p style={{ color:'#6b7a70',marginTop:8 }}>{t('pl.paid_to')} {link.merchant_name}</p>
      <p style={{ fontSize:22,fontWeight:700,margin:'12px 0' }}>{formatMoney(result.amount || amount)}</p>
      <p style={{ fontSize:12,color:'#6b7a70',wordBreak:'break-all' }}>Ref: {result.reference}</p>
      <Link to="/dashboard" className="btn" style={{ marginTop:20 }}>{t('pl.dashboard')}</Link>
    </div>
  );

  return (
    <div style={{ maxWidth:420,margin:'10vh auto',padding:24 }}>
      <div className="card" style={{ textAlign:'center',padding:28 }}>
        <p style={{ fontSize:36,margin:0 }}>🏪</p>
        <h2 style={{ marginTop:12,marginBottom:4 }}>{link.merchant_name}</h2>
        {link.business_type && <p style={{ color:'#6b7a70',margin:0,fontSize:13 }}>{link.business_type}</p>}

        {link.description && (
          <p style={{ marginTop:14,fontSize:15 }}>{link.description}</p>
        )}

        <div style={{ marginTop:20,marginBottom:16,background:'#f8faf9',borderRadius:12,padding:18 }}>
          <p style={{ fontSize:12,color:'#6b7a70',margin:'0 0 4px' }}>{t('pl.amount')}</p>
          {link.isFixed ? (
            <p style={{ fontSize:26,fontWeight:700,margin:0 }}>{formatMoney(link.amount)}</p>
          ) : (
            <p style={{ fontSize:26,fontWeight:700,margin:0 }}>{formatMoney(amount || 0)}</p>
          )}
        </div>

        {!link.isFixed && (
          <label style={{ display:'block',textAlign:'left',marginBottom:14,fontWeight:600,fontSize:13 }}>
            {t('pl.enter_amount')}
            <input type="number" min="1" value={amount} onChange={(e)=>setAmount(e.target.value)}
              placeholder={t('pl.amount_ph')} style={{ marginTop:6,width:'100%' }} />
          </label>
        )}

        {msg && <p style={{ color:'#dc2626',fontSize:13,margin:'0 0 10px' }}>{msg}</p>}

        <button className="btn" style={{ width:'100%',fontSize:16,padding:'12px 0' }}
          disabled={paying || (!link.isFixed && !amount)}
          onClick={pay}>
          {paying ? t('pl.processing') : t('pl.pay_now')}
        </button>

        <Link to="/login" style={{ display:'block',marginTop:14,fontSize:13,color:'var(--primary,#059669)' }}>{t('pl.not_you')}</Link>
      </div>
    </div>
  );
}