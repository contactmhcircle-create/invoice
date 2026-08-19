import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Hand-rolled SVG charts — no chart library, which keeps the bundle small
 * enough for shared hosting and the markup under our control.
 *
 * The specs follow the data-viz method: thin marks (columns ≤24px, 4px rounded
 * data-end, square baseline; 2px lines with ≥8px end markers ringed in the
 * surface colour), hairline solid gridlines, text in text tokens never series
 * colours, a hover layer by default (per-mark tooltip on columns, snapping
 * crosshair on lines with every series in one readout), a legend for two or
 * more series and none for one, and a table view so nothing is gated behind
 * hover. Palette: categorical slots 1–2 (blue #2a78d6, orange #eb6834),
 * validated as an adjacent pair for colour-vision deficiency.
 */

const SERIES = ['#2a78d6', '#eb6834'];
const TEXT_SECONDARY = '#52514e';
const GRID = '#e8e8e8';
const SURFACE = '#ffffff';

export interface SeriesPoint { label: string; values: number[] }

/** £ ticks: 0 / £1.5k / £20k — clean numbers, compact. */
function poundsCompact(pence: number): string {
  const pounds = pence / 100;
  if (pounds >= 100000) return `£${Math.round(pounds / 1000)}k`;
  if (pounds >= 10000) return `£${(pounds / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (pounds >= 1000) return `£${(pounds / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `£${Math.round(pounds).toLocaleString('en-GB')}`;
}
function poundsFull(pence: number): string {
  return `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${String(y).slice(2)}`;
}
function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? mag * 10;
  // The top tick must clear the maximum, or the tallest mark clips at the frame.
  const out: number[] = [];
  for (let v = 0; ; v += step) {
    out.push(Math.round(v));
    if (v >= max) break;
  }
  return out;
}

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

interface TooltipState { x: number; y: number; title: string; rows: Array<{ name: string; value: string; colour?: string }> }

function Tooltip({ tip }: { tip: TooltipState | null }) {
  if (!tip) return null;
  return (
    <div
      style={{
        position: 'absolute', left: tip.x, top: tip.y, transform: 'translate(-50%, calc(-100% - 10px))',
        background: '#1f2733', color: '#fff', borderRadius: 6, padding: '7px 10px', pointerEvents: 'none',
        fontSize: 12, lineHeight: 1.5, boxShadow: '0 4px 14px rgba(0,0,0,0.25)', whiteSpace: 'nowrap', zIndex: 5,
      }}
    >
      <div style={{ color: '#aeb8c4', fontSize: 11 }}>{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {r.colour && <span style={{ width: 12, height: 0, borderTop: `2.5px solid ${r.colour}`, display: 'inline-block' }} />}
          <strong>{r.value}</strong>
          <span style={{ color: '#aeb8c4' }}>{r.name}</span>
        </div>
      ))}
    </div>
  );
}

