import React from 'react';

export function formatMoney(n) {
  return `TZS ${Number(n || 0).toLocaleString('en-US')}`;
}

export function StatusBadge({ status }) {
  const s = String(status || '').toUpperCase();
  const cls = ['SUCCESS', 'VERIFIED_ACTIVE', 'ACTIVE', 'DISBURSED', 'PASSED', 'RELEASED'].includes(s)
    ? 'success'
    : ['PENDING', 'WAITING_MEMBERS', 'PENDING_AUDIT', 'LOCKED'].includes(s)
      ? 'pending'
      : ['FAILED', 'REJECTED', 'SKIPPED', 'DEFAULTED'].includes(s)
        ? 'failed'
        : 'info';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function Loading() {
  return <div className="msg ok">Inapakia...</div>;
}
