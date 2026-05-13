/* Meridian – Constraint Pitch Sensitivity
   Single IIFE exposing global App object. */

const App = (() => {

  // ── Constants ────────────────────────────────────────────────────────────

  // MSID_INFO: canonical name and temperature units for each thermal model.
  // 'C' = Celsius, 'F' = Fahrenheit — values in data files are in these native units.
  const MSID_INFO = {
    '2ceahvpt_s': { name: 'HRC-S CEA',              units: 'C' },
    '2ceahvpt_i': { name: 'HRC-I CEA',              units: 'C' },
    'pline03t':   { name: 'Propulsion Line #3',      units: 'F' },
    'pline04t':   { name: 'Propulsion Line #4',      units: 'F' },
    '1dpamzt':    { name: 'ACIS Electronics (DPA)',  units: 'C' },
    '1deamzt':    { name: 'ACIS Electronics (DEA)',  units: 'C' },
    'fptemp_11':  { name: 'ACIS Focal Plane',        units: 'C' },
    '4rt700t':    { name: 'OBA Forward Bulkhead',    units: 'F' },
    'aacccdpt':   { name: 'Aspect Camera CCD',       units: 'C' },
    'pftank2t':   { name: 'IPS Fuel Tank',           units: 'F' },
    'pm2thv1t':   { name: 'Thruster 1B',             units: 'F' },
    'pm1thv2t':   { name: 'Thruster 2A',             units: 'F' },
    '1pdeaat':    { name: 'ACIS Elec. (PSMC)',       units: 'C' },
    'tpc_fsse':   { name: 'Fine Sun Sensor Elec.',   units: 'F' },
  };

  // Derived lookup: msid → common name (used throughout rendering).
  const MSID_COMMON_NAMES = Object.fromEntries(
    Object.entries(MSID_INFO).map(([k, v]) => [k, v.name])
  );

  // Canonical inner→outer order. Only MSIDs in this list are rendered.
  // To add a new model, append its MSID here.
  const PREFERRED_ORDER = [
    '2ceahvpt_s', '2ceahvpt_i', 'pline03t', 'pline04t', '1dpamzt', '1deamzt',
    'fptemp_11', '4rt700t', 'tpc_fsse', 'aacccdpt', 'pftank2t', 'pm2thv1t', 'pm1thv2t', '1pdeaat',
  ];

  const HRC_MSIDS = new Set(['2ceahvpt_s', '2ceahvpt_i']);

  // Columns that are metadata / inputs — never treated as MSID outputs.
  const NON_OUTPUT_COLS = new Set([
    'pitch', 'date', 'datesecs', 'dwell_type', 'chips', 'roll', '2ceahvpt',
  ]);

  const COLORS = {
    limited:        'rgb(228, 172, 164)',  // rgba(220,80,60,0.40) composited over neutral band (~rgb(234,234,234))
    limitingFactor: 'rgba(200, 50, 30, 1.00)',
    offset:         'rgb(168, 192, 220)',  // rgba(70,130,200,0.40) composited over neutral band
    offsetSolid:    'rgb(156, 193, 226)',  // opaque blue for HRC overlay on top of limited red
    neutral:        'rgba(180, 180, 180, 0.28)',
  };

  // Colors for the line plot — one per entry in PREFERRED_ORDER.
  const LINE_COLORS = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2',
    '#59a14f', '#edc948', '#b07aa1', '#ff9da7',
    '#9c755f', '#bab0ac', '#d37295', '#499894',
    '#f4e685', '#86bcb6',
  ];
  function msidColor(msid) {
    const idx = PREFERRED_ORDER.indexOf(msid);
    return LINE_COLORS[idx % LINE_COLORS.length];
  }

  const GZ_CACHE_MAX = 20;  // max compressed ArrayBuffers held in memory

  // All thermal limit columns, in sidebar display order.
  // Each gets a dropdown selector regardless of how many unique values it carries.
  // Note: HRC limit columns use the format 2ceahvpt_limit_s / _i (suffix after "limit").
  const ALL_LIMITS = [
    { col: '2ceahvpt_limit_s', msid: '2ceahvpt_s' },
    { col: '2ceahvpt_limit_i', msid: '2ceahvpt_i' },
    { col: 'pline03t_limit',   msid: 'pline03t'   },
    { col: 'pline04t_limit',   msid: 'pline04t'   },
    { col: '1dpamzt_limit',    msid: '1dpamzt'    },
    { col: '1deamzt_limit',    msid: '1deamzt'    },
    { col: 'fptemp_11_limit',  msid: 'fptemp_11'  },
    { col: '4rt700t_limit',    msid: '4rt700t'    },
    { col: 'aacccdpt_limit',   msid: 'aacccdpt'   },
    { col: 'pftank2t_limit',   msid: 'pftank2t'   },
    { col: 'pm2thv1t_limit',   msid: 'pm2thv1t'   },
    { col: 'pm1thv2t_limit',   msid: 'pm1thv2t'   },
    { col: '1pdeaat_limit',    msid: '1pdeaat'    },
    { col: 'tpc_fsse_limit',   msid: 'tpc_fsse'   },
  ];

  // ── Angle helpers ─────────────────────────────────────────────────────────
  // Pitch (degrees) → math angle (radians): 0=right, CCW positive.
  //   pitch 180 → 0°  (horizontal right)
  //   pitch  90 → 90° (straight up)
  //   pitch  45 → 135° (45° above horizontal, upper-left)
  function pitchToAngle(p) { return (180 - p) * Math.PI / 180; }

  // Math angle → D3 arc angle (0 = 12 o'clock, CW positive).
  function mathToD3(a) { return Math.PI / 2 - a; }

  // ── Date label ────────────────────────────────────────────────────────────
  // Convert DOY filename prefix "YYYY-DDD-00-00-00" to a readable label.
  function doyLabel(dateStr) {
    const parts = dateStr.split('-');
    const year = +parts[0];
    const doy  = +parts[1];
    const d = new Date(year, 0, doy);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Format a thermal limit value for display in a dropdown option.
  // units: 'C' or 'F'. Data values are always in Celsius; convert to °F when needed.
  function formatLimitVal(v, units) {
    if (v === null || v === undefined) return '—';
    const display = units === 'F' ? v * 9 / 5 + 32 : v;
    const num = Number.isInteger(display) ? String(display) : display.toFixed(2);
    return units === 'F' ? `${num} °F` : `${num} °C`;
  }

  // ── Gzip LRU cache ────────────────────────────────────────────────────────
  // Maps URL → { buffer: ArrayBuffer, lastUsed: number }
  const _gzCache = new Map();

  function gzCacheGet(key) {
    const entry = _gzCache.get(key);
    if (!entry) return null;
    entry.lastUsed = Date.now();
    return entry.buffer;
  }

  function gzCachePut(key, buffer) {
    if (_gzCache.has(key)) {
      const e = _gzCache.get(key);
      e.buffer = buffer;
      e.lastUsed = Date.now();
      return;
    }
    if (_gzCache.size >= GZ_CACHE_MAX) {
      let oldestKey = null, oldestTime = Infinity;
      for (const [k, v] of _gzCache) {
        if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
      }
      _gzCache.delete(oldestKey);
    }
    _gzCache.set(key, { buffer, lastUsed: Date.now() });
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  // Fetch compressed bytes, store in LRU cache, return ArrayBuffer.
  async function fetchGz(url) {
    const cached = gzCacheGet(url);
    if (cached) return cached;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    const buffer = await resp.arrayBuffer();
    gzCachePut(url, buffer);
    return buffer;
  }

  // Decompress a gzip ArrayBuffer → text → replace NaN → JSON.parse.
  async function decompressAndParse(buffer) {
    const ds = new DecompressionStream('gzip');
    const readable = new ReadableStream({
      start(ctrl) { ctrl.enqueue(new Uint8Array(buffer)); ctrl.close(); }
    });
    const decompressed = readable.pipeThrough(ds);
    const reader = decompressed.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    const text = new TextDecoder().decode(merged).replace(/\bNaN\b/g, 'null');
    return JSON.parse(text);
  }

  // ── Data processing ───────────────────────────────────────────────────────

  // Scenario file format: { date, dwell_type, chips, columns: { col: [...] } }
  // Returns the columns object directly — already plain arrays.
  function parseScenarioColumns(raw) {
    return raw.columns;
  }

  // Filter rows by selected limit values, then reduce to one row per pitch using min.
  // cols: raw columns object (arrays of equal length)
  // selectedLimits: Map<colName, numericValue>
  function filterAndAggregate(cols, selectedLimits) {
    const pitches = cols.pitch;
    const n = pitches.length;

    // Build inclusion mask — include[i] = 1 iff row i passes all limit filters
    const include = new Uint8Array(n).fill(1);
    for (const [col, val] of selectedLimits) {
      const arr = cols[col];
      if (!arr) continue;
      for (let i = 0; i < n; i++) {
        if (include[i] && arr[i] !== val) include[i] = 0;
      }
    }

    const msidKeys = Object.keys(cols).filter(k => k !== 'pitch' && k !== 'datesecs' && k !== 'roll');
    const pitchSet = [...new Set(pitches)].sort((a, b) => a - b);
    const out = { pitch: pitchSet };
    for (const k of msidKeys) {
      out[k] = pitchSet.map(p => {
        let min = null;
        for (let i = 0; i < n; i++) {
          if (!include[i] || pitches[i] !== p) continue;
          const v = cols[k][i];
          if (v != null && isFinite(v)) min = min === null ? v : Math.min(min, v);
        }
        return min;
      });
    }
    return out;
  }

  function detectMsids(arrays) {
    return Object.keys(arrays).filter(k => !NON_OUTPUT_COLS.has(k) && !k.endsWith('_limit'));
  }

  // Returns Map<pitch, Map<msid, { limMin, offMin }>>
  function buildPitchSummary(lim, off, msids) {
    const pitchArr = lim.pitch;
    const summary  = new Map();
    for (let i = 0; i < pitchArr.length; i++) {
      const p = pitchArr[i];
      if (!summary.has(p)) summary.set(p, new Map());
      const pm = summary.get(p);
      for (const msid of msids) {
        if (!pm.has(msid)) pm.set(msid, { limMin: null, offMin: null });
        const entry = pm.get(msid);
        const lv = lim[msid]?.[i];
        const ov = off[msid]?.[i];
        if (lv != null && isFinite(lv)) entry.limMin = entry.limMin === null ? lv : Math.min(entry.limMin, lv);
        if (ov != null && isFinite(ov)) entry.offMin = entry.offMin === null ? ov : Math.min(entry.offMin, ov);
      }
    }
    return summary;
  }

  // Returns Map<pitch, Set<msid>> — MSIDs with the strictly lowest limMin at each pitch.
  function findLimitingMsids(summary, msids) {
    const result = new Map();
    for (const [pitch, pm] of summary) {
      let minVal = Infinity;
      for (const msid of msids) {
        const v = pm.get(msid)?.limMin;
        if (v != null && v < minVal) minVal = v;
      }
      const limiters = new Set();
      if (isFinite(minVal)) {
        for (const msid of msids) {
          if (pm.get(msid)?.limMin === minVal) limiters.add(msid);
        }
      }
      result.set(pitch, limiters);
    }
    return result;
  }

  // Return only MSIDs from PREFERRED_ORDER that have at least one non-null value.
  function activeMsids(summary) {
    return PREFERRED_ORDER.filter(msid => {
      for (const pm of summary.values()) {
        const e = pm.get(msid);
        if (e && (e.limMin !== null || e.offMin !== null)) return true;
      }
      return false;
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderNoData(container) {
    container.innerHTML = '';
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:2rem 1.5rem;font-size:1rem;color:#444;line-height:1.8;';
    msg.innerHTML = `
      <p style="font-weight:600;margin-bottom:.75rem;">
        No data exists for the chosen set of conditions.
      </p>
      <p style="margin-bottom:.4rem;">If you expected data to be available, consider the following notes:</p>
      <ol style="margin:0;padding-left:1.4rem;">
        <li>Both propulsion lines are usually set to the same limit</li>
        <li>Both MUPS valves are usually set to the same limit</li>
        <li>A large range of ACA limits are usually available, however not all ACA conditions have data associated with every other location condition</li>
      </ol>
    `;
    container.appendChild(msg);
  }

  function render(container, lim, off, meta, conditions) {
    const allMsids = detectMsids(lim);
    const summary  = buildPitchSummary(lim, off, allMsids);
    const msids    = activeMsids(summary);
    const limiting = findLimitingMsids(summary, msids.filter(m => !HRC_MSIDS.has(m)));
    const nBands   = msids.length;

    if (nBands === 0) {
      renderNoData(container);
      const pitches = Array.from(summary.keys()).sort((a, b) => a - b);
      return { summary, msids, pitches };
    }

    const pitches   = Array.from(summary.keys()).sort((a, b) => a - b);
    const pitchStep = pitches.length > 1 ? pitches[1] - pitches[0] : 1;
    const halfStep  = pitchStep / 2;

    // ── Layout ──────────────────────────────────────────────────────────────
    const W = container.clientWidth || 900;
    const H = Math.round(W * 0.5);

    const marginTop    = H * 0.12;
    const marginBottom = H * 0.13;
    const labelAreaW   = W * 0.22;
    const marginRight  = W * 0.04;

    const pitchPad = 0.10;

    const availH = H - marginTop - marginBottom;
    const availW = W - labelAreaW - marginRight;

    const outerR = Math.min(
      availH / (1 + pitchPad),
      availW / (1.707 + pitchPad)
    );
    const pitchLabelRoom = outerR * pitchPad;

    const innerGap   = outerR * 0.25;
    const bandGap    = Math.max(0.8, outerR * 0.007);
    const bandW      = (outerR - innerGap - bandGap * (nBands - 1)) / nBands;

    const labelFontSize = Math.max(7, Math.min(14, bandW * 0.72));
    const pitchFontSize = Math.max(8, Math.min(14, outerR * 0.062));

    const cx = labelAreaW + outerR / Math.SQRT2;
    const cy = H - marginBottom;

    const arcGen = d3.arc()
      .innerRadius(d => d.iR)
      .outerRadius(d => d.oR)
      .startAngle(d => mathToD3(pitchToAngle(d.pitchLo)))
      .endAngle(d =>   mathToD3(pitchToAngle(d.pitchHi)));

    const pitchLo0 = pitches[0]               - halfStep;
    const pitchHi0 = pitches[pitches.length-1] + halfStep;

    // ── Build SVG ────────────────────────────────────────────────────────────
    container.innerHTML = '';
    const svg = d3.select(container).append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

    // ── Bands ────────────────────────────────────────────────────────────────
    msids.forEach((msid, bi) => {
      const iR   = innerGap + bi * (bandW + bandGap);
      const oR   = iR + bandW;
      const rMid = (iR + oR) / 2;
      const isHRC = HRC_MSIDS.has(msid);

      // Neutral background (full pitch span)
      g.append('path')
        .datum({ iR, oR, pitchLo: pitchLo0, pitchHi: pitchHi0 })
        .attr('d', arcGen)
        .attr('fill', COLORS.neutral);

      // Limited (light red) — full band width for all MSIDs
      pitches.forEach(p => {
        const e = summary.get(p)?.get(msid);
        if (e?.limMin == null) return;
        g.append('path')
          .datum({ iR, oR, pitchLo: p - halfStep, pitchHi: p + halfStep })
          .attr('d', arcGen).attr('fill', COLORS.limited)
          .attr('stroke', COLORS.limited).attr('stroke-width', 0.5);
      });

      // Offset (light blue).
      // Non-HRC: only shown at pitches that are NOT limited (no limMin).
      // HRC: shown whenever offMin is present, overlaid on the outer half of the band,
      //      even when limMin is also present — every offset pitch for HRC also has a
      //      limited value, so the "not limited" guard would suppress all blue bars.
      pitches.forEach(p => {
        const e = summary.get(p)?.get(msid);
        if (e?.offMin == null) return;
        if (!isHRC && e?.limMin != null) return;
        const offIR = isHRC ? rMid : iR;
        const offColor = isHRC ? COLORS.offsetSolid : COLORS.offset;
        g.append('path')
          .datum({ iR: offIR, oR, pitchLo: p - halfStep, pitchHi: p + halfStep })
          .attr('d', arcGen).attr('fill', offColor)
          .attr('stroke', offColor).attr('stroke-width', 0.5);
      });

      // Limiting factor overlay (dark red) — full band
      pitches.forEach(p => {
        const e = summary.get(p)?.get(msid);
        if (e?.limMin == null || !limiting.get(p)?.has(msid)) return;
        g.append('path')
          .datum({ iR, oR, pitchLo: p - halfStep, pitchHi: p + halfStep })
          .attr('d', arcGen).attr('fill', COLORS.limitingFactor)
          .attr('stroke', COLORS.limitingFactor).attr('stroke-width', 0.5);
      });

      // ── Label: 45° angle, right-justified, perpendicular to pitch=45 boundary ──
      const ang45 = pitchToAngle(45);  // 135° = 3π/4
      const labelR = rMid - bandW * 0.35;
      const lx = labelR * Math.cos(ang45) - Math.max(6, labelFontSize * 0.75);
      const ly = -labelR * Math.sin(ang45);
      g.append('text')
        .attr('transform', `translate(${lx},${ly}) rotate(-45)`)
        .attr('text-anchor', 'end')
        .attr('dominant-baseline', 'middle')
        .attr('font-size', labelFontSize)
        .attr('fill', '#333')
        .text(MSID_COMMON_NAMES[msid] || msid);
    });

    // ── Pitch angle ticks and labels ─────────────────────────────────────────
    const tickPitches = [45, 60, 75, 90, 105, 120, 135, 150, 165, 180];
    const tickInnerR  = outerR + 2;
    const tickOuterR  = outerR + pitchLabelRoom * 0.38;
    const labelR      = outerR + pitchLabelRoom * 0.72;

    tickPitches.forEach(p => {
      const a  = pitchToAngle(p);
      const cx_ = Math.cos(a), sy_ = Math.sin(a);

      g.append('line')
        .attr('x1', tickInnerR * cx_).attr('y1', -tickInnerR * sy_)
        .attr('x2', tickOuterR * cx_).attr('y2', -tickOuterR * sy_)
        .attr('stroke', '#999').attr('stroke-width', 0.8);

      g.append('text')
        .attr('x', labelR * cx_).attr('y', -labelR * sy_)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('font-size', pitchFontSize).attr('fill', '#555')
        .text(`${p}°`);
    });

    // ── Title ────────────────────────────────────────────────────────────────
    const titleFontSize    = Math.max(12, pitchFontSize * 2.5);
    const subtitleFontSize = Math.max(9,  pitchFontSize * 0.88);

    svg.append('text')
      .attr('x', W / 2).attr('y', marginTop * 0.6)
      .attr('text-anchor', 'middle')
      .attr('font-size', titleFontSize).attr('font-weight', '500').attr('fill', '#444')
      .text('Constraint Pitch Sensitivity');

    // if (meta.date) {
    //   let sub = meta.date;
    //   if (meta.chips != null) sub += `  |  chips = ${meta.chips}`;
    //   svg.append('text')
    //     .attr('x', W / 2).attr('y', marginTop * 0.72)
    //     .attr('text-anchor', 'middle')
    //     .attr('font-size', subtitleFontSize).attr('fill', '#777')
    //     .text(sub);
    // }

    // ── Legend ────────────────────────────────────────────────────────────────
    drawLegend(svg, W, marginTop, pitchFontSize);

    return { summary, msids, pitches };
  }

  function drawLegend(svg, W, marginTop, fontSize) {
    const items = [
      { color: COLORS.limited,        label: 'Limited Pitch Range' },
      { color: COLORS.limitingFactor, label: 'Limiting Factor'     },
      { color: COLORS.neutral,        label: 'Neutral'             },
      { color: COLORS.offset,         label: 'Offset Pitch Range'  },
    ];
    const swatchW = Math.max(10, fontSize * 1.1);
    const swatchH = Math.max(8,  fontSize * 0.9);
    const lineH   = swatchH + 5;
    const padX = 8, padY = 6;
    const boxW  = 152;
    const boxH  = items.length * lineH + padY * 2;
    const lx    = W - boxW - 8;
    const ly    = marginTop * 0.05;

    const leg = svg.append('g').attr('transform', `translate(${lx},${ly})`);
    leg.append('rect')
      .attr('width', boxW).attr('height', boxH).attr('rx', 3)
      .attr('fill', 'rgba(255,255,255,0.85)').attr('stroke', '#ddd').attr('stroke-width', 0.8);

    items.forEach((item, i) => {
      const iy = padY + i * lineH;
      leg.append('rect')
        .attr('x', padX).attr('y', iy)
        .attr('width', swatchW).attr('height', swatchH)
        .attr('fill', item.color);
      leg.append('text')
        .attr('x', padX + swatchW + 5).attr('y', iy + swatchH / 2)
        .attr('dominant-baseline', 'middle')
        .attr('font-size', Math.max(7, fontSize * 0.82)).attr('fill', '#444')
        .text(item.label);
    });
  }

  // ── Conditions legend (HTML card below chart) ────────────────────────────

  // Build the flat list of {label, value} pairs shown in the conditions legend.
  function buildConditions(rawLim, selectedLimits) {
    const items = [];
    const dateVal  = document.getElementById('sel-date')?.value  ?? '';
    const chipsVal = document.getElementById('sel-chips')?.value ?? '';
    items.push({ label: 'Date',  value: dateVal  ? doyLabel(dateVal) : '—' });
    items.push({ label: 'Chips', value: chipsVal || '—' });
    for (const { col, msid } of ALL_LIMITS) {
      const v     = selectedLimits.get(col);
      const units = MSID_INFO[msid]?.units ?? 'C';
      items.push({ label: MSID_COMMON_NAMES[msid] || msid,
                   value: v != null ? formatLimitVal(v, units) : '—' });
    }
    return items;
  }

  // Render conditions as an HTML grid in the legend card below the chart.
  function renderConditionsLegend(conditions) {
    const card    = document.getElementById('legend-card');
    const content = document.getElementById('legend-content');
    if (!card || !content || !conditions || conditions.length === 0) return;

    content.innerHTML = '';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(4,1fr); gap:.15rem .75rem;';

    conditions.forEach(({ label, value }) => {
      const cell = document.createElement('div');
      cell.style.cssText = 'font-size:.78rem; color:#444; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      cell.innerHTML = `<span style="font-weight:600;">${label}:</span> ${value}`;
      grid.appendChild(cell);
    });

    content.appendChild(grid);
    card.style.display = '';
  }


  // ── Line plot ─────────────────────────────────────────────────────────────

  function renderLineplot(container, lim, off, msids) {
    container.innerHTML = '';

    if (!msids || msids.length === 0) {
      renderNoData(container);
      return;
    }

    const LEGEND_W = 170;
    const W      = Math.max((container.clientWidth || 900) - LEGEND_W, 400);
    const H      = Math.round(W * 0.5);
    const margin = { top: 84, right: 24, bottom: 50, left: 78 };
    const iW     = W - margin.left - margin.right;
    const iH     = H - margin.top  - margin.bottom;

    // Outer wrapper: chart on left, legend on right
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:row;align-items:flex-start;';
    const chartDiv = document.createElement('div');
    chartDiv.style.cssText = 'flex:0 0 auto;';
    const legendDiv = document.createElement('div');
    legendDiv.style.cssText = [
      `width:${LEGEND_W}px`, 'flex-shrink:0',
      `padding-top:${margin.top}px`,
      'display:flex', 'flex-direction:column', 'gap:.35rem',
      'font-size:.75rem', 'color:#444',
    ].join(';');
    wrapper.appendChild(chartDiv);
    wrapper.appendChild(legendDiv);
    container.appendChild(wrapper);

    const pitchArr = lim.pitch;

    // Y domain: max across all lim + off values
    let yMax = 0;
    for (const msid of msids) {
      for (const v of (lim[msid] ?? [])) { if (v != null && v > yMax) yMax = v; }
      for (const v of (off[msid] ?? [])) { if (v != null && v > yMax) yMax = v; }
    }
    yMax = Math.min(yMax || 100000, 100000);  // cap at 100,000 seconds (100 ksec)

    const xScale = d3.scaleLinear().domain([45, 180]).range([0, iW]);
    const yScale = d3.scaleLinear().domain([0, yMax]).range([iH, 0]).nice();

    const clipId = 'lp-clip';

    const svg = d3.select(chartDiv).append('svg')
      .attr('width', W).attr('height', H).attr('display', 'block');

    // Clip path — restricts lines to the chart area
    svg.append('defs').append('clipPath').attr('id', clipId)
      .append('rect').attr('width', iW).attr('height', iH);

    // Title
    svg.append('text')
      .attr('x', margin.left + iW / 2).attr('y', 50)
      .attr('text-anchor', 'middle').attr('font-size', 34)
      .attr('font-weight', '500').attr('fill', '#444')
      .text('Composite Dwell Capability');

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Gridlines
    g.append('g')
      .call(d3.axisLeft(yScale).tickSize(-iW).tickFormat(''))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('.tick line')
        .attr('stroke', '#e5e7eb').attr('stroke-dasharray', '3,3'));

    // X axis
    g.append('g').attr('transform', `translate(0,${iH})`)
      .call(d3.axisBottom(xScale)
        .tickValues([45,60,75,90,105,120,135,150,165,180])
        .tickFormat(d => `${d}°`))
      .call(ax => ax.selectAll('text').attr('font-size', 16));
    g.append('text')
      .attr('x', iW / 2).attr('y', iH + 42)
      .attr('text-anchor', 'middle').attr('font-size', 16).attr('fill', '#555')
      .text('Pitch');

    // Y axis
    g.append('g')
      .call(d3.axisLeft(yScale).tickFormat(d => `${d / 1000}k`))
      .call(ax => ax.selectAll('text').attr('font-size', 16));
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -iH / 2).attr('y', -62)
      .attr('text-anchor', 'middle').attr('font-size', 16).attr('fill', '#555')
      .text('Dwell Duration (Kiloseconds)');

    const lineGen = d3.line()
      .defined(d => d.v != null && isFinite(d.v))
      .x(d => xScale(d.p))
      .y(d => yScale(d.v));

    // All lines drawn inside a clipped group
    const linesG = g.append('g').attr('clip-path', `url(#${clipId})`);

    // Composite minimum (non-HRC limited) — thick gray, drawn first (behind)
    const compData = pitchArr.map((p, i) => {
      let min = null;
      for (const msid of msids) {
        if (HRC_MSIDS.has(msid)) continue;
        const v = lim[msid]?.[i];
        if (v != null && isFinite(v)) min = min === null ? v : Math.min(min, v);
      }
      return { p, v: min };
    });
    linesG.append('path')
      .datum(compData)
      .attr('d', lineGen)
      .attr('fill', 'none')
      .attr('stroke', '#bbbbbb')
      .attr('stroke-width', 12)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round');

    const linesByMsid      = new Map();
    const legendSpanByMsid = new Map();

    // Per-MSID lines (visible, drawn first)
    for (const msid of msids) {
      const color   = msidColor(msid);
      const limData = pitchArr.map((p, i) => ({ p, v: lim[msid]?.[i] ?? null }));
      const offData = pitchArr.map((p, i) => ({ p, v: off[msid]?.[i] ?? null }));

      // Limited: thin solid
      const limPath = linesG.append('path').datum(limData)
        .attr('d', lineGen).attr('fill', 'none')
        .attr('stroke', color).attr('stroke-width', 3);

      // Offset: thin dashed
      const offPath = linesG.append('path').datum(offData)
        .attr('d', lineGen).attr('fill', 'none')
        .attr('stroke', color).attr('stroke-width', 2)
        .attr('stroke-dasharray', '5,3');

      linesByMsid.set(msid, { limPath, offPath, limData, offData });
    }

    // Per-MSID hit areas + hover handlers (drawn on top of all visible lines)
    const hitAreasByMsid = new Map();
    for (const [msid, { limPath, offPath, limData, offData }] of linesByMsid) {
      const onEnter = () => {
        limPath.attr('stroke-width', 6);
        offPath.attr('stroke-width', 4);
        const span = legendSpanByMsid.get(msid);
        if (span) span.style.fontWeight = '700';
      };
      const onLeave = () => {
        limPath.attr('stroke-width', 3);
        offPath.attr('stroke-width', 2);
        const span = legendSpanByMsid.get(msid);
        if (span) span.style.fontWeight = '';
      };
      const hitPaths = [];
      for (const data of [limData, offData]) {
        const hp = linesG.append('path').datum(data)
          .attr('d', lineGen).attr('fill', 'none')
          .attr('stroke', 'transparent').attr('stroke-width', 10)
          .style('pointer-events', 'stroke').style('cursor', 'pointer')
          .on('mouseenter', onEnter).on('mouseleave', onLeave);
        hitPaths.push(hp);
      }
      hitAreasByMsid.set(msid, hitPaths);
    }

    // ── Legend (vertical column to the right of SVG) ────────────────────────
    const compEl = document.createElement('div');
    compEl.style.cssText = 'display:flex;align-items:center;gap:.3rem;';
    const compSwatch = document.createElement('div');
    compSwatch.style.cssText = 'width:22px;height:6px;background:#999;border-radius:2px;flex-shrink:0;';
    compEl.appendChild(compSwatch);
    compEl.appendChild(Object.assign(document.createElement('span'), { textContent: 'Composite Min' }));
    legendDiv.appendChild(compEl);

    for (const msid of msids) {
      const color = msidColor(msid);
      const name  = MSID_COMMON_NAMES[msid] || msid;
      const item  = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:.3rem;cursor:pointer;user-select:none;';
      const swatch = document.createElement('div');
      const nameSpan = Object.assign(document.createElement('span'), { textContent: name });
      legendSpanByMsid.set(msid, nameSpan);

      const isHidden = hiddenMsids.has(msid);
      swatch.style.cssText = `width:16px;height:2px;background:${isHidden ? '#ccc' : color};flex-shrink:0;`;
      if (isHidden) nameSpan.style.color = '#bbb';

      item.appendChild(swatch);
      item.appendChild(nameSpan);
      legendDiv.appendChild(item);

      if (isHidden) {
        const { limPath, offPath } = linesByMsid.get(msid);
        limPath.style('display', 'none');
        offPath.style('display', 'none');
        hitAreasByMsid.get(msid)?.forEach(p => p.style('pointer-events', 'none'));
      }

      item.addEventListener('click', () => {
        if (hiddenMsids.has(msid)) {
          hiddenMsids.delete(msid);
          swatch.style.background = color;
          nameSpan.style.color = '';
          const { limPath, offPath } = linesByMsid.get(msid);
          limPath.style('display', '');
          offPath.style('display', '');
          hitAreasByMsid.get(msid)?.forEach(p => p.style('pointer-events', 'stroke'));
        } else {
          hiddenMsids.add(msid);
          swatch.style.background = '#ccc';
          nameSpan.style.color = '#bbb';
          const { limPath, offPath } = linesByMsid.get(msid);
          limPath.style('display', 'none');
          offPath.style('display', 'none');
          hitAreasByMsid.get(msid)?.forEach(p => p.style('pointer-events', 'none'));
        }
      });
    }

    // Notes below the chart
    const notes = document.createElement('div');
    notes.style.cssText = `font-size:.78rem;color:#666;margin-top:.5rem;padding-left:${margin.left}px;line-height:1.6;`;
    notes.innerHTML = 'Solid lines represent limited dwell time<br>Dashed lines represent offset dwell time';
    container.appendChild(notes);
  }

  // ── Data tables ───────────────────────────────────────────────────────────

  function renderTables(summary, msids, pitches) {
    const area = document.getElementById('tables-area');
    if (!area) return;
    area.innerHTML = '';

    const fmt = v => (v == null) ? '—' : v.toFixed(1);

    function makeTableCard(title, getter) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.marginTop = '2rem';

      const heading = document.createElement('h6');
      heading.style.cssText = 'font-weight:600;color:#444;margin-bottom:.75rem;';
      heading.textContent = title;
      card.appendChild(heading);

      const wrapper = document.createElement('div');
      wrapper.style.overflowX = 'auto';
      card.appendChild(wrapper);

      const table = document.createElement('table');
      table.className = 'table table-sm table-striped table-bordered mb-0';
      table.style.fontSize = '0.78rem';
      table.style.width = '100%';
      wrapper.appendChild(table);

      const thead = table.createTHead();
      const hrow = thead.insertRow();
      const th0 = document.createElement('th');
      th0.textContent = 'Pitch';
      th0.style.width = '2.5rem';
      th0.style.textAlign = 'center'; 
      th0.style.verticalAlign = 'middle';     hrow.appendChild(th0);
      for (const msid of msids) {
        const th = document.createElement('th');
        th.textContent = MSID_COMMON_NAMES[msid] || msid;
        th.style.width = '2.5rem';
        th.style.whiteSpace = 'wrap';
        th.style.textAlign = 'center'; 
        th.style.verticalAlign = 'middle';
        hrow.appendChild(th);
      }
      const thLimiter = document.createElement('th');
      thLimiter.textContent = 'Limiting Model';
      thLimiter.style.fontStyle = 'italic';
      thLimiter.style.width = '5rem';
      thLimiter.style.textAlign = 'center'; 
      thLimiter.style.verticalAlign = 'middle';      
      hrow.appendChild(thLimiter);
      const thMin = document.createElement('th');
      thMin.textContent = 'Composite Minimum';
      thMin.style.fontStyle = 'italic';
      thMin.style.width = '3.5rem';
      thMin.style.textAlign = 'center'; 
      thMin.style.verticalAlign = 'middle';      
      hrow.appendChild(thMin);

      const tbody = table.createTBody();
      for (const p of pitches) {
        const row = tbody.insertRow();
        const td0 = row.insertCell();
        td0.textContent = p;
        td0.style.fontWeight = '500';
        td0.style.whiteSpace = 'nowrap';
        let rowMin = null;
        let rowMinMsid = null;
        for (const msid of msids) {
          const td = row.insertCell();
          const val = getter(summary.get(p)?.get(msid));
          td.textContent = fmt(val);
          td.style.textAlign = 'right';
          td.style.whiteSpace = 'nowrap';
          td.style.fontVariantNumeric = 'tabular-nums';
          td.style.textAlign = 'right';
          if (!HRC_MSIDS.has(msid) && val != null && (rowMin === null || val < rowMin)) { rowMin = val; rowMinMsid = msid; }
        }
        const tdLimiter = row.insertCell();
        tdLimiter.textContent = rowMinMsid ? (MSID_COMMON_NAMES[rowMinMsid] || rowMinMsid) : '—';
        tdLimiter.style.fontWeight = '600';
        tdLimiter.style.textAlign = 'right';
        const tdMin = row.insertCell();
        tdMin.textContent = fmt(rowMin);
        tdMin.style.textAlign = 'right';
        tdMin.style.whiteSpace = 'nowrap';
        tdMin.style.fontVariantNumeric = 'tabular-nums';
        tdMin.style.fontWeight = '600';
      }

      return card;
    }

    area.appendChild(makeTableCard('Limited Dwell Times (sec)', e => e?.limMin ?? null));
    area.appendChild(makeTableCard('Offset Dwell Times (sec)',  e => e?.offMin ?? null));
  }

  // ── Error display ─────────────────────────────────────────────────────────
  function showError(msg) {
    const el = document.getElementById('error-panel');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function clearError() {
    const el = document.getElementById('error-panel');
    el.style.display = 'none';
    el.textContent = '';
  }

  // ── Condition selectors ───────────────────────────────────────────────────

  // Populate all limit dropdowns from raw columns.
  // Preserves current selection if still valid in the new data; else picks middle value.
  function populateLimitDropdowns(rawCols) {
    for (const { col, msid } of ALL_LIMITS) {
      const sel = document.getElementById(`sel-${col}`);
      if (!sel) continue;
      const units = MSID_INFO[msid]?.units ?? 'C';
      const prevVal = sel.value !== '' ? +sel.value : null;
      sel.innerHTML = '';
      const vals = [...new Set((rawCols[col] ?? []).filter(v => v != null))].sort((a, b) => a - b);
      for (const v of vals) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = formatLimitVal(v, units);
        sel.appendChild(opt);
      }
      const stillValid = prevVal !== null && vals.some(v => Math.abs(v - prevVal) < 1e-9);
      sel.value = stillValid ? String(prevVal) : String(vals[Math.floor(vals.length / 2)] ?? '');
    }
  }

  // Read current limit select values into a Map<colName, numericValue>.
  function getSelectedLimits() {
    const m = new Map();
    for (const { col } of ALL_LIMITS) {
      const sel = document.getElementById(`sel-${col}`);
      if (sel && sel.value !== '') m.set(col, +sel.value);
    }
    return m;
  }

  // Disable/enable all selects in #condition-bar at once.
  function setAllControlsDisabled(disabled) {
    const bar = document.getElementById('condition-bar');
    if (!bar) return;
    for (const sel of bar.querySelectorAll('select')) sel.disabled = disabled;
  }

  // ── Data load entry point ─────────────────────────────────────────────────

  // Fetch and decompress scenario files; return raw (un-aggregated) columns.
  async function loadRaw(date, chips) {
    const limUrl = `../timbre_data_b073e82_3.73.1/${date}_limit_chips${chips}.json.gz`;
    const offUrl = `../timbre_data_b073e82_3.73.1/${date}_offset_chips${chips}.json.gz`;
    const [limBuf, offBuf] = await Promise.all([fetchGz(limUrl), fetchGz(offUrl)]);
    const [rawLim, rawOff] = await Promise.all([
      decompressAndParse(limBuf),
      decompressAndParse(offBuf),
    ]);
    return {
      rawLim: parseScenarioColumns(rawLim),
      rawOff: parseScenarioColumns(rawOff),
      meta: { date: rawLim.date ?? null, dwell_type: rawLim.dwell_type ?? null, chips: rawLim.chips ?? null },
    };
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  let _loadedData      = null;  // { rawLim, rawOff, meta }
  let _lastRenderArgs  = null;  // [container, lim, off, meta, conditions] for resize
  let _lastLineplotArgs = null; // [container, lim, off, msids] for resize
  const hiddenMsids = new Set();

  // Re-filter in memory and re-render. No fetch. Called on limit dropdown changes.
  function refilterAndRender() {
    if (!_loadedData) return;
    const { rawLim, rawOff, meta } = _loadedData;
    const selectedLimits = getSelectedLimits();
    const lim        = filterAndAggregate(rawLim, selectedLimits);
    const off        = filterAndAggregate(rawOff, selectedLimits);
    const conditions = buildConditions(rawLim, selectedLimits);

    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('chart-tabs').style.display = '';

    const protractorContainer = document.getElementById('chart-container');
    _lastRenderArgs = [protractorContainer, lim, off, meta, conditions];
    const { summary, msids, pitches } = render(protractorContainer, lim, off, meta, conditions);

    const lineplotContainer = document.getElementById('lineplot-container');
    _lastLineplotArgs = [lineplotContainer, lim, off, msids];
    renderLineplot(lineplotContainer, lim, off, msids);

    renderConditionsLegend(conditions);
    renderTables(summary, msids, pitches);
  }

  // Fetch+decompress, populate limit dropdowns, then render.
  async function loadAndRender() {
    setAllControlsDisabled(true);
    clearError();
    document.getElementById('loading-state').style.display = 'flex';
    document.getElementById('chart-tabs').style.display = 'none';
    document.getElementById('tables-area').innerHTML = '';
    try {
      const selDate  = document.getElementById('sel-date');
      const selChips = document.getElementById('sel-chips');
      _loadedData = await loadRaw(selDate.value, +selChips.value);
      populateLimitDropdowns(_loadedData.rawLim);
      hiddenMsids.clear();
      refilterAndRender();
    } catch (err) {
      document.getElementById('loading-state').style.display = 'none';
      showError(`Failed to load data: ${err.message}`);
      console.error(err);
    } finally {
      setAllControlsDisabled(false);
    }
  }

  async function init() {
    try {
      const manifest = await fetch('../timbre_data_b073e82_3.73.1/manifest.json').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: manifest.json`);
        return r.json();
      });

      const selDate  = document.getElementById('sel-date');
      const selChips = document.getElementById('sel-chips');

      for (const d of manifest.dates) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = doyLabel(d);
        selDate.appendChild(opt);
      }
      for (const c of manifest.chips) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        selChips.appendChild(opt);
      }
      selDate.value  = manifest.dates[0];
      selChips.value = manifest.chips.includes(4) ? 4 : manifest.chips[0];

      await loadAndRender();

      selDate.addEventListener('change',  () => loadAndRender());
      selChips.addEventListener('change', () => loadAndRender());
      for (const { col } of ALL_LIMITS) {
        document.getElementById(`sel-${col}`)
          ?.addEventListener('change', () => refilterAndRender());
      }

      // Re-render the line plot at correct width when its tab becomes visible.
      document.getElementById('tab-lineplot-btn')
        ?.addEventListener('shown.bs.tab', () => {
          if (_lastLineplotArgs) renderLineplot(..._lastLineplotArgs);
        });

      let resizeTimer;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (_lastRenderArgs)  render(..._lastRenderArgs);
          if (_lastLineplotArgs) renderLineplot(..._lastLineplotArgs);
        }, 150);
      });

    } catch (err) {
      document.getElementById('loading-state').style.display = 'none';
      showError(`Failed to initialize: ${err.message}`);
      console.error(err);
    }

    // Changelog fetch is independent of data loading — runs in parallel.
    fetch('./changelog.md')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(text => {
        const container = document.getElementById('tab-changelog-content');
        if (container) renderChangelogEntries(parseChangelog(text), container);
      })
      .catch(() => {
        const container = document.getElementById('tab-changelog-content');
        if (container) container.innerHTML =
          '<span style="color:#888;font-size:.85rem;">Changelog unavailable.</span>';
      });
  }

  // ── Changelog ─────────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Parse changelog.md into an array of entry objects.
  // Each ## header starts a new entry; **Key:** value lines are metadata;
  // markdown table rows (after the header and separator rows) are config params.
  function parseChangelog(text) {
    const entries = [];
    const sections = text.split(/\n(?=## )/);
    for (const section of sections) {
      const firstLine = section.split('\n')[0];
      if (!firstLine.startsWith('## ')) continue;
      const entry = { title: firstLine.slice(3).trim(), meta: {}, params: [] };
      let tablePhase = 0; // 0=preamble 1=header-seen 2=reading-data
      for (const line of section.split('\n').slice(1)) {
        const t = line.trim();
        if (tablePhase === 0) {
          const m = t.match(/^\*\*([^*]+)\*\*:?\s*(.*)/);
          if (m && m[2]) { entry.meta[m[1].trim()] = m[2].trim(); continue; }
        }
        if (t.startsWith('|') && t.endsWith('|')) {
          const cells = t.split('|').slice(1, -1).map(c => c.trim());
          if (tablePhase === 0) { tablePhase = 1; continue; } // header row
          if (tablePhase === 1) { tablePhase = 2; continue; } // separator row
          if (cells.length >= 2) entry.params.push({ param: cells[0], values: cells[1] || '—' });
          continue;
        }
        if (tablePhase > 0 && t !== '') tablePhase = 0;
      }
      entries.push(entry);
    }
    return entries;
  }

  function renderChangelogEntries(entries, container) {
    container.innerHTML = '';
    if (!entries || entries.length === 0) {
      container.innerHTML = '<span style="color:#888;font-size:.85rem;">No changelog entries found.</span>';
      return;
    }
    entries.forEach((entry, idx) => {
      if (idx > 0) {
        const hr = document.createElement('hr');
        hr.style.cssText = 'margin:.75rem 0;border-color:#e5e7eb;';
        container.appendChild(hr);
      }
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-size:.9rem;font-weight:700;color:#1e3a5f;margin-bottom:.3rem;';
      titleEl.textContent = entry.title;
      container.appendChild(titleEl);
      const metaKeys = Object.keys(entry.meta);
      if (metaKeys.length > 0) {
        const metaEl = document.createElement('div');
        metaEl.style.cssText = 'font-size:.75rem;color:#555;margin-bottom:.45rem;display:flex;gap:1.25rem;flex-wrap:wrap;';
        for (const k of metaKeys) {
          const span = document.createElement('span');
          span.innerHTML = `<strong>${escapeHtml(k)}:</strong> ${escapeHtml(entry.meta[k])}`;
          metaEl.appendChild(span);
        }
        container.appendChild(metaEl);
      }
      if (entry.params.length > 0) {
        const table = document.createElement('table');
        table.style.cssText = 'font-size:.75rem;width:100%;border-collapse:collapse;';
        entry.params.forEach((row, i) => {
          const tr = table.insertRow();
          tr.style.background = i % 2 === 0 ? '#f7f8fa' : '#fff';
          const td1 = tr.insertCell();
          td1.style.cssText = 'padding:.18rem .5rem;font-weight:600;color:#444;white-space:nowrap;';
          td1.textContent = row.param;
          const td2 = tr.insertCell();
          td2.style.cssText = 'padding:.18rem .5rem;color:#333;';
          td2.textContent = row.values;
        });
        container.appendChild(table);
      }
    });
  }

  return { init };
})();
