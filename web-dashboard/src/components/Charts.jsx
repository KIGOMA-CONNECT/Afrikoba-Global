import React from 'react';

export function ProgressRing({ value, size = 96, stroke = 10, color = '#059669', label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const off = c * (1 - v / 100);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <strong style={{ fontSize: size * 0.2, lineHeight: 1 }}>{v.toFixed(0)}%</strong>
        {label && <span style={{ fontSize: 9, color: 'var(--muted)' }}>{label}</span>}
      </div>
    </div>
  );
}

export function AreaChart({ labels = [], series = [], height = 190, format = (n) => n }) {
  const W = 600;
  const H = height;
  const P = { top: 14, right: 14, bottom: 26, left: 46 };
  const iw = W - P.left - P.right;
  const ih = H - P.top - P.bottom;
  const n = Math.max(labels.length, ...series.map((s) => s.values.length));
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const xAt = (i) => P.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yAt = (v) => P.top + ih - (Math.max(0, v) / max) * ih;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = P.top + ih * f;
    const val = Math.round(max * (1 - f));
    return (
      <g key={f}>
        <line x1={P.left} x2={W - P.right} y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />
        <text x={P.left - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">{format(val)}</text>
      </g>
    );
  });

  const xTicks = labels.map((lb, i) => (
    <text key={i} x={xAt(n <= 1 ? 0 : i)} y={H - 6} textAnchor="middle" fontSize="10" fill="#94a3b8">{lb}</text>
  ));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="chart">
        {grid}
        {xTicks}
        {series.map((s) => {
          if (!s.values.length) return null;
          const line = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
          const area = `${line} L${xAt(s.values.length - 1).toFixed(1)},${(H - P.bottom).toFixed(1)} L${xAt(0).toFixed(1)},${(H - P.bottom).toFixed(1)} Z`;
          const gid = `grad-${s.key}`;
          return (
            <g key={s.key}>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={area} fill={`url(#${gid})`} />
              <path d={line} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" />
              {s.values.map((v, i) => (
                <circle key={i} cx={xAt(i)} cy={yAt(v)} r={n <= 12 ? 3 : 0} fill={s.color}>
                  <title>{`${labels[i] || ''}: ${format(v)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap', marginTop: 6 }}>
        {series.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}