function DataTable({ points, seriesNames }: { points: SeriesPoint[]; seriesNames: string[] }) {
  return (
    <table style={{ marginTop: 8 }}>
      <thead>
        <tr><th>Month</th>{seriesNames.map((n) => <th key={n} className="num">{n}</th>)}</tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.label}>
            <td className="nowrap">{monthLabel(p.label)}</td>
            {p.values.map((v, i) => <td key={i} className="num">{poundsFull(v)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TableToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className="btn small"
      style={{ marginTop: 6 }}
      onClick={onToggle}
      aria-expanded={open}
    >
      {open ? 'Hide table' : 'View as table'}
    </button>
  );
}

/** Monthly single-series column chart with a per-column hover tooltip. */
export function ColumnChart({ points, seriesName }: { points: SeriesPoint[]; seriesName: string }) {
  const [wrapRef, width] = useWidth();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  const H = 210;
  const pad = { top: 12, right: 8, bottom: 26, left: 46 };
  const plotW = Math.max(80, width - pad.left - pad.right);
  const plotH = H - pad.top - pad.bottom;

  const max = Math.max(1, ...points.map((p) => p.values[0]));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const band = plotW / points.length;
  const barW = Math.min(24, Math.max(6, band * 0.55));

  const yFor = (v: number) => pad.top + plotH * (1 - v / top);

  if (points.every((p) => p.values[0] === 0)) {
    return <div className="small muted" style={{ padding: '18px 4px' }}>Nothing invoiced yet — the chart fills in as invoices are issued.</div>;
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <Tooltip tip={tip} />
      <svg width={width} height={H} role="img" aria-label={seriesName}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={yFor(t)} y2={yFor(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.left - 6} y={yFor(t) + 3.5} textAnchor="end" fontSize={10}
              fill={TEXT_SECONDARY} style={{ fontVariantNumeric: 'tabular-nums' }}>{poundsCompact(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = pad.left + band * i + band / 2;
          const v = p.values[0];
          const y = yFor(v);
          const h = Math.max(0, pad.top + plotH - y);
          const r = Math.min(4, h);
          return (
            <g key={p.label}>
              {v > 0 && (
                <path
                  d={`M ${cx - barW / 2} ${pad.top + plotH}
                      L ${cx - barW / 2} ${y + r} Q ${cx - barW / 2} ${y} ${cx - barW / 2 + r} ${y}
                      L ${cx + barW / 2 - r} ${y} Q ${cx + barW / 2} ${y} ${cx + barW / 2} ${y + r}
                      L ${cx + barW / 2} ${pad.top + plotH} Z`}
                  fill={SERIES[0]}
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
              )}
              {(i % 2 === 0 || points.length <= 8) && (
                <text x={cx} y={H - 8} textAnchor="middle" fontSize={10} fill={TEXT_SECONDARY}>
                  {monthLabel(p.label)}
                </text>
              )}
              <rect
                x={pad.left + band * i} y={pad.top} width={band} height={plotH} fill="transparent"
                onPointerMove={() => {
                  setHover(i);
                  setTip({
                    x: Math.min(Math.max(cx, 90), width - 90), y,
                    title: monthLabel(p.label), rows: [{ name: seriesName, value: poundsFull(v) }],
                  });
                }}
                onPointerLeave={() => { setHover(null); setTip(null); }}
              />
            </g>
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} stroke="#c9ced6" strokeWidth={1} />
      </svg>
      <TableToggle open={table} onToggle={() => setTable(!table)} />
      {table && <DataTable points={points} seriesNames={[seriesName]} />}
    </div>
  );
}

/** Two-series monthly line chart with a snapping crosshair and one readout for every series. */
export function LineChart({ points, seriesNames }: { points: SeriesPoint[]; seriesNames: string[] }) {
  const [wrapRef, width] = useWidth();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [snap, setSnap] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  const H = 210;
  const pad = { top: 12, right: 14, bottom: 26, left: 46 };
  const plotW = Math.max(80, width - pad.left - pad.right);
  const plotH = H - pad.top - pad.bottom;

  const max = Math.max(1, ...points.flatMap((p) => p.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const xFor = (i: number) => pad.left + (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
  const yFor = (v: number) => pad.top + plotH * (1 - v / top);

  const paths = useMemo(() => seriesNames.map((_, s) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.values[s])}`).join(' ')),
    [points, seriesNames, width, top]);

  if (points.every((p) => p.values.every((v) => v === 0))) {
    return <div className="small muted" style={{ padding: '18px 4px' }}>No approved work yet — the chart fills in as timesheets are approved.</div>;
  }

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.max(0, Math.min(points.length - 1,
      Math.round(((x - pad.left) / plotW) * (points.length - 1))));
    setSnap(i);
    setTip({
      x: Math.min(Math.max(xFor(i), 110), width - 110), y: yFor(Math.max(...points[i].values)),
      title: monthLabel(points[i].label),
      rows: seriesNames.map((name, s) => ({ name, value: poundsFull(points[i].values[s]), colour: SERIES[s] })),
    });
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <Tooltip tip={tip} />
      <svg width={width} height={H} role="img" aria-label={seriesNames.join(' and ')}
        onPointerMove={move} onPointerLeave={() => { setSnap(null); setTip(null); }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={yFor(t)} y2={yFor(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.left - 6} y={yFor(t) + 3.5} textAnchor="end" fontSize={10}
              fill={TEXT_SECONDARY} style={{ fontVariantNumeric: 'tabular-nums' }}>{poundsCompact(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % 2 === 0 || points.length <= 8) && (
          <text key={p.label} x={xFor(i)} y={H - 8} textAnchor="middle" fontSize={10} fill={TEXT_SECONDARY}>
            {monthLabel(p.label)}
          </text>
        ))}
        {snap !== null && (
          <line x1={xFor(snap)} x2={xFor(snap)} y1={pad.top} y2={pad.top + plotH} stroke="#b8c0cc" strokeWidth={1} />
        )}
        {paths.map((d, s) => (
          <path key={s} d={d} fill="none" stroke={SERIES[s]} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {seriesNames.map((_, s) => {
          const i = snap ?? points.length - 1;
          return (
            <circle key={s} cx={xFor(i)} cy={yFor(points[i].values[s])} r={4.5}
              fill={SERIES[s]} stroke={SURFACE} strokeWidth={2} />
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} stroke="#c9ced6" strokeWidth={1} />
      </svg>
      <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
        {seriesNames.map((name, s) => (
          <span key={name} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: TEXT_SECONDARY }}>
            <span style={{ width: 14, borderTop: `2.5px solid ${SERIES[s]}`, display: 'inline-block' }} />
            {name}
          </span>
        ))}
      </div>
      <TableToggle open={table} onToggle={() => setTable(!table)} />
      {table && <DataTable points={points} seriesNames={seriesNames} />}
    </div>
  );
}
