import api from './api/client.js';

const RING_KEY = 'afrikoba_nav_events';
const MAX = 200;

export function trackNav(eventType, eventData = {}) {
  try {
    const entry = { eventType, eventData, ts: new Date().toISOString() };
    const list = JSON.parse(localStorage.getItem(RING_KEY) || '[]');
    list.push(entry);
    localStorage.setItem(RING_KEY, JSON.stringify(list.slice(-MAX)));
    api.post('/analytics/track', { eventType, eventData: { ...eventData, client: 'web-dashboard' } }).catch(() => {});
  } catch (e) {}
}