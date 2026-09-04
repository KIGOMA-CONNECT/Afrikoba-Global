import React, { useEffect, useState } from 'react';
import { useT } from '../i18n/LangProvider.jsx';
import api from '../api/client.js';

export default function Recurrence() {
  const { t } = useT();
  const [rules, setRules] = useState([]);
  const [execs, setExecs] = useState([]);
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState('PAYROLL_RUN');
  const [frequency, setFrequency] = useState('MONTHLY');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [payload, setPayload] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  const show = (m, ok = true) => { setNotice({ m, ok }); setTimeout(() => setNotice(''), 4000); };

  const loadAll = () => {
    api.get('/recurrence/rules?include_disabled=true').then((r) => setRules(r.data.rules || [])).catch(() => {});
    api.get('/recurrence/executions').then((r) => setExecs(r.data.executions || [])).catch(() => {});
  };

  useEffect(() => { loadAll(); }, []);

  const createRule = async () => {
    setLoading(true);
    try {
      let parsedPayload = {};
      try { parsedPayload = payload ? JSON.parse(payload) : {}; } catch (e) { show('Payload must be valid JSON', false); setLoading(false); return; }
      await api.post('/recurrence/rules', {
        name, taskType, frequency,
        dayOfMonth: parseInt(dayOfMonth, 10) || undefined,
        payload: parsedPayload,
      });
      show('Recurrence rule created'); setName(''); setPayload(''); loadAll();
    } catch (e) { show(e.response?.data?.error || t('gov.error'), false); } finally { setLoading(false); }
  };

  const toggle = async (id, enabled) => {
    try { await api.patch(`/recurrence/rules/${id}`, { enabled }); loadAll(); }
    catch (e) { show(e.response?.data?.error || t('gov.error'), false); }
  };

  const sweep = async () => {
    setLoading(true);
    try { const r = await api.post('/recurrence/sweep'); show(`Sweep: ${r.data.due} due task(s) processed`); loadAll(); }
    catch (e) { show(e.response?.data?.error || t('gov.error'), false); } finally { setLoading(false); }
  };

  const payloadHint = {
    PAYROLL_RUN: '{"scheduleId": 1}',
    AUTO_SAVINGS: '{"userId": 1, "amount": 5000, "description": "Auto savings"}',
    CONTRIBUTION_CYCLE: '{"groupId": 1}',
  };

  return (
    <div className="fade-in">
      <h2 className="text-xl font-semibold mb-1">Recurrence Automation</h2>
      <p className="text-gray-500 text-sm mb-4">Scheduled auto-payroll, auto-savings & contribution cycles</p>
      {notice && <div className={`px-3 py-2 rounded mb-3 text-sm ${notice.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{notice.m}</div>}

      <div className="bg-white border rounded p-4 mb-4">
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="text-xs text-gray-500 block">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rule name" className="border rounded px-2 py-1 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500 block">Task type</label>
            <select value={taskType} onChange={(e) => { setTaskType(e.target.value); setPayload(payloadHint[e.target.value] || ''); }} className="border rounded px-2 py-1 text-sm">
              {Object.keys(payloadHint).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block">Frequency</label>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="border rounded px-2 py-1 text-sm">
              {['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block">Day of month</label>
            <input value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} className="border rounded px-2 py-1 text-sm w-14" />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-gray-500 block">Payload (JSON)</label>
            <input value={payload} onChange={(e) => setPayload(e.target.value)} className="border rounded px-2 py-1 text-sm w-full" />
          </div>
          <button onClick={createRule} disabled={loading} className="bg-blue-600 text-white px-4 py-2 rounded text-sm h-8">Create</button>
          <button onClick={sweep} disabled={loading} className="bg-gray-100 text-gray-700 px-4 py-2 rounded text-sm h-8">Run sweep now</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border rounded p-4">
          <b className="text-sm block mb-2">Rules</b>
          {rules.map((r) => (
            <div key={r.id} className="border-b py-2 text-sm">
              <div className="flex justify-between">
                <span><b>{r.name}</b> · <span className="text-xs">{r.task_type} ({r.frequency})</span></span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">runs {r.run_count}</span>
                  <button onClick={() => toggle(r.id, !r.enabled)} className={`text-xs px-2 py-0.5 rounded ${r.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{r.enabled ? 'ON' : 'OFF'}</button>
                </div>
              </div>
              <div className="text-xs text-gray-500">Next: {new Date(r.next_run_at).toLocaleString()}</div>
            </div>
          ))}
          {rules.length === 0 && <div className="text-gray-400 text-sm">No recurrence rules.</div>}
        </div>

        <div className="bg-white border rounded p-4">
          <b className="text-sm block mb-2">Execution history</b>
          {execs.map((e) => (
            <div key={e.id} className="flex justify-between border-b py-1 text-sm">
              <span>Rule #{e.rule_id}</span>
              <span className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded ${e.status === 'SUCCESS' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{e.status}</span>
                <span className="text-xs text-gray-400">{new Date(e.run_at).toLocaleString()}</span>
              </span>
            </div>
          ))}
          {execs.length === 0 && <div className="text-gray-400 text-sm">No executions yet.</div>}
        </div>
      </div>
    </div>
  );
}
