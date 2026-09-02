import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Insurance() {
  const { t } = useT();
  const [products, setProducts] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [showPurchase, setShowPurchase] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [age, setAge] = useState('30');

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('insurance.error') });

  const load = () => {
    api.get('/eco/insurance/products').then((r) => setProducts(r.data.products || r.data || [])).catch(() => {});
    api.get('/eco/insurance/policies').then((r) => setPolicies(r.data.policies || r.data || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const purchase = async (e) => {
    e.preventDefault();
    if (!selectedProduct) return;
    try {
      await api.post('/eco/insurance/purchase', {
        product_id: selectedProduct.id,
        age: Number(age),
      });
      setMsg({ type: 'ok', text: t('insurance.purchased_ok') });
      setShowPurchase(false);
      setSelectedProduct(null);
      load();
    } catch (err) { error(err); }
  };

  const renew = async (policyId) => {
    try {
      await api.post(`/eco/insurance/renew/${policyId}`);
      setMsg({ type: 'ok', text: t('insurance.renewed_ok') });
      load();
    } catch (err) { error(err); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('insurance.title')}</h2>
        <p>{t('insurance.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {msg.text}
        </div>
      )}

      {/* Active Policies */}
      <h3 style={{ marginBottom: 14 }}>{t('insurance.my_policies')}</h3>
      {policies.length === 0 ? (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <p className="roles-tag">{t('insurance.no_policies')}</p>
        </div>
      ) : (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', marginBottom: 24 }}>
          {policies.map((p) => (
            <div key={p.id} className="card" style={{ borderTop: '4px solid var(--green)', padding: 18, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ margin: 0 }}>{p.product_name || p.name || 'Insurance Policy'}</h4>
                  <span className="badge success">{p.status}</span>
                </div>
                <p style={{ marginTop: 10, marginBottom: 4 }}><strong>{formatMoney(p.coverage_amount)}</strong> {t('insurance.coverage')}</p>
                <small className="roles-tag" style={{ display: 'block', color: '#6b7a70' }}>
                  {t('insurance.premium')}: {formatMoney(p.premium_monthly)} / mo
                </small>
                <small className="roles-tag" style={{ display: 'block', color: '#6b7a70' }}>
                  {t('insurance.next_due')}: {p.next_premium_date ? new Date(p.next_premium_date).toLocaleDateString() : '—'}
                </small>
              </div>
              {p.status === 'ACTIVE' && (
                <button className="btn" style={{ marginTop: 16, padding: '6px 12px', fontSize: 12 }} onClick={() => renew(p.id)}>{t('insurance.renew')}</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Available Products */}
      <h3 style={{ marginBottom: 14, marginTop: 10 }}>{t('insurance.products_title')}</h3>
      {products.length === 0 ? (
        <div className="card" style={{ padding: 20 }}>
          <p className="roles-tag">{t('insurance.no_products')}</p>
        </div>
      ) : (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', marginBottom: 24 }}>
          {products.map((prod) => (
            <div key={prod.id} className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 20 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ margin: 0 }}>{prod.name}</h4>
                  <span className="badge info">{prod.category}</span>
                </div>
                <p style={{ fontSize: 13, color: '#4b5563', margin: '10px 0' }}>{prod.description}</p>
                <div style={{ margin: '12px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span className="roles-tag">{t('insurance.coverage')}:</span>
                    <strong>{formatMoney(prod.coverage_amount)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 4 }}>
                    <span className="roles-tag">{t('insurance.monthly_premium')}:</span>
                    <strong style={{ color: 'var(--green)' }}>{formatMoney(prod.premium_monthly)}</strong>
                  </div>
                </div>
              </div>
              <button className="btn" onClick={() => { setSelectedProduct(prod); setShowPurchase(true); }}>{t('insurance.buy_policy')}</button>
            </div>
          ))}
        </div>
      )}

      {/* Purchase Modal / Form */}
      {showPurchase && selectedProduct && (
        <div className="card" style={{ marginBottom: 24, border: '2px solid var(--green)' }}>
          <h3 style={{ marginBottom: 12 }}>{t('insurance.buy_policy')}: {selectedProduct.name}</h3>
          <form onSubmit={purchase} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('insurance.age')}
              <input type="number" min="18" max="100" value={age} onChange={(e) => setAge(e.target.value)} required />
            </label>
            <div style={{ background: '#f8fafc', padding: 12, borderRadius: 8, fontSize: 13 }}>
              <p style={{ margin: 0 }}>{t('insurance.premium')}: <strong>{formatMoney(selectedProduct.premium_monthly)}</strong></p>
              <p style={{ margin: '4px 0 0' }}>{t('insurance.coverage')}: <strong>{formatMoney(selectedProduct.coverage_amount)}</strong></p>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('insurance.confirm_purchase')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowPurchase(false)}>✕</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
