import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const CATEGORIES = ['PRODUCE', 'GOODS', 'FARM_INPUT', 'ENERGY'];
const TIER_CLS = { AFRIKOBA_VERIFIED: 'success', ESTABLISHED: 'pending' };
const TERMS = [3, 6, 9, 12, 18, 24];

export default function Marketplace() {
  const { t } = useT();
  const [tab, setTab] = useState('browse');
  const [category, setCategory] = useState('');
  const [guide, setGuide] = useState(null);
  const [listings, setListings] = useState([]);
  const [orders, setOrders] = useState([]);
  const [orderRole, setOrderRole] = useState('buyer');
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  const [finOpen, setFinOpen] = useState(false);
  const [term, setTerm] = useState(6);
  const [down, setDown] = useState('');
  const [reviewId, setReviewId] = useState(null);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [create, setCreate] = useState({ category: 'PRODUCE', title: '', description: '', unit_price: '', stock_quantity: '' });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 7000);
  };

  const loadListings = (cat) => {
    setLoading(true);
    api.get('/v1/marketplace/listings', { params: cat ? { category: cat } : {} })
      .then((r) => setListings(r.data.listings || []))
      .catch(() => setListings([]))
      .finally(() => setLoading(false));
  };

  const loadGuide = (cat) => {
    if (!cat) { setGuide(null); return; }
    api.get('/v1/marketplace/price-guide', { params: { category: cat } })
      .then((r) => setGuide(r.data.guide || null))
      .catch(() => setGuide(null));
  };

  const loadOrders = () => {
    api.get('/v1/marketplace/orders', { params: { role: orderRole } })
      .then((r) => setOrders(r.data.orders || []))
      .catch(() => setOrders([]));
  };

  useEffect(() => {
    loadListings(category);
    loadGuide(category);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  useEffect(() => { loadOrders(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderRole]);

  const onCategory = (cat) => {
    setSelected(null);
    setCategory(cat);
  };

  const byStock = (l) => Number(l.stock_quantity);
  const remaining = selected ? ` — ${t('mkt.stock_left', { n: byStock(selected) })}` : '';

  const tierBadge = (l) => {
    if (l.seller_verified) return <span className="badge success">{t('mkt.verified')}</span>;
    const cls = TIER_CLS[l.seller_tier] || 'info';
    const label = l.seller_tier === 'ESTABLISHED' ? t('mkt.established') : t('mkt.unverified');
    return <span className={`badge ${cls}`}>{label}</span>;
  };

  const buyCash = async () => {
    if (!selected) return;
    try {
      const res = await api.post('/v1/marketplace/orders', { listing_id: selected.id, quantity: parseInt(qty, 10) });
      let text = `${t('mkt.order_ok')} ${formatMoney(res.data.order.total_amount)}`;
      if (res.data.affordability && res.data.affordability.reason) text += ` — ${res.data.affordability.reason}`;
      show('ok', text);
      setSelected(null); setQty(1);
      loadListings(category);
      loadOrders();
    } catch (err) {
      show('err', err.response?.data?.message || t('mkt.err_generic'));
    }
  };

  const buyFinanced = async (e) => {
    e.preventDefault();
    if (!selected) return;
    try {
      const res = await api.post('/v1/marketplace/orders/financed', {
        listing_id: selected.id,
        quantity: parseInt(qty, 10),
        term_months: parseInt(term, 10),
        down_payment: parseFloat(down) || 0,
      });
      show('ok', `${t('mkt.order_ok')} ${formatMoney(res.data.total_to_repay)} — ${t('mkt.monthly')} ${formatMoney(res.data.financing.monthly_installment)} x${term}`);
      setSelected(null); setFinOpen(false); setQty(1); setDown(''); setTerm(6);
      loadListings(category);
      loadOrders();
    } catch (err) {
      show('err', err.response?.data?.message || t('mkt.err_generic'));
    }
  };

  const createListing = async (e) => {
    e.preventDefault();
    try {
      await api.post('/v1/marketplace/listings', {
        category: create.category,
        title: create.title,
        description: create.description,
        unit_price: parseFloat(create.unit_price),
        stock_quantity: parseInt(create.stock_quantity, 10),
      });
      show('ok', t('mkt.created'));
      setCreate({ ...create, title: '', description: '', unit_price: '', stock_quantity: '' });
      loadListings(category);
    } catch (err) {
      show('err', err.response?.data?.message || t('mkt.err_generic'));
    }
  };

  const confirmOrder = async (id) => {
    try {
      const res = await api.post(`/v1/marketplace/orders/${id}/confirm`);
      show('ok', `${t('mkt.confirmed')} ${formatMoney(res.data.amount)}`);
      loadOrders();
    } catch (err) {
      show('err', err.response?.data?.message || t('mkt.err_generic'));
    }
  };

  const cancelOrder = async (id) => {
    try {
      const res = await api.post(`/v1/marketplace/orders/${id}/cancel`);
      show('ok', `${t('mkt.cancelled')} ${formatMoney(res.data.refunded)}`);
      loadOrders();
    } catch (err) {
      show('err', err.response?.data?.message || t('mkt.err_generic'));
    }
  };

  const submitReview = async (e, id) => {
    e.preventDefault();
    try {
      await api.post(`/v1/marketplace/orders/${id}/review`, { rating: parseInt(rating, 10), comment });
      show('ok', t('mkt.reviewed'));
      setReviewId(null); setComment(''); setRating(5);
    } catch (err) {
      show('err', err.response?.data?.message || t('mkt.err_generic'));
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>{t('mkt.title')}</h2>
        <p>{t('mkt.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="roles-tag" style={{ marginBottom: 14 }}>
        <button className={`btn${tab === 'browse' ? '' : ' ghost'}`} onClick={() => setTab('browse')}>{t('mkt.tab.browse')}</button>{' '}
        <button className={`btn${tab === 'orders' ? '' : ' ghost'}`} onClick={() => setTab('orders')}>{t('mkt.tab.orders')}</button>
      </div>

      {tab === 'browse' && (
        <>
          <div className="grid grid-2">
            <div className="card">
              <div className="form-row">
                <div className="field">
                  <label>{t('mkt.category')}</label>
                  <select value={category} onChange={(e) => onCategory(e.target.value)}>
                    <option value="">{t('mkt.all')}</option>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div className="card">
              <h3>{t('mkt.price_guide')}</h3>
              {guide && guide.band ? (
                <div className="grid grid-3" style={{ gap: 8 }}>
                  <div className="stat">
                    <div className="value" style={{ fontSize: 18 }}>{formatMoney(guide.band.min_price)}</div>
                    <div className="label">{t('mkt.min')}</div>
                  </div>
                  <div className="stat">
                    <div className="value" style={{ fontSize: 18 }}>{formatMoney(guide.band.avg_price)}</div>
                    <div className="label">{t('mkt.avg')}</div>
                  </div>
                  <div className="stat">
                    <div className="value" style={{ fontSize: 18 }}>{formatMoney(guide.band.max_price)}</div>
                    <div className="label">{t('mkt.max')}</div>
                  </div>
                </div>
              ) : (
                <p className="roles-tag">{t('mkt.no_guide')}</p>
              )}
            </div>
          </div>

          <div className="grid grid-2 section">
            <div>
              <h3>{t('mkt.listings')} {loading && <span className="roles-tag">…</span>}</h3>
              {listings.length === 0 && !loading ? (
                <p className="roles-tag">{t('mkt.no_listings')}</p>
              ) : (
                listings.map((l) => (
                  <div className="card" key={l.id} style={{ marginBottom: 10, cursor: 'pointer' }}
                    onClick={() => { setSelected(l); setFinOpen(false); setQty(1); }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{l.title}</strong>
                      {tierBadge(l)}
                    </div>
                    <p className="roles-tag">{l.seller_name} · {l.category} · {t('mkt.rating')} {l.avg_rating != null ? Number(l.avg_rating).toFixed(1) : '—'}</p>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="value" style={{ fontSize: 18 }}>{formatMoney(l.unit_price)}</span>
                      <span className="roles-tag">{t('mkt.stock_left', { n: byStock(l) })}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {selected && (
              <div className="card">
                <h3>{selected.title}{remaining}</h3>
                <p>{selected.description || '—'}</p>
                <p className="roles-tag">{formatMoney(selected.unit_price)} · {t('mkt.rating')} {selected.avg_rating != null ? Number(selected.avg_rating).toFixed(1) : '—'} · {tierBadge(selected)}</p>

                <div className="form-row">
                  <div className="field">
                    <label>{t('mkt.quantity')}</label>
                    <input type="number" min="1" max={byStock(selected)} value={qty}
                      onChange={(e) => setQty(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label>{t('mkt.total')}</label>
                    <input value={formatMoney(Number(selected.unit_price) * (parseInt(qty, 10) || 0))} disabled />
                  </div>
                </div>

                <button className="btn" onClick={buyCash}>{t('mkt.buy_cash')}</button>{' '}
                <button className="btn ghost" onClick={() => setFinOpen(!finOpen)}>{t('mkt.buy_fin')}</button>

                {finOpen && (
                  <form className="form-row" style={{ marginTop: 12 }} onSubmit={buyFinanced}>
                    <div className="field">
                      <label>{t('mkt.term')}</label>
                      <select value={term} onChange={(e) => setTerm(e.target.value)}>
                        {TERMS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label>{t('mkt.down')}</label>
                      <input type="number" min="0" value={down} onChange={(e) => setDown(e.target.value)} placeholder="0" />
                    </div>
                    <button className="btn" type="submit">{t('mkt.estimate')}</button>
                  </form>
                )}
              </div>
            )}

            <div className="card section">
              <h3>{t('mkt.create')}</h3>
              <form onSubmit={createListing}>
                <div className="form-row">
                  <div className="field">
                    <label>{t('mkt.category')}</label>
                    <select value={create.category} onChange={(e) => setCreate({ ...create, category: e.target.value })}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>{t('mkt.item_title')}</label>
                    <input value={create.title} onChange={(e) => setCreate({ ...create, title: e.target.value })} required />
                  </div>
                </div>
                <div className="field">
                  <label>{t('mkt.desc')}</label>
                  <input value={create.description} onChange={(e) => setCreate({ ...create, description: e.target.value })} />
                </div>
                <div className="form-row">
                  <div className="field">
                    <label>{t('mkt.unit_price')}</label>
                    <input type="number" min="1" value={create.unit_price} onChange={(e) => setCreate({ ...create, unit_price: e.target.value })} required />
                  </div>
                  <div className="field">
                    <label>{t('mkt.stock')}</label>
                    <input type="number" min="0" value={create.stock_quantity} onChange={(e) => setCreate({ ...create, stock_quantity: e.target.value })} required />
                  </div>
                </div>
                <button className="btn" type="submit">{t('mkt.submit')}</button>
              </form>
            </div>
          </div>
        </>
      )}

      {tab === 'orders' && (
        <div className="card section">
          <h3>{t('mkt.orders')}</h3>
          <div className="roles-tag" style={{ marginBottom: 10 }}>
            <button className={`btn${orderRole === 'buyer' ? '' : ' ghost'}`} onClick={() => setOrderRole('buyer')}>{t('mkt.as_buyer')}</button>{' '}
            <button className={`btn${orderRole === 'seller' ? '' : ' ghost'}`} onClick={() => setOrderRole('seller')}>{t('mkt.as_seller')}</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>{t('mkt.th_item')}</th>
                <th>{t('mkt.th_counterparty')}</th>
                <th>{t('mkt.th_total')}</th>
                {orderRole === 'buyer' && <th>{t('mkt.th_escrowed')}</th>}
                <th>{t('mkt.th_status')}</th>
                <th>{t('mkt.th_date')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <React.Fragment key={o.id}>
                  <tr key={`${o.id}-row`}>
                    <td>{o.title} <span className="roles-tag">x{o.quantity}</span></td>
                    <td>{o.counterparty}</td>
                    <td>{formatMoney(o.total_amount)}</td>
                    {orderRole === 'buyer' && <td>{formatMoney(o.escrow_held_amount || 0)}</td>}
                    <td><StatusBadge status={o.status} /></td>
                    <td>{new Date(o.created_at).toLocaleDateString('en-GB')}</td>
                    <td>
                      {orderRole === 'buyer' && o.status === 'ESCROW_HELD' && (
                        <>
                          <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => confirmOrder(o.id)}>{t('mkt.confirm')}</button>{' '}
                          <button className="btn warn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => cancelOrder(o.id)}>{t('mkt.cancel')}</button>
                        </>
                      )}
                      {orderRole === 'buyer' && o.status === 'CONFIRMED' && (
                        <button className="btn ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => setReviewId(reviewId === o.id ? null : o.id)}>{t('mkt.review')}</button>
                      )}
                    </td>
                  </tr>
                  {reviewId === o.id && (
                    <tr key={`${o.id}-rev`}>
                      <td colSpan="7">
                        <form className="form-row" onSubmit={(e) => submitReview(e, o.id)}>
                          <div className="field">
                            <label>{t('mkt.rating_label')}</label>
                            <select value={rating} onChange={(e) => setRating(e.target.value)}>
                              {[5, 4, 3, 2, 1].map((r) => <option key={r} value={r}>{r}</option>)}
                            </select>
                          </div>
                          <div className="field">
                            <label>{t('mkt.comment_label')}</label>
                            <input value={comment} onChange={(e) => setComment(e.target.value)} />
                          </div>
                          <button className="btn" type="submit">{t('mkt.place')}</button>
                        </form>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {orders.length === 0 && <tr><td colSpan="7" style={{ color: 'var(--muted)' }}>{t('mkt.no_orders')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}