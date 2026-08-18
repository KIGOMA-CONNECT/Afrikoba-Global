import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import ServiceLock from '../components/ServiceLock.jsx';

export default function Rosca() {
  const [pools, setPools] = useState([]);
  const [selected, setSelected] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [statusFilter, setStatusFilter] = useState('');

  const [pName, setPName] = useState('');
  const [pAmount, setPAmount] = useState('');
  const [pFreq, setPFreq] = useState('WEEKLY');
  const [pMembers, setPMembers] = useState('');
  const [pType, setPType] = useState('PUBLIC');
  const [wantEarly, setWantEarly] = useState(false);

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => {
    const q = statusFilter ? `?status=${statusFilter}` : '';
    api.get(`/rosca/pools${q}`).then((r) => setPools(r.data.pools)).catch(() => {});
  };

  useEffect(load, [statusFilter]);

  const createPool = async (e) => {
    e.preventDefault();
    try {
      await api.post('/rosca/pools', {
        poolName: pName, contributionAmount: pAmount, cycleFrequency: pFreq,
        totalMembers: pMembers, poolType: pType,
      });
      show('ok', 'Mzunguko umeundwa.');
      setPName(''); setPAmount(''); setPMembers('');
      load();
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu.'); }
  };

  const openPool = async (id) => {
    const res = await api.get(`/rosca/pools/${id}`);
    setSelected(res.data.pool);
  };

  const joinPool = async (id) => {
    try {
      const res = await api.post(`/rosca/pools/${id}/join`, { wantEarlySlot: wantEarly });
      show('ok', res.data.message);
      openPool(id);
    } catch (err) { show('err', err.response?.data?.message || 'Hitilafu.'); }
  };

  return (
    <ServiceLock serviceKey="ROSCA">
      <div className="page-head">
        <h2>Upatu / ROSCA (Kikoba cha Mzunguko)</h2>
        <p>Vikundi vya akiba kwa zamu - namba zinagawiwa kiotomatiki</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>Unda Mzunguko</h3>
          <form className="form-row" onSubmit={createPool}>
            <div className="field"><label>Jina</label><input value={pName} onChange={(e) => setPName(e.target.value)} required /></div>
            <div className="field"><label>Mchango (TZS)</label><input type="number" value={pAmount} onChange={(e) => setPAmount(e.target.value)} required /></div>
            <div className="field"><label>Mzunguko</label>
              <select value={pFreq} onChange={(e) => setPFreq(e.target.value)}><option value="WEEKLY">Wiki</option><option value="MONTHLY">Mwezi</option></select>
            </div>
            <div className="field"><label>Idadi ya Wanachama</label><input type="number" value={pMembers} onChange={(e) => setPMembers(e.target.value)} required /></div>
            <div className="field"><label>Aina</label>
              <select value={pType} onChange={(e) => setPType(e.target.value)}><option value="PUBLIC">Wazi</option><option value="PRIVATE_KIKOBA">Kikundi (Kibinafsi)</option></select>
            </div>
            <button className="btn" type="submit">Unda</button>
          </form>
        </div>

        <div className="card">
          <h3>Mizunguko Inayopatikana</h3>
          <div className="field" style={{ marginBottom: 10 }}>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Yote</option>
              <option value="WAITING_MEMBERS">Subiri Wanachama</option>
              <option value="ACTIVE">Inayoendelea</option>
              <option value="COMPLETED">Imekamilika</option>
            </select>
          </div>
          {pools.map((p) => (
            <div key={p.id} className="inline-actions" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <strong>{p.pool_name}</strong>
                <div className="roles-tag">{formatMoney(p.contribution_amount)} · {p.cycle_frequency} · {p.current_members}/{p.total_members}</div>
              </div>
              <div className="inline-actions">
                <StatusBadge status={p.status} />
                <button className="btn ghost" onClick={() => openPool(p.id)}>Fungua</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {selected && (
        <div className="card section">
          <h3>{selected.pool_name} <span className="roles-tag" style={{ marginLeft: 8 }}>{selected.pool_type}</span></h3>
          {selected.status === 'WAITING_MEMBERS' && (
            <div className="inline-actions" style={{ marginBottom: 14 }}>
              <button className="btn" onClick={() => joinPool(selected.id)}>Jiunge na Mzunguko</button>
              <label className="roles-tag" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={wantEarly} onChange={(e) => setWantEarly(e.target.checked)} />
                Nataka Namba ya Mwanzo (1/2) - inahitaji Collateral
              </label>
            </div>
          )}

          <h3 style={{ marginBottom: 8 }}>Wanachama na Namba</h3>
          <table>
            <thead><tr><th>Namba</th><th>Jina</th><th>Namba ya Simu</th><th>Trust Score</th><th>Amepokea?</th></tr></thead>
            <tbody>
              {selected.members.map((m) => (
                <tr key={m.assigned_queue_number}>
                  <td><strong>{m.assigned_queue_number}</strong></td>
                  <td>{m.full_name}</td>
                  <td>{m.phone_number}</td>
                  <td>{m.trust_score}</td>
                  <td>{m.has_received_payout ? 'Ndiyo' : 'Hapana'}</td>
                </tr>
              ))}
              {selected.members.length === 0 && <tr><td colSpan="5" className="roles-tag">Hakuna wanachama bado.</td></tr>}
            </tbody>
          </table>

          <h3 style={{ margin: '22px 0 8px' }}>Ratiba ya Malipo (Schedules)</h3>
          <table>
            <thead><tr><th>Mzunguko</th><th>Mnufaika (User ID)</th><th>Tarehe</th><th>Jumla ya Payout</th><th>Ada</th><th>Hali</th></tr></thead>
            <tbody>
              {selected.schedules.map((s) => (
                <tr key={s.id}>
                  <td>#{s.cycle_number}</td>
                  <td>{s.recipient_user_id}</td>
                  <td>{new Date(s.scheduled_date).toLocaleDateString('en-GB')}</td>
                  <td>{formatMoney(s.total_payout_amount)}</td>
                  <td>{formatMoney(s.comm_amount)}</td>
                  <td><StatusBadge status={s.status} /></td>
                </tr>
              ))}
              {selected.schedules.length === 0 && <tr><td colSpan="6" className="roles-tag">Ratiba haijazalishwa bado (pool ikijaa, ratiba inajitengeneza).</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </ServiceLock>
  );
}
