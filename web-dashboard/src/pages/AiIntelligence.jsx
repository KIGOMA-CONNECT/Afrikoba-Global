import React, { useEffect, useState } from 'react';
import { useT } from '../i18n/LangProvider.jsx';
import api from '../api/client.js';

export default function AiIntelligence() {
  const { t } = useT();
  const [tab, setTab] = useState('risk');
  const [assessment, setAssessment] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [explanations, setExplanations] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [boqInput, setBoqInput] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  const show = (m) => { setNotice(m); setTimeout(() => setNotice(''), 4000); };

  const loadAll = () => {
    api.get('/ai/risk').then((r) => setAssessment(r.data.assessment)).catch(() => {});
    api.get('/ai/recommendations').then((r) => setRecommendations(r.data.recommendations || [])).catch(() => {});
    api.get('/ai/explanations').then((r) => setExplanations(r.data.explanations || [])).catch(() => {});
    api.get('/ai/budget').then((r) => setAnalyses(r.data.analyses || [])).catch(() => {});
  };

  useEffect(() => { loadAll(); }, []);

  const runBoq = async () => {
    setLoading(true);
    try {
      let items = [];
      try { items = JSON.parse(boqInput); } catch (e) { show('BOQ must be valid JSON array of items'); setLoading(false); return; }
      const res = await api.post('/ai/budget/analyze', {
        projectId: projectId ? parseInt(projectId, 10) : null,
        lineItems: items,
      });
      show(`Analysis done: ${res.data.analysis.budget_health} (${res.data.analysis.variance_percent ?? 'n/a'}%)`);
      loadAll();
    } catch (e) { show(e.response?.data?.error || t('gov.error')); } finally { setLoading(false); }
  };

  const evaluate = async () => {
    setLoading(true);
    try {
      await api.post('/ai/risk/evaluate');
      show(t('ai.evaluated'));
      loadAll();
    } catch (e) { show(e.response?.data?.error || t('gov.error')); } finally { setLoading(false); }
  };

  const dismiss = async (id) => {
    try { await api.post(`/ai/recommendations/${id}/dismiss`); loadAll(); }
    catch (e) { show(t('gov.error')); }
  };

  const levelColor = (lvl) =>
    lvl === 'LOW' ? 'bg-green-100 text-green-700' :
    lvl === 'MEDIUM' ? 'bg-yellow-100 text-yellow-700' :
    lvl === 'HIGH' ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700';

  const priColor = (p) => ({ CRITICAL: 'bg-red-100 text-red-700', HIGH: 'bg-orange-100 text-orange-700', MEDIUM: 'bg-yellow-100 text-yellow-700', LOW: 'bg-gray-100 text-gray-600' }[p] || 'bg-gray-100 text-gray-600');

  return (
    <div className="fade-in">
      <h2 className="text-xl font-semibold mb-1">AI Financial Intelligence</h2>
      <p className="text-gray-500 text-sm mb-4">Risk engine · recommendations · explainable confidence</p>
      {notice && <div className="bg-green-100 text-green-800 px-3 py-2 rounded mb-3 text-sm">{notice}</div>}

      <button onClick={evaluate} disabled={loading} className="bg-blue-600 text-white px-4 py-2 rounded text-sm mb-4">
        {loading ? 'Evaluating…' : t('ai.evaluate')}
      </button>

      <div className="flex gap-1 mb-4">
        {['risk', 'reco', 'explain', 'boq'].map((tb) => (
          <button key={tb} onClick={() => setTab(tb)}
            className={`px-3 py-2 rounded text-sm ${tab === tb ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}>
            {tb === 'risk' ? t('ai.risk') : tb === 'reco' ? t('ai.recommendations') : tb === 'explain' ? t('ai.explainability') : t('ai.boq')}
          </button>
        ))}
      </div>

      {tab === 'risk' && (
        <div className="bg-white border rounded p-4">
          {assessment ? (
            <>
              <div className="flex items-center gap-4">
                <div className="text-4xl font-bold">{assessment.risk_score}</div>
                <div>
                  <span className={`text-xs px-2 py-1 rounded ${levelColor(assessment.risk_level)}`}>{assessment.risk_level}</span>
                  <div className="text-sm text-gray-500 mt-1">Confidence: {assessment.confidence}%</div>
                  <div className="text-sm text-gray-500">Model: {assessment.model_version}</div>
                </div>
              </div>
              {assessment.factors?.length > 0 && (
                <div className="mt-4">
                  <b className="text-sm">Contributing factors</b>
                  {assessment.factors.map((f, i) => (
                    <div key={i} className="flex justify-between border-b py-1 text-sm">
                      <span>{f.label || f.name}</span>
                      <span className="text-gray-500">+{f.weight}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : <div className="text-gray-400 text-sm">No risk assessment yet. Click Evaluate.</div>}
        </div>
      )}

      {tab === 'reco' && (
        <div className="space-y-2">
          {recommendations.length === 0 && <div className="text-gray-400 text-sm">No active recommendations.</div>}
          {recommendations.map((r) => (
            <div key={r.id} className="bg-white border rounded p-3">
              <div className="flex justify-between items-center">
                <b className="text-sm">{r.title}</b>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded ${priColor(r.priority)}`}>{r.priority}</span>
                  <button onClick={() => dismiss(r.id)} className="text-xs text-gray-400 hover:text-red-600">✕</button>
                </div>
              </div>
              <div className="text-sm text-gray-600 mt-1">{r.body}</div>
              <div className="text-xs text-gray-400 mt-1">{r.category} · confidence {r.confidence}%</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'explain' && (
        <div className="space-y-2">
          {explanations.length === 0 && <div className="text-gray-400 text-sm">No AI decision explanations yet.</div>}
          {explanations.map((e) => (
            <div key={e.id} className="bg-white border rounded p-3">
              <div className="flex justify-between"><b className="text-sm">{e.decision_type}</b><span className="text-xs text-gray-400">{e.model_version}</span></div>
              <div className="text-sm text-gray-600 mt-1">{e.explanation}</div>
              {e.top_features?.length > 0 && (
                <div className="text-xs text-gray-500 mt-1">Top features: {e.top_features.map((f) => f.name).join(', ')}</div>
              )}
              <div className="text-xs text-gray-400 mt-1">{new Date(e.created_at).toLocaleString()} · confidence {e.confidence}%</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'boq' && (
        <div className="space-y-3">
          <div className="bg-white border rounded p-4">
            <b className="text-sm">Analyze Budget / BOQ</b>
            <div className="flex gap-2 mt-2">
              <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="Project ID (optional)"
                className="border rounded px-2 py-1 text-sm w-40" />
            </div>
            <textarea value={boqInput} onChange={(e) => setBoqInput(e.target.value)}
              placeholder='JSON array of items, e.g. [{"description":"Foundation & Excavation","unitCost":15000000}]'
              className="border rounded p-2 text-sm w-full h-28 mt-2" />
            <button onClick={runBoq} disabled={loading} className="mt-2 bg-blue-600 text-white px-4 py-2 rounded text-sm">
              {loading ? 'Analyzing…' : t('ai.analyze_boq')}
            </button>
          </div>

          {analyses.map((a) => (
            <div key={a.id} className="bg-white border rounded p-4">
              <div className="flex justify-between">
                <b className="text-sm">Project #{a.project_id} · Budget {Number(a.total_budget).toLocaleString()}</b>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded ${levelColor(a.budget_health)}`}>{a.budget_health}</span>
                  <span className="text-xs text-gray-400">conf {a.confidence}%</span>
                </div>
              </div>
              {a.variance_percent !== null && (
                <div className="text-sm text-gray-600 mt-1">Variance vs market: <b>{a.variance_percent}%</b> ({Number(a.market_reference_total || 0).toLocaleString()} ref)</div>
              )}
              {(a.recommendations || []).map((r, i) => (
                <div key={i} className="text-sm text-gray-700 mt-1 border-t pt-1">
                  <b className="text-xs">{r.priority}</b> · {r.title} — {r.body}
                </div>
              ))}
            </div>
          ))}
          {analyses.length === 0 && <div className="text-gray-400 text-sm">No budget analyses yet.</div>}
        </div>
      )}
    </div>
  );
}
