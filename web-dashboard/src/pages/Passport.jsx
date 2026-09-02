import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

export default function Passport() {
  const { t } = useT();
  const [passport, setPassport] = useState(null);
  const [autopilotPlans, setAutopilotPlans] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: [] });
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [planForm, setPlanForm] = useState({ title: '', target_amount: '', monthly_target: '', plan_type: 'SAVINGS' });

  const error = (err) => setMsg({ type: 'err', text: err.response?.data?.message || t('passport.error') });

  const load = () => {
    api.get('/passport').then((r) => setPassport(r.data.passport || r.data)).catch(() => {});
    api.get('/passport/autopilot/plans').then((r) => setAutopilotPlans(r.data.plans || [] )).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const recalculate = async () => {
    try {
      const r = await api.post('/passport/recalculate');
      setPassport(r.data.passport || r.data);
      setMsg({ type: 'ok', text: t('passport.recalc_ok') });
      load();
    } catch (err) { error(err); }
  };

  const createPlan = async (e) => {
    e.preventDefault();
    try {
      await api.post('/passport/autopilot/plans', {
        title: planForm.title,
        target_amount: Number(planForm.target_amount),
        monthly_target: Number(planForm.monthly_target),
        plan_type: planForm.plan_type,
      });
      setMsg({ type: 'ok', text: t('passport.plan_created') });
      setShowPlanForm(false);
      setPlanForm({ title: '', target_amount: '', monthly_target: '', plan_type: 'SAVINGS' });
      load();
    } catch (err) { error(err); }
  };

  const updatePlanStatus = async (id, status) => {
    try {
      await api.patch(`/passport/autopilot/plans/${id}`, { status });
      load();
    } catch (err) { error(err); }
  };

  const deletePlan = async (id) => {
    try {
      await api.delete(`/passport/autopilot/plans/${id}`);
      load();
    } catch (err) { error(err); }
  };

  const scoreColor = (score) => {
    if (score >= 700) return '#059669';
    if (score >= 600) return '#2563EB';
    if (score >= 500) return '#D97706';
    return '#DC2626';
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('passport.title')}</h2>
        <p>{t('passport.sub')}</p>
      </div>

      {msg.text && (
        <div className={`alert ${msg.type === 'ok' ? 'alert-ok' : 'alert-err'}`} style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 18 }}>
          {typeof msg.text === 'string' ? msg.text : msg.text}
        </div>
      )}

      {/* Passport Score Banner */}
      {passport && (
        <div className="card" style={{ marginBottom: 24, textAlign: 'center', padding: 28, background: 'linear-gradient(135deg, #0b3d2e 0%, #115e59 100%)', color: '#fff' }}>
          <small style={{ opacity: 0.8, textTransform: 'uppercase', letterSpacing: 1 }}>{t('passport.afrikoba_score')}</small>
          <div style={{ fontSize: 54, fontWeight: 'bold', margin: '8px 0', color: scoreColor(passport.score || passport.composite_score || 650) }}>
            {passport.score || passport.composite_score || 650} <span style={{ fontSize: 20, color: '#fff', opacity: 0.8 }}>/ 850</span>
          </div>
          <p style={{ fontSize: 18, marginBottom: 16 }}>
            <span className="badge" style={{ background: scoreColor(passport.score || passport.composite_score || 650), color: '#fff', padding: '6px 14px', fontSize: 14 }}>
              {passport.rating || passport.rating_label || 'Good / Nzuri'}
            </span>
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginTop: 16 }}>
            <button className="btn" style={{ background: '#fff', color: '#0b3d2e' }} onClick={recalculate}>🔄 {t('passport.recalc')}</button>
          </div>
        </div>
      )}

      {/* Dimensions Breakdown */}
      {passport && passport.dimensions && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginBottom: 24 }}>
          {Object.entries(passport.dimensions).map(([key, dim]) => (
            <div key={key} className="card" style={{ padding: 18 }}>
              <h4 style={{ margin: 0, textTransform: 'capitalize', marginBottom: 6 }}>{key}</h4>
              <p style={{ fontSize: 24, fontWeight: 'bold', margin: '4px 0', color: 'var(--green)' }}>{dim.score || dim.points || 0} pts</p>
              <small className="roles-tag" style={{ display: 'block', marginTop: 4, color: '#6b7a70' }}>{dim.reason || dim.summary || 'Verified'}</small>
            </div>
          ))}
        </div>
      )}

      {/* Financial Autopilot Plans */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{t('passport.autopilot_title')}</h3>
        <button className="btn" onClick={() => setShowPlanForm(true)}>＋ {t('passport.new_plan')}</button>
      </div>

      {showPlanForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('passport.new_plan')}</h3>
          <form onSubmit={createPlan} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>{t('passport.plan_title')}<input type="text" value={planForm.title} onChange={(e) => setPlanForm({ ...planForm, title: e.target.value })} required placeholder="e.g. Emergency Fund" /></label>
            <label>{t('passport.target_amount')}<input type="number" min="1000" value={planForm.target_amount} onChange={(e) => setPlanForm({ ...planForm, target_amount: e.target.value })} required /></label>
            <label>{t('passport.monthly_target')}<input type="number" min="100" value={planForm.monthly_target} onChange={(e) => setPlanForm({ ...planForm, monthly_target: e.target.value })} required /></label>
            <label>{t('passport.plan_type')}<select value={planForm.plan_type} onChange={(e) => setPlanForm({ ...planForm, plan_type: e.target.value })}><option value="SAVINGS">Savings</option><option value="DEBT_PAYOFF">Debt Payoff</option><option value="INVESTMENT">Investment</option></select></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">{t('passport.save')}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowPlanForm(false)}>✕</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {autopilotPlans.length === 0 ? (
          <p className="roles-tag">{t('passport.no_plans')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('passport.plan_title')}</th>
                  <th>{t('passport.plan_type')}</th>
                  <th>{t('passport.target_amount')}</th>
                  <th>{t('passport.monthly_target')}</th>
                  <th>{t('passport.status')}</th>
                  <th>{t('passport.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {autopilotPlans.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.title}</strong></td>
                    <td><span className="badge info">{p.plan_type}</span></td>
                    <td>{formatMoney(p.target_amount)}</td>
                    <td>{formatMoney(p.monthly_target)}</td>
                    <td><span className={`badge ${p.status === 'ACTIVE' ? 'success' : 'warning'}`}>{p.status}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {p.status === 'ACTIVE' ? (
                          <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => updatePlanStatus(p.id, 'PAUSED')}>{t('passport.pause')}</button>
                        ) : (
                          <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => updatePlanStatus(p.id, 'ACTIVE')}>{t('passport.resume')}</button>
                        )}
                        <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: 11, background: '#fee2e2', color: '#991b1b' }} onClick={() => deletePlan(p.id)}>{t('passport.delete')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
