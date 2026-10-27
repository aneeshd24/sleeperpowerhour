// Tiny dependency-free SVG chart builders. Every function returns an SVG/HTML string.
// Elements carry data-tip="..." so app.js can show a shared hover tooltip.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d = 1) => (x == null ? '–' : Number(x).toFixed(d));

// one colour per team, for marks on white cards. Checked with the dataviz palette validator (light mode, white surface):
// every adjacent pair clears the colour-blind and normal-vision separation floors. Three slots sit under 3:1 contrast on
// white, so every chart that uses them also labels the marks directly.
export const TEAM_COLORS = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300',
  '#6250d6', '#e34948', '#ad1457', '#7a8b00', '#0097a7', '#a0522d',
];

// a manager photo as a chart mark: clipped to a circle on a ring of the team colour
let clipN = 0;
export function faceDot(cx, cy, r, img, color, tip) {
  const id = `face-clip-${++clipN}`, t = tip ? ` data-tip="${esc(tip)}"` : "";
  return `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>` +
    `<circle cx="${cx}" cy="${cy}" r="${r + 2.5}" fill="${color}"${t}/>` +
    `<image href="${esc(img)}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"${t}/>`;
}

// Rank flow / bump chart: series values are ranks (1 = top)
export function bumpChart({ series, weeks, n, width = 720, height = 340, focus }) {
  const padL = 34, padR = 120, padT = 16, padB = 28;
  const w = width - padL - padR, h = height - padT - padB;
  const x = (i) => padL + (weeks.length === 1 ? w / 2 : (i / (weeks.length - 1)) * w);
  const y = (r) => padT + ((r - 1) / Math.max(1, n - 1)) * h;
  let s = `<svg viewBox="0 0 ${width} ${height}" class="chart bump" role="img" aria-label="Power rank by week">`;
  for (let r = 1; r <= n; r++) s += `<line x1="${padL}" x2="${padL + w}" y1="${y(r)}" y2="${y(r)}" class="grid"/><text x="${padL - 10}" y="${y(r) + 4}" class="axis" text-anchor="end">${r}</text>`;
  weeks.forEach((wk, i) => (s += `<text x="${x(i)}" y="${height - 6}" class="axis" text-anchor="middle">W${wk}</text>`));
  const ordered = [...series].sort((a, b) => (a.id === focus) - (b.id === focus));
  for (const se of ordered) {
    const dim = focus && se.id !== focus ? ' dim' : '';
    const d = se.values.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r).toFixed(1)}`).join('');
    s += `<g class="series${dim}" data-team="${se.id}"><path d="${d}" stroke="${se.color}" class="line" pathLength="1"/>`;
    const k = se.values.length - 1, last = se.values[k];
    // with a photo, the line ends on the manager's face
    se.values.forEach((r, i) => (s += se.img && i === k ? `<g class="face-end">${faceDot(x(i), y(r), 10, se.img, se.color, `${se.label}: #${r} after week ${weeks[i]}`)}</g>`
      : `<circle cx="${x(i)}" cy="${y(r)}" r="4.5" fill="${se.color}" data-tip="${esc(se.label)} — #${r} after week ${weeks[i]}"/>`));
    s += `<text x="${padL + w + (se.img ? 18 : 10)}" y="${y(last) + 4}" class="label" fill="${se.color}">${esc(se.short || se.label)}</text></g>`;
  }
  return s + '</svg>';
}

// Scatter with optional reference lines (league averages)
export function scatter({ points, xLabel, yLabel, refX, refY, width = 560, height = 380, quadrants, focus }) {
  const padL = 52, padR = 18, padT = 18, padB = 44;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const pad = (a, b) => [(a - (b - a) * 0.08), (b + (b - a) * 0.08)];
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const X = (v) => padL + ((v - x0) / (x1 - x0)) * (width - padL - padR);
  const Y = (v) => height - padB - ((v - y0) / (y1 - y0)) * (height - padT - padB);
  let s = `<svg viewBox="0 0 ${width} ${height}" class="chart scatter" role="img" aria-label="${esc(yLabel)} vs ${esc(xLabel)}">`;
  const ticks = (a, b) => { const st = niceStep((b - a) / 4); const out = []; for (let v = Math.ceil(a / st) * st; v <= b; v += st) out.push(v); return out; };
  ticks(x0, x1).forEach((v) => (s += `<line x1="${X(v)}" x2="${X(v)}" y1="${padT}" y2="${height - padB}" class="grid"/><text x="${X(v)}" y="${height - padB + 16}" class="axis" text-anchor="middle">${fmt(v, 0)}</text>`));
  ticks(y0, y1).forEach((v) => (s += `<line x1="${padL}" x2="${width - padR}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${padL - 8}" y="${Y(v) + 4}" class="axis" text-anchor="end">${fmt(v, 0)}</text>`));
  if (refX != null) s += `<line x1="${X(refX)}" x2="${X(refX)}" y1="${padT}" y2="${height - padB}" class="ref"/>`;
  if (refY != null) s += `<line x1="${padL}" x2="${width - padR}" y1="${Y(refY)}" y2="${Y(refY)}" class="ref"/>`;
  if (quadrants) {
    const [tl, tr, bl, br] = quadrants;
    s += `<text x="${padL + 8}" y="${padT + 14}" class="quad">${esc(tl)}</text><text x="${width - padR - 8}" y="${padT + 14}" class="quad" text-anchor="end">${esc(tr)}</text>`;
    s += `<text x="${padL + 8}" y="${height - padB - 8}" class="quad">${esc(bl)}</text><text x="${width - padR - 8}" y="${height - padB - 8}" class="quad" text-anchor="end">${esc(br)}</text>`;
  }
  s += `<text x="${padL + (width - padL - padR) / 2}" y="${height - 6}" class="axis-title" text-anchor="middle">${esc(xLabel)}</text>`;
  s += `<text transform="translate(14 ${padT + (height - padT - padB) / 2}) rotate(-90)" class="axis-title" text-anchor="middle">${esc(yLabel)}</text>`;
  for (const p of [...points].sort((a, b) => (a.id === focus) - (b.id === focus))) {
    const dim = focus && p.id !== focus ? ' dim' : '';
    const r = p.img ? (p.id === focus ? 15 : 12) : p.id === focus ? 9 : 7;
    s += `<g class="pt${dim}">${p.img ? faceDot(X(p.x), Y(p.y), r, p.img, p.color, p.tip || p.label) : `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${r}" fill="${p.color}" data-tip="${esc(p.tip || p.label)}"/>`}`;
    s += `<text x="${X(p.x) + r + (p.img ? 6 : 4)}" y="${Y(p.y) + 4}" class="pt-label">${esc(p.short || p.label)}</text></g>`;
  }
  return s + '</svg>';
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

// Radar for position-group percentiles (values 0..1)
export function radar({ axes, values, color = '#2a78d6', size = 220, tips = [] }) {
  const c = size / 2, R = size / 2 - 30;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
    return [c + Math.cos(a) * r, c + Math.sin(a) * r];
  };
  let s = `<svg viewBox="0 0 ${size} ${size}" class="chart radar" role="img" aria-label="Position group strength">`;
  for (const f of [0.25, 0.5, 0.75, 1]) s += `<polygon points="${axes.map((_, i) => pt(i, R * f).join(',')).join(' ')}" class="grid"/>`;
  axes.forEach((ax, i) => {
    const [lx, ly] = pt(i, R + 16);
    const [ex, ey] = pt(i, R);
    s += `<line x1="${c}" y1="${c}" x2="${ex}" y2="${ey}" class="grid"/><text x="${lx}" y="${ly + 4}" class="axis" text-anchor="middle">${esc(ax)}</text>`;
  });
  s += `<polygon points="${values.map((v, i) => pt(i, R * Math.max(0.04, v)).join(',')).join(' ')}" fill="${color}" fill-opacity=".22" stroke="${color}" stroke-width="2"/>`;
  values.forEach((v, i) => {
    const [x, y] = pt(i, R * Math.max(0.04, v));
    s += `<circle cx="${x}" cy="${y}" r="4" fill="${color}" data-tip="${esc(tips[i] || '')}"/>`;
  });
  return s + '</svg>';
}

// Weekly points columns with league-average line
export function weeklyBars({ weeks, avg, width = 320, height = 120 }) {
  const padB = 18, padT = 8;
  const max = Math.max(...weeks.map((w) => w.pts), ...avg, 1) * 1.08;
  const bw = width / Math.max(1, weeks.length);
  const Y = (v) => height - padB - (v / max) * (height - padB - padT);
  let s = `<svg viewBox="0 0 ${width} ${height}" class="chart weekly" role="img" aria-label="Weekly points">`;
  weeks.forEach((w, i) => {
    const x = i * bw + bw * 0.18, bwid = bw * 0.64;
    const cls = w.result === 'W' ? 'win' : w.result === 'L' ? 'loss' : '';
    s += `<rect x="${x}" y="${Y(w.pts)}" width="${bwid}" height="${height - padB - Y(w.pts)}" rx="5" class="bar ${cls}" data-tip="Week ${w.week}: ${fmt(w.pts)} pts ${w.result ? `(${w.result} ${fmt(w.pts)}–${fmt(w.oppPts)})` : ''}"/>`;
    s += `<text x="${x + bwid / 2}" y="${height - 4}" class="axis" text-anchor="middle">${w.week}</text>`;
  });
  const d = avg.map((v, i) => `${i ? 'L' : 'M'}${(i * bw + bw / 2).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  s += `<path d="${d}" class="avg-line"/>`;
  return s + '</svg>';
}

