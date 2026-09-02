import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Financing() {
  const { t } = useT();
  const [rows, setRows] = useState([]);
  const [paying, setPaying] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const refresh = () => {
    api.get('/v1/marketplace/financing')
      .then((r) => setRows(r.data.financing || []))
      .catch(() => setRows([]));
  };

  useEffect(refresh, []);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 6000);
  };

  const pay = async (id) => {
    setPaying(id);
    try {
      const res = await api.post(`/v1/marketplace/financing/${id}/pay`);
      show('ok', `${t('fin.pay_ok')} ${formatMoney(res.data.paid_this)}`);
      refresh();
    } catch (err) {
      show('err', err.response?.data?.message || t('mkt.err_generic'));
    } finally {
      setPaying(null);
    }
  };

  const total = (row) => Number(row.financed_amount) + Number(row.fee_total);
  const progress = (row) => {
    const p = total(row);
    return p > 0 ? Math.min(100, Math.round((Number(row.paid_amount) / p) * 100)) : 0;
  };

  return (
    <>
      <div className="page-head">
        <h2>{t('fin.title')}</h2>
        <p>{t('fin.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="card section">
        <h3>{t('fin.agreements')}</h3>
        <table>
          <thead>
            <tr>
              <th>{t('fin.th_item')}</th>
              <th>{t('fin.financed')}</th>
              <th>{t('fin.fee')}</th>
              <th>{t('fin.monthly')}</th>
              <th>{t('fin.paid')}</th>
              <th>{t('fin.total')}</th>
              <th>{t('fin.due')}</th>
              <th>{t('fin.th_status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const pct = progress(row);
              const paid = pct > 0;
              return (
                <tr key={row.id}>
                  <td>{row.item} <span className="roles-tag">#{row.order_id}</span></td>
                  <td>{formatMoney(row.financed_amount)}</td>
                  <td>{formatMoney(row.fee_total)}</td>
                  <td>{formatMoney(row.monthly_installment)}</td>
                  <td>{formatMoney(row.paid_amount)}</td>
                  <td>{formatMoney(total(row))}</td>
                  <td>{row.next_due_date ? String(row.next_due_date).slice(0, 10) : '—'}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td>
                    {row.status === 'ACTIVE' && (
                      <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!!paying} onClick={() => pay(row.id)}>
                        {paying === row.id ? '…' : t('fin.pay')}
                      </button>
                    )}
                    <div style={{ marginTop: 5, height: 6, borderRadius: 3, background: 'var(--border)' }}>
                      <div style={{ height: 6, borderRadius: 3, background: paid ? '#0b5d1e' : 'var(--warn)', width: `${pct}%`, minWidth: pct > 0 ? 4 : 0 }} />
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan="9" style={{ color: 'var(--muted)' }}>{t('fin.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}