/* Meridian – Constraint Pitch Sensitivity
   Single IIFE exposing global App object.
   Architecture note: loadData() is the only function that needs to change when
   switching from limited_results.json / offset_results.json to ./data/*.json files. */

const App = (() => {

  // ── Constants ────────────────────────────────────────────────────────────

  const MSID_COMMON_NAMES = {
    '2ceahvpt_s': 'HRC-S CEA',
    '2ceahvpt_i': 'HRC-I CEA',
    'pline03t':   'Propulsion Line #3',
    'pline04t':   'Propulsion Line #4',
    '1dpamzt':    'ACIS Electronics (DPA)',
    '1deamzt':    'ACIS Electronics (DEA)',
    'fptemp_11':  'ACIS Focal Plane',
    '4rt700t':    'OBA Forward Bulkhead',
    'aacccdpt':   'Aspect Camera CCD',
    'pftank2t':   'IPS Fuel Tank',
    'pm2thv1t':   'Thruster 1B',
    'pm1thv2t':   'Thruster 2A',
    '1pdeaat':    'ACIS Elec. (PSMC)',
  };

  // Canonical inner→outer order. Only MSIDs in this list are rendered.
  // To add a new model, append its MSID here.
  const PREFERRED_ORDER = [
    '2ceahvpt_s', '2ceahvpt_i', 'pline03t', 'pline04t', '1dpamzt', '1deamzt',
    'fptemp_11', '4rt700t', 'aacccdpt', 'pftank2t', 'pm2thv1t', 'pm1thv2t', '1pdeaat',
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

  // ── Angle helpers ─────────────────────────────────────────────────────────
  // Pitch (degrees) → math angle (radians): 0=right, CCW positive.
  //   pitch 180 → 0°  (horizontal right)
  //   pitch  90 → 90° (straight up)
  //   pitch  45 → 135° (45° above horizontal, upper-left)
  function pitchToAngle(p) { return (180 - p) * Math.PI / 180; }

  // Math angle → D3 arc angle (0 = 12 o'clock, CW positive).
  function mathToD3(a) { return Math.PI / 2 - a; }

  // ── Cache ─────────────────────────────────────────────────────────────────
  const _cache = {};

  // ── Data loading ──────────────────────────────────────────────────────────

  async function fetchNaNSafeJSON(url) {
    const text = await fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
      return r.text();
    });
    return JSON.parse(text.replace(/\bNaN\b/g, 'null'));
  }

  // Pandas orient='columns': { col: { "0": v, "1": v, ... } } → { col: [v, v, ...] }
  function columnsOrientToArrays(raw) {
    const out = {};
    for (const [col, obj] of Object.entries(raw)) {
      if (typeof obj !== 'object' || Array.isArray(obj)) { out[col] = obj; continue; }
      const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
      out[col] = keys.map(k => obj[String(k)]);
    }
    return out;
  }

  // Future: replace this function body to load from ./data/*.json files.
  // The returned shape { lim, off, meta } must stay the same.
  async function loadData() {
    if (_cache.data) return _cache.data;
    const [rawLim, rawOff] = await Promise.all([
      fetchNaNSafeJSON('limited_results.json'),
      fetchNaNSafeJSON('offset_results.json'),
    ]);
    const lim = columnsOrientToArrays(rawLim);
    const off = columnsOrientToArrays(rawOff);
    const meta = {
      date:       rawLim.date       ?? null,
      dwell_type: rawLim.dwell_type ?? null,
      chips:      rawLim.chips      ?? null,
    };
    _cache.data = { lim, off, meta };
    return _cache.data;
  }

  // ── Data processing ───────────────────────────────────────────────────────

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

  function render(container, lim, off, meta) {
    const allMsids = detectMsids(lim);
    const summary  = buildPitchSummary(lim, off, allMsids);
    const msids    = activeMsids(summary);
    const limiting = findLimitingMsids(summary, msids.filter(m => !HRC_MSIDS.has(m)));
    const nBands   = msids.length;

    const pitches   = Array.from(summary.keys()).sort((a, b) => a - b);
    const pitchStep = pitches.length > 1 ? pitches[1] - pitches[0] : 1;
    const halfStep  = pitchStep / 2;

    // ── Layout ──────────────────────────────────────────────────────────────
    const W = container.clientWidth || 900;
    const H = Math.round(W * 0.60);

    // The arc spans:
    //   x: [-outerR·sin(45°), outerR]  → total = outerR·(1 + 1/√2) ≈ 1.707·outerR
    //   y: [-outerR, 0]                → total = outerR
    // (using SVG convention where -y is upward)
    //
    // Layout regions:
    //   left:   labelAreaW  — MSID common-name labels
    //   right:  marginRight — small margin
    //   top:    marginTop   — title
    //   bottom: marginBottom— breathing room below center
    const marginTop    = H * 0.12;
    const marginBottom = H * 0.13;  // extra room for angled labels extending below center
    const labelAreaW   = W * 0.22;
    const marginRight  = W * 0.04;

    const pitchPad = 0.10;   // fraction of outerR reserved outside arc for pitch labels

    const availH = H - marginTop - marginBottom;
    const availW = W - labelAreaW - marginRight;

    const outerR = Math.min(
      availH / (1 + pitchPad),
      availW / (1.707 + pitchPad)
    );
    const pitchLabelRoom = outerR * pitchPad;

    const innerGap   = outerR * 0.25;  // inner bands start 1/4 of the way out, leaving center open
    const bandGap    = Math.max(0.8, outerR * 0.007);
    const bandW      = (outerR - innerGap - bandGap * (nBands - 1)) / nBands;

    const labelFontSize = Math.max(7, Math.min(14, bandW * 0.72));
    const pitchFontSize = Math.max(8, Math.min(14, outerR * 0.062));

    // Center of arc system: leftmost arc point (outerR, pitch=45) aligns with labelAreaW.
    // outerR·cos(135°) = -outerR/√2  →  cx - outerR/√2 = labelAreaW  →  cx = labelAreaW + outerR/√2
    const cx = labelAreaW + outerR / Math.SQRT2;
    const cy = H - marginBottom;   // center sits near SVG bottom edge

    // D3 arc generator. Datum: { iR, oR, pitchLo, pitchHi }
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
      // Anchor at the pitch=45 arc boundary for this band's radial midpoint.
      // rotate(-45) makes the baseline run perpendicular to the 45° boundary edge,
      // with text extending toward the lower-left into the open triangular region.
      const ang45 = pitchToAngle(45);  // 135° = 3π/4
      // Shift anchor inward along the radial direction by a fraction of bandW.
      // At pitch=45 the radial direction points upper-left, so inward = lower on screen,
      // bringing the label visual center into better alignment with the band midpoint.
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
    const titleFontSize    = Math.max(12, pitchFontSize * 1.35);
    const subtitleFontSize = Math.max(9,  pitchFontSize * 0.88);

    svg.append('text')
      .attr('x', W / 2).attr('y', marginTop * 0.42)
      .attr('text-anchor', 'middle')
      .attr('font-size', titleFontSize).attr('font-weight', '600').attr('fill', '#444')
      .text('Constraint Pitch Sensitivity');

    if (meta.date) {
      let sub = meta.date;
      if (meta.chips != null) sub += `  |  chips = ${meta.chips}`;
      svg.append('text')
        .attr('x', W / 2).attr('y', marginTop * 0.72)
        .attr('text-anchor', 'middle')
        .attr('font-size', subtitleFontSize).attr('fill', '#777')
        .text(sub);
    }

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
      wrapper.appendChild(table);

      const thead = table.createTHead();
      const hrow = thead.insertRow();
      const th0 = document.createElement('th');
      th0.textContent = 'Pitch (°)';
      th0.style.whiteSpace = 'nowrap';
      hrow.appendChild(th0);
      for (const msid of msids) {
        const th = document.createElement('th');
        th.textContent = MSID_COMMON_NAMES[msid] || msid;
        th.style.whiteSpace = 'nowrap';
        hrow.appendChild(th);
      }
      const thLimiter = document.createElement('th');
      thLimiter.textContent = 'Limiting Model';
      thLimiter.style.whiteSpace = 'nowrap';
      thLimiter.style.fontStyle = 'italic';
      hrow.appendChild(thLimiter);
      const thMin = document.createElement('th');
      thMin.textContent = 'Composite Minimum';
      thMin.style.whiteSpace = 'nowrap';
      thMin.style.fontStyle = 'italic';
      hrow.appendChild(thMin);

      const tbody = table.createTBody();
      for (const p of pitches) {
        const row = tbody.insertRow();
        const td0 = row.insertCell();
        td0.textContent = p;
        td0.style.fontWeight = '500';
        let rowMin = null;
        let rowMinMsid = null;
        for (const msid of msids) {
          const td = row.insertCell();
          const val = getter(summary.get(p)?.get(msid));
          td.textContent = fmt(val);
          td.style.textAlign = 'right';
          td.style.fontVariantNumeric = 'tabular-nums';
          if (!HRC_MSIDS.has(msid) && val != null && (rowMin === null || val < rowMin)) { rowMin = val; rowMinMsid = msid; }
        }
        const tdLimiter = row.insertCell();
        tdLimiter.textContent = rowMinMsid ? (MSID_COMMON_NAMES[rowMinMsid] || rowMinMsid) : '—';
        tdLimiter.style.fontWeight = '600';
        const tdMin = row.insertCell();
        tdMin.textContent = fmt(rowMin);
        tdMin.style.textAlign = 'right';
        tdMin.style.fontVariantNumeric = 'tabular-nums';
        tdMin.style.fontWeight = '600';
      }

      return card;
    }

    area.appendChild(makeTableCard('Limited Dwell Times (ksec)', e => e?.limMin ?? null));
    area.appendChild(makeTableCard('Offset Dwell Times (ksec)',  e => e?.offMin ?? null));
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

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const { lim, off, meta } = await loadData();
      clearError();
      document.getElementById('loading-state').style.display = 'none';
      const container = document.getElementById('chart-container');
      container.style.display = 'block';
      const { summary, msids, pitches } = render(container, lim, off, meta);
      renderTables(summary, msids, pitches);

      let resizeTimer;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => render(container, lim, off, meta), 150);
      });
    } catch (err) {
      document.getElementById('loading-state').style.display = 'none';
      showError(`Failed to load data: ${err.message}`);
      console.error(err);
    }
  }

  return { init };
})();