// Diverging horizontal bars (e.g. luck)
export function divergingBars({ rows, width = 520, rowH = 30, unit = '' }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 0.5);
  const labelW = 170, mid = labelW + (width - labelW) / 2, half = (width - labelW) / 2 - 58;
  let s = `<svg viewBox="0 0 ${width} ${rows.length * rowH + 8}" class="chart diverging" role="img" aria-label="Diverging bars">`;
  s += `<line x1="${mid}" x2="${mid}" y1="0" y2="${rows.length * rowH}" class="ref"/>`;
  rows.forEach((r, i) => {
    const y = i * rowH + 6, len = (Math.abs(r.value) / max) * half;
    const x = r.value >= 0 ? mid : mid - len;
    s += `<text x="${labelW - 10}" y="${y + rowH / 2}" class="row-label" text-anchor="end">${esc(r.label)}</text>`;
    s += `<rect x="${x}" y="${y + 4}" width="${Math.max(2, len)}" height="${rowH - 14}" rx="5" class="bar ${r.value >= 0 ? 'pos' : 'neg'}" data-tip="${esc(r.tip || '')}"/>`;
    s += `<text x="${r.value >= 0 ? mid + len + 6 : mid - len - 6}" y="${y + rowH / 2}" class="val" text-anchor="${r.value >= 0 ? 'start' : 'end'}">${r.value > 0 ? '+' : ''}${fmt(r.value)}${unit}</text>`;
  });
  return s + '</svg>';
}

// Week-by-week finish heatmap (HTML table). cells[rowIdx][colIdx] = {rank, tip}
export function heatTable({ rows, cols, cells, n, invert = true, caption }) {
  let h = `<div class="heat-wrap"><table class="heat"><caption class="sr-only">${esc(caption || '')}</caption><thead><tr><th></th>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((r, i) => {
    h += `<tr><th scope="row">${esc(r)}</th>`;
    cols.forEach((_, j) => {
      const c = cells[i][j];
      if (!c) { h += '<td></td>'; return; }
      const t = (c.rank - 1) / Math.max(1, n - 1); // 0 best
      const v = invert ? t : 1 - t;
      const hue = 155 - v * 155; // green -> red
      h += `<td style="--h:${hue.toFixed(0)};--a:${(0.18 + Math.abs(v - 0.5) * 0.9).toFixed(2)}" data-tip="${esc(c.tip)}">${esc(c.label ?? c.rank)}</td>`;
    });
    h += '</tr>';
  });
  return h + '</tbody></table></div>';
}
