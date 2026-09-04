import React, { useState, useEffect, useCallback } from 'react';
import { useT } from '../i18n/LangProvider.jsx';
import api from '../api/client.js';

const TABS = ['meetings', 'chat', 'documents', 'voting', 'resolutions', 'action', 'finance'];

export default function Governance() {
  const { t } = useT();
  const [tab, setTab] = useState('meetings');
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');
  const [meetings, setMeetings] = useState([]);
  const [channels, setChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgBody, setMsgBody] = useState('');
  const [documents, setDocuments] = useState([]);
  const [resolutions, setResolutions] = useState([]);
  const [actionItems, setActionItems] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ title: '', scheduled_at: '', description: '' });
  const [auditTrail, setAuditTrail] = useState([]);

  const show = (text) => { setNotice(text); setTimeout(() => setNotice(''), 4000); };

  const doSearch = useCallback((rv) => {
    if (!rv) return;
    setSearchResults(rv.data);
  }, []);

  const loadMeetings = useCallback(() => {
    if (!groupId) return;
    api.get('/governance/meetings', { params: { group_id: groupId } })
      .then((r) => setMeetings(r.data.meetings)).catch(() => setMeetings([]));
  }, [groupId]);

  useEffect(() => { api.get('/vicoba/groups').then((r) => setGroups(r.data.groups)).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'meetings') loadMeetings(); }, [tab, loadMeetings]);

  useEffect(() => {
    if (!activeChannel) return;
    api.get(`/governance/channels/${activeChannel}/messages`).then((r) => setMessages(r.data.messages)).catch(() => setMessages([]));
  }, [activeChannel]);

  const loadChannels = () => {
    if (!groupId) return;
    api.get('/governance/channels', { params: { group_id: groupId } })
      .then((r) => setChannels(r.data.channels)).catch(() => setChannels([]));
  };

  const loadDocs = () => {
    if (!groupId) return;
    api.get('/governance/documents', { params: { group_id: groupId } })
      .then((r) => setDocuments(r.data.documents)).catch(() => setDocuments([]));
  };

  const loadResolutions = () => {
    if (!groupId) return;
    api.get('/governance/resolutions', { params: { group_id: groupId } })
      .then((r) => setResolutions(r.data.resolutions)).catch(() => setResolutions([]));
  };

  const loadActionItems = () => {
    if (!groupId) return;
    api.get('/governance/action-items', { params: { group_id: groupId } })
      .then((r) => setActionItems(r.data.actionItems)).catch(() => setActionItems([]));
  };

  const loadAuditTrail = () => {
    if (!groupId) return;
    api.get('/governance/financial/audit-trail', { params: { group_id: groupId } })
      .then((r) => setAuditTrail(r.data.auditTrail)).catch(() => setAuditTrail([]));
  };

  const switchTab = (tb) => {
    setTab(tb);
    if (tb === 'chat') loadChannels();
    if (tb === 'documents') loadDocs();
    if (tb === 'resolutions') loadResolutions();
    if (tb === 'action') loadActionItems();
    if (tb === 'finance') loadAuditTrail();
  };

  const createMeeting = async (e) => {
    e.preventDefault();
    if (!groupId) return;
    try {
      await api.post('/governance/meetings', { group_type: 'VICOBA', group_id: Number(groupId), ...form });
      show(t('gov.created'));
      setForm({ title: '', scheduled_at: '', description: '' });
      loadMeetings();
    } catch (err) { show(err.response?.data?.error || t('gov.error')); }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!activeChannel || !msgBody.trim()) return;
    try {
      await api.post(`/governance/channels/${activeChannel}/messages`, { body: msgBody });
      setMsgBody('');
      api.get(`/governance/channels/${activeChannel}/messages`).then((r) => setMessages(r.data.messages)).catch(() => {});
    } catch (err) { show(err.response?.data?.error || t('gov.error')); }
  };

  const doSearchSubmit = async (e) => {
    e.preventDefault();
    if (!groupId || !searchQuery.trim()) return;
    try {
      const rv = await api.get('/governance/search', { params: { group_id: groupId, q: searchQuery } });
      doSearch(rv);
    } catch (err) { show(t('gov.error')); }
  };

  return (
    <div className="fade-in">
      <h2 className="text-xl font-semibold mb-1">{t('gov.title')}</h2>
      <p className="text-gray-500 text-sm mb-4">{t('gov.select_group')}</p>

      {notice && <div className="bg-green-100 text-green-800 px-3 py-2 rounded mb-3 text-sm">{notice}</div>}

      <div className="flex items-center gap-3 mb-4">
        <select
          className="border rounded px-3 py-2 text-sm"
          value={groupId}
          onChange={(e) => { setGroupId(e.target.value); }}
        >
          <option value="">{t('gov.select_group')}</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.group_name || g.name}</option>)}
        </select>
        <form onSubmit={doSearchSubmit} className="flex gap-2 flex-1">
          <input
            className="border rounded px-3 py-2 text-sm flex-1"
            placeholder={t('gov.search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button type="submit" className="bg-blue-600 text-white px-3 py-2 rounded text-sm">🔍</button>
        </form>
      </div>

      {searchResults && (
        <div className="bg-gray-50 border rounded p-3 mb-4 text-sm">
          <div className="flex justify-between mb-2"><b>Search Results</b>
            <button className="text-blue-600" onClick={() => setSearchResults(null)}>✕</button></div>
          {Object.keys(searchResults).filter((k) => searchResults[k]?.length).map((k) => (
            <div key={k} className="mb-2">
              <b className="uppercase text-xs text-gray-500">{k}</b>
              {searchResults[k].map((r, i) => (
                <div key={i} className="ml-2 py-1 border-b border-gray-200">
                  {r.title || r.channel || r.body?.slice(0, 120) || r.summary || 'record'}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 mb-4 flex-wrap">
        {TABS.map((tk) => (
          <button
            key={tk}
            onClick={() => switchTab(tk)}
            className={`px-3 py-2 rounded text-sm ${tab === tk ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
          >{t(`gov.${tk}`)}</button>
        ))}
      </div>

      {tab === 'meetings' && (
        <div>
          <form onSubmit={createMeeting} className="bg-white border rounded p-4 mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <input className="border rounded px-3 py-2 text-sm" placeholder={t('gov.meeting_title')}
              value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            <input className="border rounded px-3 py-2 text-sm" type="datetime-local" placeholder={t('gov.schedule')}
              value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} required />
            <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded text-sm">{t('gov.new_meeting')}</button>
          </form>
          <div className="space-y-2">
            {meetings.length === 0 && <div className="text-gray-400 text-sm">{t('gov.agenda')}</div>}
            {meetings.map((m) => (
              <div key={m.id} className="bg-white border rounded p-3">
                <div className="flex justify-between items-center">
                  <b>{m.title}</b>
                  <span className={`text-xs px-2 py-1 rounded ${m.status === 'COMPLETED' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{m.status}</span>
                </div>
                <div className="text-sm text-gray-500 mt-1">{new Date(m.scheduled_at).toLocaleString()} · {m.attended_count}/{m.total_count} {t('gov.attendees')}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'chat' && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-1 bg-white border rounded p-3">
            <b className="text-sm mb-2 block">{t('gov.chat')}</b>
            {channels.map((c) => (
              <button key={c.id}
                onClick={() => { setActiveChannel(c.id); }}
                className={`block w-full text-left px-2 py-2 rounded text-sm mb-1 ${activeChannel === c.id ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'}`}>
                #{c.name}
              </button>
            ))}
          </div>
          <div className="md:col-span-3 bg-white border rounded p-3 flex flex-col h-96">
            <div className="flex-1 overflow-y-auto mb-3">
              {messages.map((m, i) => (
                <div key={i} className="mb-2">
                  <b className="text-xs">{m.full_name}</b>
                  <div className="text-sm bg-gray-50 rounded p-2">{m.body}</div>
                </div>
              ))}
            </div>
            {activeChannel && (
              <form onSubmit={sendMessage} className="flex gap-2">
                <input className="border rounded px-3 py-2 text-sm flex-1" placeholder="Message" value={msgBody} onChange={(e) => setMsgBody(e.target.value)} />
                <button className="bg-blue-600 text-white px-3 py-2 rounded text-sm">Send</button>
              </form>
            )}
          </div>
        </div>
      )}

      {tab === 'documents' && (
        <div>
          <div className="space-y-2">
            {documents.length === 0 && <div className="text-gray-400 text-sm">{t('gov.documents')}</div>}
            {documents.map((d) => (
              <div key={d.id} className="bg-white border rounded p-3">
                <div className="flex justify-between"><b>{d.title}</b>
                  <span className="text-xs bg-gray-100 px-2 py-1 rounded">{d.doc_category}</span></div>
                {d.body && <div className="text-sm text-gray-600 mt-1">{d.body.slice(0, 150)}</div>}
                <div className="text-xs text-gray-400 mt-1">{new Date(d.created_at).toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'resolutions' && (
        <div className="space-y-2">
          {resolutions.length === 0 && <div className="text-gray-400 text-sm">{t('gov.resolutions')}</div>}
          {resolutions.map((r) => (
            <div key={r.id} className="bg-white border rounded p-3">
              <div className="flex justify-between"><b>{r.resolution_number ? `${r.resolution_number} · ` : ''}{r.title}</b>
                <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700">{r.status}</span></div>
              <div className="text-sm text-gray-600 mt-1">{r.body}</div>
              <div className="text-xs text-gray-400 mt-1">{new Date(r.passed_at).toLocaleString()} · v{r.version}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'action' && (
        <div className="space-y-2">
          {actionItems.length === 0 && <div className="text-gray-400 text-sm">{t('gov.action')}</div>}
          {actionItems.map((a) => (
            <div key={a.id} className="bg-white border rounded p-3">
              <div className="flex justify-between"><b>{a.task}</b>
                <span className={`text-xs px-2 py-1 rounded ${a.status === 'COMPLETED' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>{a.status}</span></div>
              <div className="text-sm text-gray-500 mt-1">→ {a.role_or_member}{a.deadline ? ` · ${new Date(a.deadline).toLocaleDateString()}` : ''}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'voting' && (
        <div className="bg-white border rounded p-4 text-center text-gray-500 text-sm">
          Voting is initiated from within a meeting. Open a meeting to create and vote on proposals.
        </div>
      )}

      {tab === 'finance' && (
        <div className="bg-white border rounded divide-y">
          {auditTrail.length === 0 && <div className="p-4 text-gray-500 text-sm">No financial resolutions yet. Pass a resolution with a financial action to link it here.</div>}
          {auditTrail.map((r, i) => (
            <div key={i} className="p-3">
              <div className="flex justify-between items-center">
                <b>{r.resolution_number ? `${r.resolution_number} · ` : ''}{r.title}</b>
                <span className={`text-xs px-2 py-1 rounded ${r.execution_status === 'EXECUTED' ? 'bg-green-100 text-green-700' : r.execution_status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {r.execution_status || 'NO_LINK'}
                </span>
              </div>
              <div className="text-sm text-gray-600 mt-1">{r.body}</div>
              <div className="text-xs text-gray-400 mt-1">
                {r.financial_action_type} · {r.financial_amount ? `TZS ${Number(r.financial_amount).toLocaleString()}` : ''} · {new Date(r.passed_at).toLocaleString()}
                {r.ledger_reference && <span className="ml-2 text-blue-600">Ledger: {r.ledger_reference}</span>}
                {r.target_entity_type && <span className="ml-2">→ {r.target_entity_type}#{r.target_entity_id}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
