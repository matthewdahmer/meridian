'use strict';

const App = (() => {
  // ── Constants ────────────────────────────────────────────────────────────
  const CXC_EPOCH_MS = Date.UTC(1998, 0, 1);
  const MAX_TS_PTS   = 8000;
  const MAX_SC_PTS   = 6000;

  const _cache = { manifest: null, modelData: {} };

  // ── Display units (from MSID_INFO; values in data files are always °C) ───
  // Limits in the data files are already in the correct display unit.
  // Only observed/predicted/residuals need conversion.
  const MSID_DISPLAY_UNITS = {
    '2ceahvpt': 'C',
    '1dpamzt':  'C',
    '1deamzt':  'C',
    'fptemp':   'C',
    'aacccdpt': 'C',
    '1pdeaat':  'C',
    'pline03t': 'F',
    'pline04t': 'F',
    '4rt700t':  'F',
    'pftank2t': 'F',
    'pm2thv1t': 'F',
    'pm1thv2t': 'F',
    'tpc_fsse': 'F',
    'tpcm_rw5': 'F',
  };

  const fmtUnits = u => (u === 'degF' || u === 'F') ? '°F' : '°C';

  function prepareDisplayData(data) {
    const dispUnit = MSID_DISPLAY_UNITS[data.msid] ?? 'C';
    if (dispUnit === 'C') return data;  // values already in °C, no conversion
    // Convert °C values to °F for display; limits are already in °F
    const toF   = v => v === null ? null : v * 1.8 + 32;
    const errToF = v => v === null ? null : v * 1.8;
    return {
      ...data,
      observed:  data.observed.map(toF),
      predicted: data.predicted.map(toF),
      residuals: data.residuals.map(errToF),
      units: 'degF',
    };
  }

  // ── Time ─────────────────────────────────────────────────────────────────
  const cxcToDate = t => new Date(CXC_EPOCH_MS + t * 1000);

  // ── Sampling ──────────────────────────────────────────────────────────────
  function uniformIdx(len, maxN) {
    if (len <= maxN) return Array.from({ length: len }, (_, i) => i);
    const out = [], step = (len - 1) / (maxN - 1);
    for (let i = 0; i < maxN; i++) out.push(Math.round(i * step));
    return out;
  }
  function pick(arr, idx) { return idx.map(i => arr[i]); }

  // ── Stats helpers ─────────────────────────────────────────────────────────
  function pct(sorted, p) {
    if (!sorted.length) return 0;
    const i = p * (sorted.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  // Jitter band = mean(|diff of consecutive observed values|) / 2.
  // Computed on already-converted display-unit data (°F for °F models, °C otherwise).
  function computeJitterSetup(observed) {
    const diffs = [];
    for (let i = 1; i < observed.length; i++) {
      const prev = observed[i - 1], curr = observed[i];
      if (prev !== null && curr !== null) {
        const d = Math.abs(curr - prev);
        if (d > 0) diffs.push(d);
      }
    }
    const band = diffs.length > 0
      ? diffs.reduce((s, d) => s + d, 0) / diffs.length / 2
      : 0.5;
    return {
      getJitter: () => Math.random() * 2 * band - band,
      binStep: band * 2,
    };
  }

  function computePercentiles(observed, residuals, step) {
    const bins = new Map();
    for (let i = 0; i < observed.length; i++) {
      const o = observed[i], r = residuals[i];
      if (o === null || r === null) continue;
      const key = Math.round(o / step) * step;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(r);
    }
    const out = [];
    for (const [temp, errs] of bins) {
      errs.sort((a, b) => a - b);
      out.push({ temp, halfStep: step / 2, p1: pct(errs, 0.01), p50: pct(errs, 0.50), p99: pct(errs, 0.99) });
    }
    return out.sort((a, b) => a.temp - b.temp);
  }

  // ── Limits ────────────────────────────────────────────────────────────────
  function parseLimits(data) {
    const L = data.all_limits || {};
    return {
      planHigh: L['planning.warning.high'] ?? L['planning.caution.high'] ?? null,
      planLow:  L['planning.warning.low']  ?? L['planning.caution.low']  ?? null,
      cautHigh: L['odb.caution.high'] ?? null,
      cautLow:  L['odb.caution.low']  ?? null,
      warnHigh: L['odb.warning.high'] ?? null,
      warnLow:  L['odb.warning.low']  ?? null,
    };
  }

  function getLimitLines(lims, limitType) {
    const spec = {
      plan:    { color: '#f97316', dash: '8,4', label: 'Plan',    expand: true  },
      caution: { color: '#eab308', dash: '6,3', label: 'Caution', expand: true  },
      warning: { color: '#ef4444', dash: '4,4', label: 'Warning', expand: false },
    };
    const lines = [];
    const add = (val, skey, suffix) => {
      if (val === null) return;
      const s = spec[skey];
      lines.push({ value: val, color: s.color, dash: s.dash, label: s.label + suffix, expand: s.expand });
    };
    if (limitType === 'max') {
      add(lims.planHigh, 'plan',    ' High');
      add(lims.cautHigh, 'caution', ' High');
      add(lims.warnHigh, 'warning', ' High');
    } else {
      add(lims.planLow,  'plan',    ' Low');
      add(lims.cautLow,  'caution', ' Low');
      add(lims.warnLow,  'warning', ' Low');
    }
    return lines;
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadManifest() {
    if (_cache.manifest) return _cache.manifest;
    const r = await fetch('data/manifest.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _cache.manifest = await r.json();
    return _cache.manifest;
  }

  async function loadGzip(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(new Uint8Array(buf)); w.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new TextDecoder().decode(out);
  }

  async function loadModelData(navId) {
    if (_cache.modelData[navId]) return _cache.modelData[navId];
    const text = await loadGzip(`data/${navId}.json.gz`);
    const data = JSON.parse(text);
    _cache.modelData[navId] = data;
    return data;
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────
  let _tip = null;
  function getTip() {
    if (!_tip) {
      _tip = document.createElement('div');
      _tip.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;background:rgba(255,255,255,.96);' +
        'border:1px solid #d1d5db;border-radius:4px;padding:5px 8px;font-size:11px;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.12);display:none;white-space:nowrap;font-family:Arial,sans-serif';
      document.body.appendChild(_tip);
    }
    return _tip;
  }
  function showTip(html, cx, cy) {
    const t = getTip();
    t.innerHTML = html; t.style.display = '';
    const tw = t.offsetWidth, th = t.offsetHeight;
    t.style.left = Math.min(cx + 14, window.innerWidth  - tw - 6) + 'px';
    t.style.top  = Math.max(cy - th - 6, 4) + 'px';
  }
  function hideTip() { getTip().style.display = 'none'; }

  // ── Axis-link pub/sub ─────────────────────────────────────────────────────
  function makeLinks() {
    const ch = {};
    return {
      sub(name, fn) { (ch[name] = ch[name] || []).push(fn); },
      pub(name, val, src) { (ch[name] || []).forEach(fn => { if (fn !== src) fn(val); }); },
    };
  }

  // ── SVG scaffold ──────────────────────────────────────────────────────────
  function initSvg(el, margin) {
    const rect = el.getBoundingClientRect();
    const W = Math.max(rect.width, 60), H = Math.max(rect.height, 40);
    const w = W - margin.left - margin.right;
    const h = H - margin.top  - margin.bottom;

    let svg = d3.select(el).select('svg');
    if (svg.empty()) svg = d3.select(el).append('svg').style('width', '100%').style('height', '100%');
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'none');

    const defs = svg.append('defs');
    const g    = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    return { svg, defs, g, w: Math.max(w, 10), h: Math.max(h, 10) };
  }

  function addGridlines(g, xScale, yScale, w, h) {
    g.append('g').attr('class', 'grid').attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(xScale).tickSize(-h).tickFormat(''))
      .call(gg => { gg.select('.domain').remove(); gg.selectAll('line').attr('stroke', '#e5e7eb'); });
    g.append('g').attr('class', 'grid')
      .call(d3.axisLeft(yScale).tickSize(-w).tickFormat(''))
      .call(gg => { gg.select('.domain').remove(); gg.selectAll('line').attr('stroke', '#e5e7eb'); });
  }

  function addLimitLines(g, limitLines, yScale, w, labelFontSize = 9) {
    limitLines.forEach(ll => {
      const y = yScale(ll.value);
      if (y < -10 || y > yScale.range()[0] + 10) return;
      g.append('line').attr('x1', 0).attr('x2', w)
        .attr('y1', y).attr('y2', y)
        .attr('stroke', ll.color).attr('stroke-width', 1.5)
        .attr('stroke-dasharray', ll.dash).attr('pointer-events', 'none');
      g.append('text').attr('x', w - 3).attr('y', y - 3)
        .attr('text-anchor', 'end').attr('font-size', labelFontSize).attr('fill', ll.color)
        .attr('pointer-events', 'none').text(ll.label);
    });
  }

  function addBrushZoom(g, defs, w, h, onZoom, onReset) {
    const brush = d3.brush().extent([[0, 0], [w, h]])
      .on('end', event => {
        if (!event.selection || !event.sourceEvent) return;
        onZoom(event.selection);
        brushG.call(brush.move, null);
      });
    const brushG = g.append('g').attr('class', 'brush').call(brush);
    brushG.select('.overlay').on('dblclick.reset', onReset);
    return brushG;
  }

  function addHoverLine(g, w, h) {
    return g.append('line')
      .attr('y1', 0).attr('y2', h)
      .attr('stroke', '#6b7280').attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,2').style('display', 'none')
      .attr('pointer-events', 'none');
  }

  function axLabel(g, text, x, y, rotate) {
    const t = g.append('text').attr('x', x).attr('y', y)
      .attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', '#374151').text(text);
    if (rotate) t.attr('transform', `translate(${x},${y})rotate(${rotate})`).attr('x', 0).attr('y', 0);
  }

  // ── Time Series (top-left) ────────────────────────────────────────────────
  function makeTimeSeriesChart(el, data, links, cfg = {}) {
    const margin = { top: 28, right: 30, bottom: 52, left: 85 };
    const lims = parseLimits(data);
    const limitLines = getLimitLines(lims, data.limit_type);

    const n   = data.times.length;
    const idx = uniformIdx(n, MAX_TS_PTS);
    const dates = pick(data.times, idx).map(cxcToDate);
    const obs   = pick(data.observed, idx);
    const pred  = pick(data.predicted, idx);
    const hl    = cfg.hl ? pick(cfg.hl, idx) : null;

    const allVals = [
      ...obs.filter(v => v !== null),
      ...pred.filter(v => v !== null),
      ...limitLines.filter(l => l.expand).map(l => l.value),
    ];
    const pad = v => { const r = (v[1] - v[0]) * 0.04; return [v[0] - r, v[1] + r]; };

    const fullTimeExt = d3.extent(dates);
    const fullTempExt = cfg.tempRange ?? pad([d3.min(allVals), d3.max(allVals)]);

    let timeExt = [...fullTimeExt];
    let tempExt = [...fullTempExt];
    let tsLegCorner = 0;
    let showNormal    = true;
    let showHighlight = true;

    const bisect = d3.bisector(d => d).left;

    function setTimeX(d) { timeExt = d; draw(); }
    function setTempY(d) { tempExt = d; draw(); }
    links.sub('timeX', setTimeX);
    links.sub('tempY', setTempY);

    function draw() {
      const { svg, defs, g, w, h } = initSvg(el, margin);
      const xSc = d3.scaleTime().domain(timeExt).range([0, w]);
      const ySc = d3.scaleLinear().domain(tempExt).range([h, 0]);

      addGridlines(g, xSc, ySc, w, h);
      g.append('g').attr('transform', `translate(0,${h})`)
        .call(d3.axisBottom(xSc).ticks(5))
        .selectAll('text').attr('font-size', 16);
      g.append('g').call(d3.axisLeft(ySc).ticks(6))
        .selectAll('text').attr('font-size', 16);
      axLabel(g, `Temperature (${fmtUnits(data.units)})`, 0, 0, -90);
      g.select('text[transform]').attr('transform', `translate(-68,${h / 2})rotate(-90)`).attr('font-size', 20);

      const clipId = 'ts-c-' + Math.random().toString(36).slice(2);
      defs.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);
      const pg = g.append('g').attr('clip-path', `url(#${clipId})`);

      addLimitLines(pg, limitLines, ySc, w, 14);

      const obsLine = d3.line().defined((_, i) => obs[i] !== null)
        .x((_, i) => xSc(dates[i])).y((_, i) => ySc(obs[i]));
      const predLine = d3.line().defined((_, i) => pred[i] !== null)
        .x((_, i) => xSc(dates[i])).y((_, i) => ySc(pred[i]));

      if (showNormal) {
        pg.append('path').datum(obs).attr('fill', 'none').attr('stroke', '#3b82f6')
          .attr('stroke-width', 1).attr('d', obsLine);
        pg.append('path').datum(pred).attr('fill', 'none').attr('stroke', '#ef4444')
          .attr('stroke-width', 1).attr('d', predLine);
      }

      if (showHighlight && hl) {
        const hlObsPts = [], hlPredPts = [];
        for (let i = 0; i < dates.length; i++) {
          if (hl[i] === 1) {
            if (obs[i]  !== null) hlObsPts.push({ d: dates[i], v: obs[i]  });
            if (pred[i] !== null) hlPredPts.push({ d: dates[i], v: pred[i] });
          }
        }
        pg.selectAll(null).data(hlObsPts).enter().append('circle')
          .attr('cx', p => xSc(p.d)).attr('cy', p => ySc(p.v))
          .attr('r', 3).attr('fill', '#22c55e').attr('pointer-events', 'none');
        pg.selectAll(null).data(hlPredPts).enter().append('circle')
          .attr('cx', p => xSc(p.d)).attr('cy', p => ySc(p.v))
          .attr('r', 3).attr('fill', '#f97316').attr('pointer-events', 'none');
      }

      const hline = addHoverLine(g, w, h);

      const brushG = addBrushZoom(g, defs, w, h,
        ([[x0, y0], [x1, y1]]) => {
          timeExt = [xSc.invert(x0), xSc.invert(x1)];
          tempExt = [ySc.invert(y1), ySc.invert(y0)];
          links.pub('timeX', timeExt, setTimeX);
          links.pub('tempY', tempExt, setTempY);
          draw();
        },
        () => {
          timeExt = [...fullTimeExt]; tempExt = [...fullTempExt];
          links.pub('timeX', timeExt, setTimeX); links.pub('tempY', tempExt, setTempY);
          draw();
        }
      );

      brushG.select('.overlay')
        .on('mousemove.hover', function (event) {
          const [mx] = d3.pointer(event, this);
          const i = Math.max(0, Math.min(bisect(dates, xSc.invert(mx)), dates.length - 1));
          hline.style('display', '').attr('x1', mx).attr('x2', mx);
          const o = obs[i], p = pred[i];
          const ds = dates[i].toISOString().replace('T', ' ').slice(0, 16);
          showTip(
            `<b>${ds}</b><br>` +
            `<span style="color:#3b82f6">Telem</span>: ${o !== null ? o.toFixed(3) : '—'} ${fmtUnits(data.units)}<br>` +
            `<span style="color:#ef4444">Model</span>: ${p !== null ? p.toFixed(3) : '—'} ${fmtUnits(data.units)}`,
            event.clientX, event.clientY
          );
        })
        .on('mouseleave.hover', () => { hline.style('display', 'none'); hideTip(); });

      // Legend — rendered after brush so it sits above the overlay and receives clicks
      const legRowH = 20, legLineW = 28, legBgW = legLineW + 52;
      const legCorners = [
        { x: w - 12, y: h - legRowH * 2 - 12, align: 'right' },
        { x: 12,     y: h - legRowH * 2 - 12, align: 'left'  },
        { x: 12,     y: 16,                   align: 'left'  },
        { x: w - 12, y: 16,                   align: 'right' },
      ];
      const { x: legX, y: legYc, align: legAlign } = legCorners[tsLegCorner];
      const leg = g.append('g').attr('transform', `translate(${legX},${legYc})`);
      leg.append('rect')
        .attr('x', legAlign === 'right' ? -legBgW : 0)
        .attr('y', -4).attr('width', legBgW).attr('height', legRowH * 2 + 4)
        .attr('fill', 'rgba(255,255,255,0.82)').attr('rx', 3);
      [['#3b82f6', 'Telem'], ['#ef4444', 'Model']].forEach(([c, lbl], i) => {
        const lg = leg.append('g').attr('transform', `translate(0,${i * legRowH})`);
        if (legAlign === 'right') {
          lg.append('line').attr('x1', -legLineW).attr('x2', -6).attr('stroke', c).attr('stroke-width', 2);
          lg.append('text').attr('x', -legLineW - 4).attr('text-anchor', 'end').attr('font-size', 16)
            .attr('fill', '#374151').attr('dominant-baseline', 'middle').text(lbl);
        } else {
          lg.append('line').attr('x1', 6).attr('x2', legLineW + 6).attr('stroke', c).attr('stroke-width', 2);
          lg.append('text').attr('x', legLineW + 10).attr('text-anchor', 'start').attr('font-size', 16)
            .attr('fill', '#374151').attr('dominant-baseline', 'middle').text(lbl);
        }
      });
      leg.style('cursor', 'pointer').on('click', event => {
        event.stopPropagation();
        tsLegCorner = (tsLegCorner + 1) % 4;
        draw();
      });
    }

    return {
      draw,
      setShowNormal(v)    { showNormal    = v; draw(); },
      setShowHighlight(v) { showHighlight = v; draw(); },
    };
  }

  // ── Scatter (top-right) ───────────────────────────────────────────────────
  function makeScatterChart(el, data, links, cfg = {}) {
    const margin = { top: 36, right: 30, bottom: 52, left: 85 };
    const lims = parseLimits(data);
    const limitLines = getLimitLines(lims, data.limit_type);

    const n   = data.times.length;
    const idx = uniformIdx(n, MAX_SC_PTS);
    const obs = pick(data.observed, idx);
    const res = pick(data.residuals, idx);
    const ts  = pick(data.times, idx);
    const hl  = cfg.hl ? pick(cfg.hl, idx) : null;

    const tMin = data.times[0], tRange = data.times[n - 1] - tMin;
    const tNorm = ts.map(t => tRange > 0 ? (t - tMin) / tRange : 0);
    const colorSc = d3.scaleSequential(t => d3.interpolateRdYlBu(1 - t)).domain([0, 1]);

    const validRes = data.residuals.filter(v => v !== null);
    const validObs = data.observed.filter(v => v !== null);
    const pad = v => { const r = (v[1] - v[0]) * 0.04; return [v[0] - r, v[1] + r]; };

    const fullErrorExt = cfg.errorRange ?? pad([d3.min(validRes), d3.max(validRes)]);
    const fullTempExt  = cfg.tempRange  ?? pad([
      d3.min([...validObs, ...limitLines.filter(l => l.expand).map(l => l.value)]),
      d3.max([...validObs, ...limitLines.filter(l => l.expand).map(l => l.value)]),
    ]);

    const { binStep: autoStep } = computeJitterSetup(data.observed);
    const pctStep    = cfg.scatterBinSize ?? autoStep;
    const jitterBand = cfg.jitterBinSize  ?? (autoStep / 2);
    const getJitter  = () => Math.random() * 2 * jitterBand - jitterBand;
    const pctData = computePercentiles(data.observed, data.residuals, pctStep);
    const jitterVals = obs.map(() => getJitter());

    let errorExt      = [...fullErrorExt];
    let tempExt       = [...fullTempExt];
    let jitter        = true;
    let showNormal    = true;
    let showHighlight = true;

    function setTempY(d) { tempExt = d; draw(); }
    function setErrorX(d) { errorExt = d; draw(); }
    links.sub('tempY', setTempY);
    links.sub('errorX', setErrorX);

    function draw() {
      const { svg, defs, g, w, h } = initSvg(el, margin);
      const xSc = d3.scaleLinear().domain(errorExt).range([0, w]);
      const ySc = d3.scaleLinear().domain(tempExt).range([h, 0]);

      addGridlines(g, xSc, ySc, w, h);
      g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(xSc).ticks(5))
        .selectAll('text').attr('font-size', 16);
      g.append('g').call(d3.axisLeft(ySc).ticks(6))
        .selectAll('text').attr('font-size', 16);

      g.append('text').attr('x', w / 2).attr('y', h + 44).attr('text-anchor', 'middle')
        .attr('font-size', 20).attr('fill', '#374151').text(`Error (${fmtUnits(data.units)})`);
      g.append('text').attr('transform', `translate(-68,${h / 2})rotate(-90)`)
        .attr('text-anchor', 'middle').attr('font-size', 20).attr('fill', '#374151')
        .text(`Temperature (${fmtUnits(data.units)})`);

      // Good/Bad labels above the data area — placed in SVG coordinates so they
      // sit in the top margin and never overlap limit lines inside the plot.
      const lblY = margin.top - 8;
      if (data.limit_type === 'max') {
        svg.append('text').attr('x', margin.left + 4).attr('y', lblY)
          .attr('font-size', 16).attr('font-weight', 600).attr('fill', '#16a34a').text('Good');
        svg.append('text').attr('x', margin.left + w - 4).attr('y', lblY)
          .attr('text-anchor', 'end').attr('font-size', 16).attr('font-weight', 600).attr('fill', '#dc2626').text('Bad');
      } else {
        svg.append('text').attr('x', margin.left + 4).attr('y', lblY)
          .attr('font-size', 16).attr('font-weight', 600).attr('fill', '#dc2626').text('Bad');
        svg.append('text').attr('x', margin.left + w - 4).attr('y', lblY)
          .attr('text-anchor', 'end').attr('font-size', 16).attr('font-weight', 600).attr('fill', '#16a34a').text('Good');
      }

      const clipId = 'sc-c-' + Math.random().toString(36).slice(2);
      defs.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);
      const pg = g.append('g').attr('clip-path', `url(#${clipId})`);

      addLimitLines(pg, limitLines, ySc, w, 14);

      // Zero error reference line
      pg.append('line').attr('x1', xSc(0)).attr('x2', xSc(0))
        .attr('y1', 0).attr('y2', h).attr('stroke', '#9ca3af')
        .attr('stroke-width', 1).attr('stroke-dasharray', '4,2').attr('pointer-events', 'none');

      // Scatter dots
      const pts = obs.map((o, i) => ({ o, r: res[i], tn: tNorm[i], ji: jitterVals[i], hlOn: hl ? hl[i] === 1 : false }))
                     .filter(d => d.o !== null && d.r !== null);
      if (showNormal) {
        pg.selectAll(null).data(pts).enter().append('circle')
          .attr('cx', d => xSc(d.r))
          .attr('cy', d => ySc(d.o + (jitter ? d.ji : 0)))
          .attr('r', 2).attr('fill', d => colorSc(d.tn)).attr('opacity', 0.55)
          .attr('pointer-events', 'none');

        // Percentile step lines
        const pStyles = [
          { key: 'p1',  stroke: '#6b7280', width: 1,   dash: '3,3' },
          { key: 'p50', stroke: '#111827', width: 1.5, dash: ''    },
          { key: 'p99', stroke: '#6b7280', width: 1,   dash: '3,3' },
        ];
        const inView = pctData.filter(d => d.temp >= tempExt[0] && d.temp <= tempExt[1]);
        pStyles.forEach(ps => {
          const lineGen = d3.line().x(d => xSc(d[ps.key])).y(d => ySc(d.temp))
            .curve(d3.curveStepBefore).defined(d => d[ps.key] !== undefined);
          pg.append('path').datum(inView).attr('fill', 'none')
            .attr('stroke', ps.stroke).attr('stroke-width', ps.width)
            .attr('stroke-dasharray', ps.dash).attr('pointer-events', 'none')
            .attr('d', lineGen);
        });
      }

      if (showHighlight && hl) {
        pg.selectAll(null).data(pts.filter(d => d.hlOn)).enter().append('circle')
          .attr('cx', d => xSc(d.r))
          .attr('cy', d => ySc(d.o + (jitter ? d.ji : 0)))
          .attr('r', 3).attr('fill', '#22c55e').attr('opacity', 0.85)
          .attr('pointer-events', 'none');
      }

      const hline = addHoverLine(g, w, h);

      const brushG = addBrushZoom(g, defs, w, h,
        ([[x0, y0], [x1, y1]]) => {
          errorExt = [xSc.invert(x0), xSc.invert(x1)];
          tempExt  = [ySc.invert(y1), ySc.invert(y0)];
          links.pub('errorX', errorExt, setErrorX);
          links.pub('tempY',  tempExt,  setTempY);
          draw();
        },
        () => {
          errorExt = [...fullErrorExt]; tempExt = [...fullTempExt];
          links.pub('errorX', errorExt, setErrorX); links.pub('tempY', tempExt, setTempY);
          draw();
        }
      );

      brushG.select('.overlay')
        .on('mousemove.hover', function (event) {
          const [mx, my] = d3.pointer(event, this);
          hline.style('display', '').attr('x1', mx).attr('x2', mx);
          showTip(
            `Error: ${xSc.invert(mx).toFixed(3)} ${fmtUnits(data.units)}<br>` +
            `Temp: ${ySc.invert(my).toFixed(3)} ${fmtUnits(data.units)}`,
            event.clientX, event.clientY
          );
        })
        .on('mouseleave.hover', () => { hline.style('display', 'none'); hideTip(); });
    }

    return {
      draw,
      setJitter(v)        { jitter        = v; draw(); },
      setShowNormal(v)    { showNormal    = v; draw(); },
      setShowHighlight(v) { showHighlight = v; draw(); },
    };
  }

  // ── Error vs Time (bottom-left) ───────────────────────────────────────────
  function makeErrorTimeChart(el, data, links, cfg = {}) {
    const margin = { top: 24, right: 30, bottom: 52, left: 80 };

    const n   = data.times.length;
    const idx = uniformIdx(n, MAX_TS_PTS);
    const dates = pick(data.times, idx).map(cxcToDate);
    const res   = pick(data.residuals, idx);
    const hl    = cfg.hl ? pick(cfg.hl, idx) : null;

    const fullTimeExt = d3.extent(dates);
    const validRes = res.filter(v => v !== null);
    const pad = v => { const r = (v[1] - v[0]) * 0.06 + 0.01; return [v[0] - r, v[1] + r]; };
    const fullErrExt = cfg.errorRange ?? pad([d3.min(validRes), d3.max(validRes)]);

    let timeExt       = [...fullTimeExt];
    let errExt        = [...fullErrExt];
    let showNormal    = true;
    let showHighlight = true;
    const bisect = d3.bisector(d => d).left;

    function setTimeX(d) { timeExt = d; draw(); }
    links.sub('timeX', setTimeX);

    function draw() {
      const { svg, defs, g, w, h } = initSvg(el, margin);
      const xSc = d3.scaleTime().domain(timeExt).range([0, w]);
      const ySc = d3.scaleLinear().domain(errExt).range([h, 0]);

      addGridlines(g, xSc, ySc, w, h);
      g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(xSc).ticks(5))
        .selectAll('text').attr('font-size', 16);
      g.append('g').call(d3.axisLeft(ySc).ticks(4))
        .selectAll('text').attr('font-size', 16);
      g.append('text').attr('transform', `translate(-62,${h / 2})rotate(-90)`)
        .attr('text-anchor', 'middle').attr('font-size', 20).attr('fill', '#374151')
        .text(`Error (${fmtUnits(data.units)})`);

      const clipId = 'et-c-' + Math.random().toString(36).slice(2);
      defs.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);
      const pg = g.append('g').attr('clip-path', `url(#${clipId})`);

      pg.append('line').attr('x1', 0).attr('x2', w)
        .attr('y1', ySc(0)).attr('y2', ySc(0)).attr('stroke', '#9ca3af')
        .attr('stroke-width', 1).attr('stroke-dasharray', '4,2').attr('pointer-events', 'none');

      const errLine = d3.line().defined((_, i) => res[i] !== null)
        .x((_, i) => xSc(dates[i])).y((_, i) => ySc(res[i]));
      if (showNormal) {
        pg.append('path').datum(res).attr('fill', 'none').attr('stroke', '#3b82f6')
          .attr('stroke-width', 1).attr('d', errLine);
      }

      if (showHighlight && hl) {
        const hlPts = [];
        for (let i = 0; i < dates.length; i++) {
          if (hl[i] === 1 && res[i] !== null) hlPts.push({ d: dates[i], v: res[i] });
        }
        pg.selectAll(null).data(hlPts).enter().append('circle')
          .attr('cx', p => xSc(p.d)).attr('cy', p => ySc(p.v))
          .attr('r', 3).attr('fill', '#22c55e').attr('pointer-events', 'none');
      }

      const hline = addHoverLine(g, w, h);

      const brushG = addBrushZoom(g, defs, w, h,
        ([[x0, y0], [x1, y1]]) => {
          timeExt = [xSc.invert(x0), xSc.invert(x1)];
          errExt  = [ySc.invert(y1), ySc.invert(y0)];  // y inverted: pixel top = data max
          links.pub('timeX', timeExt, setTimeX);
          draw();
        },
        () => {
          timeExt = [...fullTimeExt];
          errExt  = [...fullErrExt];
          links.pub('timeX', timeExt, setTimeX);
          draw();
        }
      );

      brushG.select('.overlay')
        .on('mousemove.hover', function (event) {
          const [mx] = d3.pointer(event, this);
          const i = Math.max(0, Math.min(bisect(dates, xSc.invert(mx)), dates.length - 1));
          hline.style('display', '').attr('x1', mx).attr('x2', mx);
          const r = res[i], ds = dates[i].toISOString().replace('T', ' ').slice(0, 16);
          showTip(
            `<b>${ds}</b><br>Error: ${r !== null ? r.toFixed(3) : '—'} ${fmtUnits(data.units)}`,
            event.clientX, event.clientY
          );
        })
        .on('mouseleave.hover', () => { hline.style('display', 'none'); hideTip(); });
    }

    return {
      draw,
      setShowNormal(v)    { showNormal    = v; draw(); },
      setShowHighlight(v) { showHighlight = v; draw(); },
    };
  }

  // ── Histogram (bottom-right) ──────────────────────────────────────────────
  function makeHistogramChart(el, data, links, cfg = {}) {
    const margin = { top: 24, right: 30, bottom: 52, left: 85 };

    const validRes = data.residuals.filter(v => v !== null);
    const pad = v => { const r = (v[1] - v[0]) * 0.04; return [v[0] - r, v[1] + r]; };
    const fullErrorExt = cfg.errorRange ?? pad([d3.min(validRes), d3.max(validRes)]);
    const autoNBins = Math.max(10, Math.min(80, Math.ceil(Math.log2(validRes.length)) + 1));
    // Pre-compute fixed thresholds when histBinSize is overridden so they don't change on zoom.
    const histThresholdsOverride = cfg.histBinSize != null
      ? d3.range(fullErrorExt[0], fullErrorExt[1] + cfg.histBinSize, cfg.histBinSize)
      : null;

    let errorExt = [...fullErrorExt];

    function setErrorX(d) { errorExt = d; draw(); }
    links.sub('errorX', setErrorX);

    function draw() {
      const { svg, defs, g, w, h } = initSvg(el, margin);
      const xSc = d3.scaleLinear().domain(errorExt).range([0, w]);

      const thresholds = histThresholdsOverride ?? xSc.ticks(autoNBins);
      const binGen = d3.bin().domain(errorExt).thresholds(thresholds);
      const bins = binGen(validRes);
      const binWidth = bins.length > 1 ? bins[0].x1 - bins[0].x0 : errorExt[1] - errorExt[0];

      const ySc = d3.scaleLinear().domain([0, d3.max(bins, d => d.length) * 1.08 || 1]).range([h, 0]);

      addGridlines(g, xSc, ySc, w, h);
      g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(xSc).ticks(5))
        .selectAll('text').attr('font-size', 16);
      g.append('g').call(d3.axisLeft(ySc).ticks(4))
        .selectAll('text').attr('font-size', 16);
      g.append('text').attr('x', w / 2).attr('y', h + 44).attr('text-anchor', 'middle')
        .attr('font-size', 20).attr('fill', '#374151').text(`Error (${fmtUnits(data.units)})`);

      // Bin size annotation
      g.append('text').attr('x', w - 3).attr('y', 18).attr('text-anchor', 'end')
        .attr('font-size', 16).attr('fill', '#6b7280').text(`bin = ${binWidth.toFixed(3)}`);

      const clipId = 'hist-c-' + Math.random().toString(36).slice(2);
      defs.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);
      const pg = g.append('g').attr('clip-path', `url(#${clipId})`);

      pg.selectAll('rect').data(bins).enter().append('rect')
        .attr('x', d => xSc(d.x0) + 0.5)
        .attr('y', d => ySc(d.length))
        .attr('width', d => Math.max(0, xSc(d.x1) - xSc(d.x0) - 1))
        .attr('height', d => h - ySc(d.length))
        .attr('fill', '#3b82f6').attr('opacity', 0.75).attr('pointer-events', 'none');

      const hline = addHoverLine(g, w, h);

      // Precompute cumulative counts per bin for percentile tooltip
      let cum = 0;
      const binCum = bins.map(b => { cum += b.length; return cum; });
      const total  = validRes.length;

      const brushG = addBrushZoom(g, defs, w, h,
        ([[x0], [x1]]) => {
          errorExt = [xSc.invert(x0), xSc.invert(x1)];
          links.pub('errorX', errorExt, setErrorX);
          draw();
        },
        () => {
          errorExt = [...fullErrorExt];
          links.pub('errorX', errorExt, setErrorX);
          draw();
        }
      );

      brushG.select('.overlay')
        .on('mousemove.hover', function (event) {
          const [mx] = d3.pointer(event, this);
          const errVal = xSc.invert(mx);
          hline.style('display', '').attr('x1', mx).attr('x2', mx);
          const bi = bins.findIndex(b => errVal >= b.x0 && errVal < b.x1);
          if (bi >= 0) {
            const b = bins[bi];
            const pctile = (binCum[bi] / total * 100).toFixed(1);
            showTip(
              `[${b.x0.toFixed(3)}, ${b.x1.toFixed(3)}] ${fmtUnits(data.units)}<br>` +
              `Count: ${b.length}<br>Cumulative: ${pctile}%`,
              event.clientX, event.clientY
            );
          } else {
            hideTip();
          }
        })
        .on('mouseleave.hover', () => { hline.style('display', 'none'); hideTip(); });
    }

    return { draw };
  }

  // ── Pitch-bin error chart (single panel) ─────────────────────────────────
  function makePitchBinChart(el, opts, links) {
    const { segments, pitchLo, pitchHi, fullErrExt, colorSc, showXAxis, margin, units,
            fullTimeExt: _fullTimeExt, timeCap: _timeCap } = opts;
    const timeCap     = _timeCap     ?? 80000;
    const fullTimeExt = _fullTimeExt ?? [0, timeCap];
    let timeExt = [...fullTimeExt];
    let errExt  = [...fullErrExt];   // per-plot Y domain, independently zoomable

    function setTimeX(d) { timeExt = d; draw(); }
    links.sub('pitchTimeX', setTimeX);

    function draw() {
      const { svg, defs, g, w, h } = initSvg(el, margin);
      const xSc = d3.scaleLinear().domain(timeExt).range([0, w]);
      const ySc = d3.scaleLinear().domain(errExt).range([h, 0]);

      // Subtle gridlines
      g.append('g').attr('transform', `translate(0,${h})`)
        .call(d3.axisBottom(xSc).ticks(6).tickSize(-h).tickFormat(''))
        .call(gg => { gg.select('.domain').remove(); gg.selectAll('line').attr('stroke', '#f3f4f6'); });
      g.append('g')
        .call(d3.axisLeft(ySc).ticks(3).tickSize(-w).tickFormat(''))
        .call(gg => { gg.select('.domain').remove(); gg.selectAll('line').attr('stroke', '#f3f4f6'); });

      // Y axis
      g.append('g').call(d3.axisLeft(ySc).ticks(3).tickSize(3))
        .call(ag => ag.selectAll('text').attr('font-size', 14));

      // X axis — only on last subplot
      if (showXAxis) {
        g.append('g').attr('transform', `translate(0,${h})`)
          .call(d3.axisBottom(xSc).ticks(6).tickFormat(d => `${d / 1000}k`).tickSize(3))
          .call(ag => ag.selectAll('text').attr('font-size', 16));
        g.append('text')
          .attr('x', w / 2).attr('y', h + 44)
          .attr('text-anchor', 'middle').attr('font-size', 18).attr('fill', '#374151')
          .text('Dwell Duration [sec]');
      }

      // Pitch label — horizontal, right-aligned inside left margin
      g.append('text')
        .attr('x', -48).attr('y', h / 2)
        .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
        .attr('font-size', 15).attr('fill', '#374151')
        .text(`${pitchLo}°–${pitchHi}°`);

      // Clip path
      const clipId = 'pbc-' + Math.random().toString(36).slice(2);
      defs.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);
      const pg = g.append('g').attr('clip-path', `url(#${clipId})`);

      // Zero-error reference line
      if (errExt[0] < 0 && errExt[1] > 0) {
        pg.append('line').attr('x1', 0).attr('x2', w)
          .attr('y1', ySc(0)).attr('y2', ySc(0))
          .attr('stroke', '#d1d5db').attr('stroke-width', 1).attr('pointer-events', 'none');
      }

      // Segment lines
      segments.forEach(seg => {
        const times  = seg.times  || seg.dwell_times || seg.t   || [];
        const errors = seg.errors || seg.errs        || seg.err || [];
        if (!times.length || !errors.length) return;
        const col = colorSc(typeof seg.segment_norm === 'number' ? seg.segment_norm : 0.5);
        const pts = times.map((t, i) => ({ t, e: errors[i] }))
          .filter(d => d.t >= 0 && d.t <= timeCap && d.e !== null && isFinite(d.e));
        if (pts.length < 2) return;
        pg.append('path').datum(pts)
          .attr('fill', 'none').attr('stroke', col)
          .attr('stroke-width', 1.2).attr('opacity', 0.8).attr('pointer-events', 'none')
          .attr('d', d3.line().x(d => xSc(d.t)).y(d => ySc(d.e)));
      });

      const hline = addHoverLine(g, w, h);

      const brushG = addBrushZoom(g, defs, w, h,
        ([[x0, y0], [x1, y1]]) => {
          timeExt = [Math.max(0, xSc.invert(x0)), Math.min(timeCap, xSc.invert(x1))];
          errExt  = [ySc.invert(y1), ySc.invert(y0)];   // Y inverted: pixel top = data max
          links.pub('pitchTimeX', timeExt, setTimeX);
          draw();
        },
        () => {
          timeExt = [...fullTimeExt];
          errExt  = [...fullErrExt];
          links.pub('pitchTimeX', timeExt, setTimeX);
          draw();
        }
      );

      brushG.select('.overlay')
        .on('mousemove.hover', function (event) {
          const [mx] = d3.pointer(event, this);
          const tVal = xSc.invert(mx);
          hline.style('display', '').attr('x1', mx).attr('x2', mx);

          let bestDist = Infinity, bestE = null, bestDate = null, bestCol = '#374151';
          segments.forEach(seg => {
            const times  = seg.times  || seg.dwell_times || seg.t   || [];
            const errors = seg.errors || seg.errs        || seg.err || [];
            for (let i = 0; i < times.length; i++) {
              if (errors[i] === null || !isFinite(errors[i]) || times[i] > timeCap) continue;
              const dist = Math.abs(times[i] - tVal);
              if (dist < bestDist) {
                bestDist = dist; bestE = errors[i];
                bestDate = seg.date || seg.t_start || seg.datestr || null;
                bestCol  = colorSc(seg.segment_norm ?? 0.5);
              }
            }
          });

          let html = `<span style="font-size:20px;color:#6b7280">${pitchLo}°–${pitchHi}°</span>`;
          if (bestE !== null) {
            html += `<br><span style="color:${bestCol}">●</span> Error: ${bestE.toFixed(3)} ${fmtUnits(units)}`;
          }
          if (bestDate) html += `<br>Date: ${bestDate}`;
          showTip(html, event.clientX, event.clientY);
        })
        .on('mouseleave.hover', () => { hline.style('display', 'none'); hideTip(); });
    }

    return { draw };
  }

  // ── Pitch-bin colorbar (horizontal, at bottom) ───────────────────────────
  function renderPitchColorbar(container, colorSc, tempRange, units, margin) {
    const BAR_H = 14;
    const mt = 24, mb = 32;
    const svgH = mt + BAR_H + mb;

    function draw() {
      const W = Math.round(container.getBoundingClientRect().width);
      if (W <= 0) return;
      const barL = margin.left;
      const barR = margin.right;
      const barW = Math.max(W - barL - barR, 20);

      d3.select(container).selectAll('svg').remove();
      const svg = d3.select(container).append('svg')
        .attr('width', W).attr('height', svgH).style('display', 'block');

      const defs = svg.append('defs');
      const gid  = 'pcb-h-' + Math.random().toString(36).slice(2);
      const grad = defs.append('linearGradient').attr('id', gid)
        .attr('x1', 0).attr('x2', 1).attr('y1', 0).attr('y2', 0);
      for (let i = 0; i <= 20; i++) {
        grad.append('stop').attr('offset', `${i * 5}%`).attr('stop-color', colorSc(i / 20));
      }

      const g = svg.append('g').attr('transform', `translate(${barL},${mt})`);
      g.append('rect').attr('width', barW).attr('height', BAR_H)
        .attr('fill', `url(#${gid})`).attr('stroke', '#d1d5db').attr('stroke-width', 0.5);

      const domain = tempRange ? tempRange : [0, 1];
      const xSc = d3.scaleLinear().domain([domain[0], domain[1]]).range([0, barW]);
      g.append('g').attr('transform', `translate(0,${BAR_H})`)
        .call(d3.axisBottom(xSc).ticks(6).tickSize(3))
        .call(ag => { ag.select('.domain').remove(); ag.selectAll('text').attr('font-size', 16); });

      const unitChar = (units === 'degF' || units === 'F') ? 'F' : 'C';
      svg.append('text')
        .attr('x', barL + barW / 2).attr('y', 16)
        .attr('text-anchor', 'middle').attr('font-size', 16).attr('fill', '#374151')
        .text(`Dwell Start Temperature (°${unitChar})`);
    }

    return { draw };
  }

  // ── Pitch-error card (exported) ───────────────────────────────────────────
  function renderPitchErrorCard(container, rawData) {
    const cfg      = window.ModelDashConfig?.models?.[rawData.msid]?.pitchErrorCard ?? {};
    const dispUnit = MSID_DISPLAY_UNITS[rawData.msid] ?? 'C';
    const isF    = dispUnit === 'F';
    const errToF = v => (v === null || !isFinite(v)) ? v : v * 1.8;
    const units  = isF ? 'degF' : 'degC';

    // All segment data lives under pitch_analysis
    const pa = rawData.pitch_analysis;
    if (!pa) return { destroy: () => {} };

    const plist      = pa.plist;
    const rawErrSegs = pa.err_segments;  // {"N": [[seg], …]} each seg = [[rel_sec, error], …]
    const normSegs   = pa.segment_norm;  // {"N": [norm0, norm1, …]}
    const metaSegs   = pa.metadata;      // {"N": [{tstart, tstop, pitch, …}, …]}

    if (!plist || plist.length < 2 || !rawErrSegs) {
      return { destroy: () => {} };
    }

    const nBins = plist.length - 1;

    // Normalise dicts keyed by string bin index into plain arrays
    const toArr = (obj, n) => Array.isArray(obj)
      ? obj
      : Array.from({ length: n }, (_, i) => obj?.[i] ?? obj?.[String(i)] ?? []);

    const errSegsByBin  = toArr(rawErrSegs, nBins);
    const normSegsByBin = normSegs  ? toArr(normSegs,  nBins) : null;
    const metaSegsByBin = metaSegs  ? toArr(metaSegs,  nBins) : null;

    // Each seg is [[rel_sec, error], …] — unpack into {times, errors, segment_norm, date}
    const bins = [];
    for (let bi = 0; bi < nBins; bi++) {
      const binErr  = errSegsByBin[bi]    || [];
      const binNorm = normSegsByBin?.[bi] || [];
      const binMeta = metaSegsByBin?.[bi] || [];
      bins.push(binErr.map((seg, si) => {
        const tstart = binMeta[si]?.tstart ?? null;
        return {
          times:        seg.map(d => d[0]),
          errors:       isF ? seg.map(d => errToF(d[1])) : seg.map(d => d[1]),
          segment_norm: typeof binNorm[si] === 'number' ? binNorm[si] : 0.5,
          date:         tstart ? cxcToDate(tstart).toISOString().slice(0, 10) : null,
        };
      }));
    }

    // Global error extent across all bins
    let errMin = Infinity, errMax = -Infinity;
    bins.forEach(binSegs => binSegs.forEach(seg =>
      (seg.errors || []).forEach(e => {
        if (e !== null && isFinite(e)) { errMin = Math.min(errMin, e); errMax = Math.max(errMax, e); }
      })
    ));
    if (!isFinite(errMin)) { errMin = -0.5; errMax = 0.5; }
    const pad = Math.max((errMax - errMin) * 0.08, 0.02);
    const fullErrExt  = cfg.errorRange ? [...cfg.errorRange] : [errMin - pad, errMax + pad];
    const pitchTimeCap    = cfg.timeRange ? cfg.timeRange[1] : 80000;
    const pitchTimeExt    = cfg.timeRange ? [...cfg.timeRange] : [0, pitchTimeCap];

    // telem_bounds is a [min, max] array of dwell start temperatures in °C
    const tb = pa.telem_bounds;
    let tempRange = null;
    if (Array.isArray(tb) && tb.length >= 2 && typeof tb[0] === 'number') {
      tempRange = isF ? [tb[0] * 1.8 + 32, tb[1] * 1.8 + 32] : [tb[0], tb[1]];
    }

    // Per-bin telem statistics from pitch_bin_statistics
    const pbs  = pa.pitch_bin_statistics ?? {};
    const absV = v => (v == null || !isFinite(v)) ? null : isF ? v * 1.8 + 32 : v;
    const relV = v => (v == null || !isFinite(v)) ? null : isF ? v * 1.8 : v;
    const fmtV = v => v == null ? '—'
      : Math.abs(v) >= 100 ? v.toFixed(1)
      : Math.abs(v) >= 10  ? v.toFixed(2)
      : v.toFixed(3);

    function buildStatTable(el, bi, ruleBottom = 0) {
      const t = pbs[String(bi)]?.error;
      if (!t) return;

      // Three column-groups matching the user spec
      const groups = [
        [
          ['Mean',    fmtV(relV(t.mean))],
          ['Std',     fmtV(relV(t.std))],
          ['RMS',     fmtV(relV(t.rms))],
          ['Max Abs', fmtV(relV(t.max_abs))],
        ],
        [
          ['5%',  fmtV(relV(t.p05))],
          ['50%', fmtV(relV(t.p50))],
          ['95%', fmtV(relV(t.p95))],
        ],
        [
          ['Mean',       fmtV(relV(t.segment_mean_mean))],
          ['Mean Std',   fmtV(relV(t.segment_mean_std))],
          ['Drift Mean', fmtV(relV(t.segment_drift_mean))],
          ['Drift Std',  fmtV(relV(t.segment_drift_std))],
        ],
      ];

      const outer = document.createElement('div');
      const pb = ruleBottom + 9;
      outer.style.cssText = `display:flex;height:100%;align-items:flex-end;gap:28px;padding:0 14px ${pb}px 8px;`;

      groups.forEach(rows => {
        const col = document.createElement('div');
        col.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;';
        rows.forEach(([label, value]) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;' +
            'padding-right:6px;line-height:1.05;';
          const lbl = document.createElement('span');
          lbl.style.cssText = 'font-size:.63rem;color:#9ca3af;white-space:nowrap;';
          lbl.textContent = label;
          const val = document.createElement('span');
          val.style.cssText = 'font-size:.63rem;font-family:monospace;color:#374151;white-space:nowrap;';
          val.textContent = value;
          row.append(lbl, val);
          col.appendChild(row);
        });
        outer.appendChild(col);
      });

      el.appendChild(outer);
    }

    // Build card
    const card = document.createElement('div');
    card.className = 'card mb-3';
    const hdr = document.createElement('div');
    hdr.className = 'card-header py-2';
    hdr.innerHTML = '<span class="small fw-semibold text-muted">Error Segments by Pitch Bin</span>';
    const body = document.createElement('div');
    body.className = 'card-body p-2';
    card.append(hdr, body);
    container.appendChild(card);

    // Layout constants
    const SUB_H      = 65;
    const GAP        = 4;
    const LAST_EXTRA = 52;
    const MARGIN     = { top: 3, right: 6, left: 150 };

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;';
    body.appendChild(wrap);

    const pitchLinks = makeLinks();
    const colorSc    = d3.scaleSequential(d3.interpolateViridis).domain([0, 1]);
    const subCharts  = [];

    bins.forEach((binSegs, bi) => {
      const isLast = bi === nBins - 1;
      const botM   = isLast ? LAST_EXTRA : 4;
      const divH   = SUB_H + (isLast ? LAST_EXTRA : 0);
      const margin = { ...MARGIN, bottom: botM };

      // Each bin is a full-width row: [plot 66.67%] [stats table flex:1]
      const ruleBottom = isLast ? LAST_EXTRA - GAP : 0;
      const rowEl = document.createElement('div');
      rowEl.style.cssText = `position:relative;display:flex;height:${divH}px;flex-shrink:0;` +
        (bi > 0 ? `margin-top:${GAP}px;` : '');
      wrap.appendChild(rowEl);

      const subEl = document.createElement('div');
      subEl.style.cssText = 'width:66.67%;min-width:0;height:100%;flex-shrink:0;';
      rowEl.appendChild(subEl);

      subCharts.push(makePitchBinChart(subEl, {
        segments: binSegs, pitchLo: plist[bi], pitchHi: plist[bi + 1],
        fullErrExt, colorSc, showXAxis: isLast, margin, units,
        fullTimeExt: pitchTimeExt, timeCap: pitchTimeCap,
      }, pitchLinks));

      const tableEl = document.createElement('div');
      tableEl.style.cssText = 'flex:1;min-width:0;height:100%;overflow:hidden;';
      rowEl.appendChild(tableEl);
      buildStatTable(tableEl, bi, ruleBottom);

      const rowRule = document.createElement('div');
      rowRule.style.cssText = `position:absolute;bottom:${ruleBottom}px;left:0;right:0;height:1px;background:#e5e7eb;`;
      rowEl.appendChild(rowRule);
    });

    // Colorbar — below plots, aligned with the 66.67% plot column
    const cbarEl = document.createElement('div');
    cbarEl.style.cssText = 'width:66.67%;min-width:0;';
    wrap.appendChild(cbarEl);

    const cbarChart = renderPitchColorbar(cbarEl, colorSc, tempRange, units, MARGIN);

    let _rt;
    const ro = new ResizeObserver(() => {
      clearTimeout(_rt);
      _rt = setTimeout(() => { subCharts.forEach(c => c.draw()); cbarChart.draw(); }, 120);
    });
    ro.observe(wrap);

    return {
      destroy() { ro.disconnect(); card.remove(); }
    };
  }

  // ── Quad plot orchestrator ────────────────────────────────────────────────
  function renderQuadPlot(container, data, opts = {}) {
    data = prepareDisplayData(data);  // convert °C→°F for F-unit models
    const cfg = window.ModelDashConfig?.models?.[data.msid]?.performanceOverview ?? {};
    const lnk = makeLinks();

    // Pre-compute shared extents so paired axes start at identical domains
    // and remain in sync after zooming or resetting either chart.
    //   tempY  : shared by time-series (top-left) and scatter (top-right)
    //   errorX : shared by scatter (top-right) and histogram (bottom-right)
    const _lims  = parseLimits(data);
    const _expLL = getLimitLines(_lims, data.limit_type).filter(l => l.expand).map(l => l.value);
    const _validO = data.observed.filter(v => v !== null);
    const _validP = data.predicted.filter(v => v !== null);
    const _validR = data.residuals.filter(v => v !== null);
    const _pad = ([lo, hi]) => { const r = (hi - lo) * 0.04; return [lo - r, hi + r]; };
    const sharedTempExt  = cfg.tempRange  ??
      _pad([d3.min([..._validO, ..._validP, ..._expLL]), d3.max([..._validO, ..._validP, ..._expLL])]);
    const sharedErrorExt = cfg.errorRange ??
      _pad([d3.min(_validR), d3.max(_validR)]);

    // prepareDisplayData shallow-spreads rawData, so inputs carries through untouched
    const hlArr = data.inputs?.['215pcast_off'] ?? null;

    const tsCfg   = { ...cfg, tempRange: sharedTempExt, hl: hlArr };
    const scCfg   = { ...cfg, tempRange: sharedTempExt, errorRange: sharedErrorExt, hl: hlArr };
    const etCfg   = { ...cfg, hl: hlArr };
    const histCfg = { ...cfg, errorRange: sharedErrorExt };

    const grid = document.createElement('div');
    grid.className = 'quad-grid';
    container.appendChild(grid);

    const mk = () => { const d = document.createElement('div'); d.className = 'quad-cell'; grid.appendChild(d); return d; };
    const tsEl = mk(), scEl = mk(), etEl = mk(), histEl = mk();

    const tsChart   = makeTimeSeriesChart(tsEl, data, lnk, tsCfg);
    const scChart   = makeScatterChart(scEl, data, lnk, scCfg);
    const etChart   = makeErrorTimeChart(etEl, data, lnk, etCfg);
    const histChart = makeHistogramChart(histEl, data, lnk, histCfg);

    function drawAll() { tsChart.draw(); scChart.draw(); etChart.draw(); histChart.draw(); }

    drawAll();

    let _rt;
    const ro = new ResizeObserver(() => { clearTimeout(_rt); _rt = setTimeout(drawAll, 120); });
    ro.observe(container);

    return {
      setJitter(v)        { scChart.setJitter(v); },
      setShowNormal(v)    { tsChart.setShowNormal(v); scChart.setShowNormal(v); etChart.setShowNormal(v); },
      setShowHighlight(v) { tsChart.setShowHighlight(v); scChart.setShowHighlight(v); etChart.setShowHighlight(v); },
      hasHighlight()      { return !!hlArr; },
      destroy()           { ro.disconnect(); },
    };
  }

  // ── Dwell Exploration Card ─────────────────────────────────────────────────
  function renderDwellExplorationCard(container, rawData) {
    const tbl = rawData.dwell_table;
    if (!tbl || !Array.isArray(tbl.tstart) || !tbl.tstart.length) return { destroy: () => {} };

    const dispUnit = MSID_DISPLAY_UNITS[rawData.msid] ?? 'C';
    const isF      = dispUnit === 'F';
    const unitsFmt = isF ? 'degF' : 'degC';

    const ALL_FIELDS = [
      { key: 'pitch',          label: 'Pitch',             utype: 'deg'  },
      { key: 'tstart',         label: 'Time',              utype: 'time' },
      { key: 'obs_start_temp', label: 'Start Temperature', utype: 'temp' },
      { key: 'obs_max_temp',   label: 'Peak Temperature',  utype: 'temp' },
      { key: 'obs_mean_temp',  label: 'Mean Temperature',  utype: 'temp' },
      { key: 'err_mean',       label: 'Mean Error',        utype: 'err'  },
      { key: 'err_max_abs',    label: 'Max |Error|',       utype: 'err'  },
      { key: 'err_p95',        label: '95th Pct |Error|',  utype: 'err'  },
      { key: 'err_end',        label: 'End Error',         utype: 'err'  },
      { key: 'simpos',         label: 'SIM-Z Position',    utype: null   },
      { key: 'n_points',       label: 'Data Points',       utype: null   },
      { key: 'pitch_bin',      label: 'Pitch Bin',         utype: null   },
    ].filter(f => Array.isArray(tbl[f.key]));

    // Auto-detect any additional numeric array fields not in the hardcoded list
    const knownKeys = new Set(ALL_FIELDS.map(f => f.key));
    const skipKeys  = new Set(['datestart']);
    for (const key of Object.keys(tbl)) {
      if (knownKeys.has(key) || skipKeys.has(key) || !Array.isArray(tbl[key])) continue;
      const sample = tbl[key].find(v => v != null);
      if (typeof sample !== 'number') continue;
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      ALL_FIELDS.push({ key, label, utype: null });
    }

    const fieldMap = Object.fromEntries(ALL_FIELDS.map(f => [f.key, f]));

    function toDisp(val, utype) {
      if (val === null || val === undefined || !isFinite(val)) return null;
      if (utype === 'temp') return isF ? val * 1.8 + 32 : val;
      if (utype === 'err')  return isF ? val * 1.8 : val;
      return val;
    }

    function axisLabel(key) {
      const f = fieldMap[key];
      if (!f) return key;
      if (f.utype === 'temp' || f.utype === 'err') return `${f.label} (${fmtUnits(unitsFmt)})`;
      if (f.utype === 'deg') return `${f.label} (°)`;
      return f.label;
    }

    const n    = tbl.tstart.length;
    const tMin = tbl.tstart[0], tMax = tbl.tstart[n - 1];

    // Continuous multi-color scale: blue (oldest) → yellow → red (newest)
    const colorSc = d3.scaleSequential(t => d3.interpolateRdYlBu(1 - t)).domain([0, 1]);

    const rows = Array.from({ length: n }, (_, i) => {
      const row = { _tNorm: tMax > tMin ? (tbl.tstart[i] - tMin) / (tMax - tMin) : 0.5 };
      for (const f of ALL_FIELDS) row[f.key] = toDisp(tbl[f.key][i], f.utype);
      return row;
    });

    // ── Card structure ──────────────────────────────────────────────────────
    const card = document.createElement('div');
    card.className = 'card mb-3';

    const hdr = document.createElement('div');
    hdr.className = 'card-header py-2';
    const hdrTitle = document.createElement('span');
    hdrTitle.className = 'small fw-semibold text-muted';
    hdrTitle.textContent = 'Dwell Exploration Plot';
    hdr.appendChild(hdrTitle);

    const body = document.createElement('div');
    body.className = 'card-body p-0';
    body.style.cssText = 'display:flex;flex-direction:column;';

    card.append(hdr, body);
    container.appendChild(card);

    // Plot row (fixed height)
    const inner = document.createElement('div');
    inner.style.cssText = 'display:flex;height:420px;flex-shrink:0;';
    body.appendChild(inner);

    // ── Left UI panel ───────────────────────────────────────────────────────
    const ui = document.createElement('div');
    ui.style.cssText = 'width:160px;min-width:160px;padding:10px 12px;display:flex;' +
      'flex-direction:column;gap:14px;border-right:1px solid #e5e7eb;background:#f9fafb;flex-shrink:0;';
    inner.appendChild(ui);

    function makeSelect(labelText, defaultKey) {
      const wrap = document.createElement('div');
      const lbl  = document.createElement('div');
      lbl.style.cssText = 'font-size:.72rem;font-weight:600;color:#6b7280;text-transform:uppercase;' +
        'letter-spacing:.04em;margin-bottom:4px;';
      lbl.textContent = labelText;
      const sel = document.createElement('select');
      sel.className = 'form-select form-select-sm';
      sel.style.fontSize = '.78rem';
      ALL_FIELDS.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.key; opt.textContent = f.label;
        if (f.key === defaultKey) opt.selected = true;
        sel.appendChild(opt);
      });
      wrap.append(lbl, sel);
      return { wrap, sel };
    }

    const { wrap: yWrap, sel: ySel } = makeSelect('Y Axis', 'err_p95');
    const { wrap: xWrap, sel: xSel } = makeSelect('X Axis', 'pitch');
    ui.append(yWrap, xWrap);

    // ── Plot panel ──────────────────────────────────────────────────────────
    const plotEl = document.createElement('div');
    plotEl.style.cssText = 'flex:1;min-width:0;height:100%;';
    inner.appendChild(plotEl);

    // ── Legend footer ───────────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 16px 8px;' +
      'border-top:1px solid #e5e7eb;background:#f9fafb;flex-shrink:0;';
    body.appendChild(footer);

    const startDateStr = cxcToDate(tMin).toISOString().slice(0, 10);
    const stopDateStr  = cxcToDate(tMax).toISOString().slice(0, 10);

    const olderLbl = document.createElement('span');
    olderLbl.style.cssText = 'font-size:.72rem;color:#6b7280;white-space:nowrap;';
    olderLbl.textContent = `Older (${startDateStr})`;

    const gradBar = document.createElement('div');
    // CSS gradient sampled from the same D3 scale so it exactly matches the dots
    const gradStops = Array.from({ length: 11 }, (_, i) => colorSc(i / 10)).join(', ');
    gradBar.style.cssText = `flex:1;height:10px;border-radius:4px;border:0.5px solid #d1d5db;` +
      `background:linear-gradient(to right, ${gradStops});`;

    const newerLbl = document.createElement('span');
    newerLbl.style.cssText = 'font-size:.72rem;color:#6b7280;white-space:nowrap;';
    newerLbl.textContent = `Newer (${stopDateStr})`;

    footer.append(olderLbl, gradBar, newerLbl);

    // ── Zoom state (persists across redraws) ─────────────────────────────────
    let fullXDomain = null, fullYDomain = null;
    let viewXDomain = null, viewYDomain = null;

    function resetDomains(xk, yk) {
      const isTime = xk === 'tstart';
      const pts    = rows.filter(r => r[xk] != null && r[yk] != null);
      let fxd;
      if (isTime) {
        const xe  = d3.extent(pts, d => d.tstart);
        const pad = (xe[1] - xe[0]) * 0.04;
        fxd = [cxcToDate(xe[0] - pad), cxcToDate(xe[1] + pad)];
      } else {
        const xe  = d3.extent(pts, d => d[xk]);
        const pad = Math.max((xe[1] - xe[0]) * 0.04, 1e-6);
        fxd = [xe[0] - pad, xe[1] + pad];
      }
      const ye   = d3.extent(pts, d => d[yk]);
      const ypad = Math.max((ye[1] - ye[0]) * 0.04, 1e-6);
      fullXDomain = fxd;
      fullYDomain = [ye[0] - ypad, ye[1] + ypad];
      viewXDomain = [...fullXDomain];
      viewYDomain = [...fullYDomain];
    }

    // ── Draw ────────────────────────────────────────────────────────────────
    function draw() {
      const xk     = xSel.value;
      const yk     = ySel.value;
      const isTime = xk === 'tstart';
      const xField = fieldMap[xk];
      const yField = fieldMap[yk];

      hdrTitle.textContent = `Dwell Exploration: ${yField.label} vs ${xField.label}`;

      const margin = { top: 24, right: 30, bottom: 52, left: 85 };
      const { svg, defs, g, w, h } = initSvg(plotEl, margin);

      const pts = rows.filter(r => r[xk] != null && r[yk] != null);
      if (!pts.length) return;

      const xSc = isTime
        ? d3.scaleTime().domain(viewXDomain).range([0, w])
        : d3.scaleLinear().domain(viewXDomain).range([0, w]);
      const ySc = d3.scaleLinear().domain(viewYDomain).range([h, 0]);

      addGridlines(g, xSc, ySc, w, h);
      g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(xSc).ticks(5))
        .selectAll('text').attr('font-size', 16);
      g.append('g').call(d3.axisLeft(ySc).ticks(6))
        .selectAll('text').attr('font-size', 16);

      g.append('text').attr('x', w / 2).attr('y', h + 44)
        .attr('text-anchor', 'middle').attr('font-size', 20).attr('fill', '#374151')
        .text(axisLabel(xk));
      g.append('text').attr('transform', `translate(-68,${h / 2})rotate(-90)`)
        .attr('text-anchor', 'middle').attr('font-size', 20).attr('fill', '#374151')
        .text(axisLabel(yk));

      const clipId = 'dwell-' + Math.random().toString(36).slice(2);
      defs.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);
      const pg = g.append('g').attr('clip-path', `url(#${clipId})`);

      pg.selectAll('circle').data(pts).enter().append('circle')
        .attr('cx', d => isTime ? xSc(cxcToDate(d.tstart)) : xSc(d[xk]))
        .attr('cy', d => ySc(d[yk]))
        .attr('r', 3)
        .attr('fill', d => colorSc(d._tNorm))
        .attr('opacity', 0.65)
        .attr('pointer-events', 'none');

      // Box zoom — same pattern as quad plots
      const brushG = addBrushZoom(g, defs, w, h,
        ([[x0, y0], [x1, y1]]) => {
          viewXDomain = [xSc.invert(x0), xSc.invert(x1)];
          viewYDomain = [ySc.invert(y1), ySc.invert(y0)];
          draw();
        },
        () => {
          viewXDomain = [...fullXDomain];
          viewYDomain = [...fullYDomain];
          draw();
        }
      );

      // Hover tooltip on the brush overlay
      brushG.select('.overlay')
        .on('mousemove.hover', function (event) {
          const [mx, my] = d3.pointer(event, this);
          let best = null, bestDist2 = Infinity;
          pts.forEach(p => {
            const px = isTime ? xSc(cxcToDate(p.tstart)) : xSc(p[xk]);
            const py = ySc(p[yk]);
            if (px < 0 || px > w || py < 0 || py > h) return;
            const dx = px - mx, dy = py - my;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDist2) { bestDist2 = d2; best = p; }
          });
          if (best && Math.sqrt(bestDist2) < 24) {
            const date  = cxcToDate(best.tstart).toISOString().slice(0, 10);
            const xDisp = isTime ? date : best[xk]?.toFixed(3) ?? '—';
            showTip(
              `<b>${date}</b><br>` +
              `${yField.label}: ${best[yk]?.toFixed(3) ?? '—'}<br>` +
              (xk !== 'tstart' ? `${xField.label}: ${xDisp}` : ''),
              event.clientX, event.clientY
            );
          } else {
            hideTip();
          }
        })
        .on('mouseleave.hover', () => hideTip());
    }

    function onFieldChange() {
      resetDomains(xSel.value, ySel.value);
      draw();
    }

    xSel.addEventListener('change', onFieldChange);
    ySel.addEventListener('change', onFieldChange);

    resetDomains('pitch', 'err_p95');
    draw();

    let _rt;
    const ro = new ResizeObserver(() => { clearTimeout(_rt); _rt = setTimeout(draw, 120); });
    ro.observe(plotEl);

    return { destroy() { ro.disconnect(); card.remove(); } };
  }

  // ── Solarheat Parameters Card ─────────────────────────────────────────────
  function renderSolarheatCard(container, rawData) {
    const components = rawData.solar_heat_components;
    if (!components || !components.length) return { destroy: () => {} };

    const INST_LABELS = { hrcs: 'HRC-S', hrci: 'HRC-I', aciss: 'ACIS-S', acisi: 'ACIS-I' };

    const palette = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
                     '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'];

    // Linear interpolation of (xKnots, yKnots) evaluated at a single x
    function interpLinear(xKnots, yKnots, x) {
      if (x <= xKnots[0]) return yKnots[0];
      if (x >= xKnots[xKnots.length - 1]) return yKnots[yKnots.length - 1];
      let lo = 0;
      while (lo < xKnots.length - 2 && xKnots[lo + 1] < x) lo++;
      const t = (x - xKnots[lo]) / (xKnots[lo + 1] - xKnots[lo]);
      return yKnots[lo] + t * (yKnots[lo + 1] - yKnots[lo]);
    }

    const allSeries = [];
    let colorIdx = 0;

    for (const comp of components) {
      const label = comp.node || comp.name.split('__').pop();

      // Interpolate dP onto P_pitches so we can add it to P directly.
      // dP_pitches may differ from P_pitches; xija does the same interpolation at run time.
      const hasDp = comp.dP && comp.dP_pitches && comp.dP.some(v => v !== 0);
      const dPAtP = hasDp
        ? comp.P_pitches.map(p => interpLinear(comp.dP_pitches, comp.dP, p))
        : null;

      function makeSeries(seriesLabel, pVals, color) {
        const pPts = comp.P_pitches
          .map((p, i) => ({
            pitch: p, value: pVals[i],
            tipP: pVals[i],
            tipDp:  hasDp ? dPAtP[i]              : null,
            tipPdP: hasDp ? pVals[i] + dPAtP[i]   : null,
          }))
          .filter(d => isFinite(d.pitch) && isFinite(d.value));
        if (pPts.length) allSeries.push({ label: seriesLabel, pts: pPts, dash: null, color });

        if (hasDp) {
          const pdPts = comp.P_pitches
            .map((p, i) => ({
              pitch: p, value: pVals[i] + dPAtP[i],
              tipP: pVals[i],
              tipDp:  dPAtP[i],
              tipPdP: pVals[i] + dPAtP[i],
            }))
            .filter(d => isFinite(d.pitch) && isFinite(d.value));
          if (pdPts.length) allSeries.push({ label: `${seriesLabel} + dP`, pts: pdPts, dash: '5,3', color });
        }
      }

      if (Array.isArray(comp.P)) {
        makeSeries(label, comp.P, palette[colorIdx % palette.length]);
        colorIdx++;
      } else if (comp.P && typeof comp.P === 'object') {
        for (const [instKey, vals] of Object.entries(comp.P)) {
          makeSeries(
            `${label} ${INST_LABELS[instKey] || instKey}`,
            vals,
            palette[colorIdx % palette.length],
          );
          colorIdx++;
        }
      }
    }

    if (!allSeries.length) return { destroy: () => {} };

    // Histogram: dwell count per 3° pitch bin from dwell_table
    const pitchArr = (rawData.dwell_table?.pitch || []).filter(v => v != null && isFinite(v));
    const BIN_W = 3, P_MIN = 45, P_MAX = 180;
    const nBins  = Math.ceil((P_MAX - P_MIN) / BIN_W);
    const counts = new Array(nBins).fill(0);
    pitchArr.forEach(p => {
      const bi = Math.floor((p - P_MIN) / BIN_W);
      if (bi >= 0 && bi < nBins) counts[bi]++;
    });
    const histBins = counts.map((count, i) => ({
      x0: P_MIN + i * BIN_W,
      x1: P_MIN + (i + 1) * BIN_W,
      count,
    }));

    // ── Card DOM ───────────────────────────────────────────────────────────
    const card = document.createElement('div');
    card.className = 'card mb-3';

    const hdr = document.createElement('div');
    hdr.className = 'card-header py-2';
    const hdrTitle = document.createElement('span');
    hdrTitle.className = 'small fw-semibold text-muted';
    hdrTitle.textContent = 'Solarheat Parameters vs Pitch';
    hdr.appendChild(hdrTitle);

    const body = document.createElement('div');
    body.className = 'card-body p-2';
    body.style.cssText = 'display:flex;flex-direction:column;height:380px;';

    const plotEl = document.createElement('div');
    plotEl.style.cssText = 'flex:1;min-height:0;';

    // ── HTML legend (built once, below the plot) ───────────────────────────
    const legendEl = document.createElement('div');
    legendEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 14px;' +
      'padding:6px 4px 2px;border-top:1px solid #e5e7eb;flex-shrink:0;';

    const NS = 'http://www.w3.org/2000/svg';
    function makeSwatch(color, dash) {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '28'); svg.setAttribute('height', '10');
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', '2');  line.setAttribute('x2', '26');
      line.setAttribute('y1', '5');  line.setAttribute('y2', '5');
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '2.5');
      if (dash) line.setAttribute('stroke-dasharray', dash);
      svg.appendChild(line);
      return svg;
    }

    allSeries.forEach(s => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:.75rem;color:#374151;white-space:nowrap;';
      lbl.textContent = s.label;
      item.append(makeSwatch(s.color, s.dash), lbl);
      legendEl.appendChild(item);
    });

    // Histogram entry
    const histItem = document.createElement('div');
    histItem.style.cssText = 'display:flex;align-items:center;gap:4px;';
    const histSwatch = document.createElement('div');
    histSwatch.style.cssText = 'width:28px;height:10px;flex-shrink:0;border-radius:1px;' +
      'background:#94a3b8;opacity:0.5;';
    const histLbl = document.createElement('span');
    histLbl.style.cssText = 'font-size:.75rem;color:#6b7280;white-space:nowrap;';
    histLbl.textContent = 'Dwell count (right axis)';
    histItem.append(histSwatch, histLbl);
    legendEl.appendChild(histItem);

    body.append(plotEl, legendEl);
    card.append(hdr, body);
    container.appendChild(card);

    // ── Draw ───────────────────────────────────────────────────────────────
    function draw() {
      const margin = { top: 24, right: 72, bottom: 52, left: 85 };
      const { svg, defs, g, w, h } = initSvg(plotEl, margin);

      const xSc = d3.scaleLinear().domain([P_MIN, P_MAX]).range([0, w]);

      const allVals = allSeries.flatMap(s => s.pts.map(d => d.value));
      const [vMin, vMax] = d3.extent(allVals);
      const vPad = Math.max((vMax - vMin) * 0.10, 1e-9);
      const ySc = d3.scaleLinear().domain([vMin - vPad, vMax + vPad]).nice().range([h, 0]);

      const maxCount = d3.max(counts) || 1;
      const yCntSc = d3.scaleLinear().domain([0, maxCount * 1.15]).range([h, 0]);

      // Histogram bars behind everything
      const histG = g.append('g');
      histBins.forEach(d => {
        if (!d.count) return;
        histG.append('rect')
          .attr('x',      xSc(d.x0) + 0.5)
          .attr('y',      yCntSc(d.count))
          .attr('width',  Math.max(xSc(d.x1) - xSc(d.x0) - 1, 1))
          .attr('height', h - yCntSc(d.count))
          .attr('fill',   '#94a3b8')
          .attr('opacity', 0.30);
      });

      addGridlines(g, xSc, ySc, w, h);

      g.append('g').attr('transform', `translate(0,${h})`)
        .call(d3.axisBottom(xSc).ticks(9).tickFormat(d => `${d}°`))
        .selectAll('text').attr('font-size', 14);

      g.append('g').call(d3.axisLeft(ySc).ticks(6))
        .selectAll('text').attr('font-size', 14);

      g.append('g').attr('transform', `translate(${w},0)`)
        .call(d3.axisRight(yCntSc).ticks(5).tickFormat(d3.format('d')))
        .call(gg => gg.selectAll('text').attr('font-size', 14));

      g.append('text').attr('x', w / 2).attr('y', h + 44)
        .attr('text-anchor', 'middle').attr('font-size', 16).attr('fill', '#374151')
        .text('Pitch (°)');
      g.append('text').attr('transform', `translate(-68,${h / 2})rotate(-90)`)
        .attr('text-anchor', 'middle').attr('font-size', 16).attr('fill', '#374151')
        .text('Solarheat Value');
      g.append('text').attr('transform', `translate(${w + 57},${h / 2})rotate(90)`)
        .attr('text-anchor', 'middle').attr('font-size', 14).attr('fill', '#94a3b8')
        .text('Dwell Count');

      const clipId = 'sh-' + Math.random().toString(36).slice(2);
      defs.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);
      const linesG = g.append('g').attr('clip-path', `url(#${clipId})`);

      const lineGen = d3.line()
        .x(d => xSc(d.pitch))
        .y(d => ySc(d.value))
        .defined(d => isFinite(d.value));

      allSeries.forEach(s => {
        linesG.append('path')
          .datum(s.pts)
          .attr('fill', 'none')
          .attr('stroke', s.color)
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', s.dash || null)
          .attr('d', lineGen);
        linesG.selectAll(null).data(s.pts).enter().append('circle')
          .attr('cx', d => xSc(d.pitch))
          .attr('cy', d => ySc(d.value))
          .attr('r', 3.5)
          .attr('fill', s.color)
          .attr('stroke', '#fff')
          .attr('stroke-width', 1)
          .style('cursor', 'pointer')
          .on('mouseenter', (event, d) => {
            const f = v => (v != null && isFinite(v)) ? v.toFixed(4) : '—';
            let html = `<b>${s.label}</b><br>Pitch: ${d.pitch}°`
              + `<br>P: ${f(d.tipP)}`;
            if (d.tipDp  != null) html += `<br>dP: ${f(d.tipDp)}`;
            if (d.tipPdP != null) html += `<br>P + dP: ${f(d.tipPdP)}`;
            showTip(html, event.clientX, event.clientY);
          })
          .on('mouseleave', hideTip);
      });

    }

    draw();

    let _rt;
    const ro = new ResizeObserver(() => { clearTimeout(_rt); _rt = setTimeout(draw, 120); });
    ro.observe(plotEl);

    return { destroy() { ro.disconnect(); card.remove(); } };
  }

  // ── DPA State Power Card ──────────────────────────────────────────────────
  function renderDpaPowerCard(container, rawData) {
    const dp = rawData.dpa_power;
    if (!dp || typeof dp.lookup !== 'object') return { destroy: () => {} };
    const entries = Object.entries(dp.lookup);
    if (!entries.length) return { destroy: () => {} };

    const CLK_COLOR  = '#f28e2b';  // clocking
    const NCLK_COLOR = '#4e79a7';  // not clocking
    const WILD_COLOR = '#6b7280';  // wildcard clocking state (e.g. 0-FEP)
    const JITTER = 0.18;

    // State key format: "[fep_count]xx[clocking]"
    // First char = FEP count digit; last char = '1' clocking, '0' not clocking, 'x' wildcard
    function parseStateKey(key) {
      const fep = parseInt(key[0], 10);
      const last = key[key.length - 1];
      const clocking = last === '1' ? true : last === '0' ? false : null;
      return { fep, clocking };
    }

    // Build row objects; jitter is stable across redraws (computed once here)
    const rows = entries.map(([state, power]) => {
      const { fep, clocking } = parseStateKey(state);
      return { state, fep, power, clocking, jx: (Math.random() - 0.5) * 2 * JITTER };
    }).filter(r => isFinite(r.fep) && isFinite(r.power));

    if (!rows.length) return { destroy: () => {} };

    const hasWild = rows.some(r => r.clocking === null);
    const rowColor = r => r.clocking === true ? CLK_COLOR : r.clocking === false ? NCLK_COLOR : WILD_COLOR;

    // ── Card DOM ─────────────────────────────────────────────────────────
    const card = document.createElement('div');
    card.className = 'card mb-3';

    const hdr = document.createElement('div');
    hdr.className = 'card-header py-2';
    const hdrTitle = document.createElement('span');
    hdrTitle.className = 'small fw-semibold text-muted';
    hdrTitle.textContent = 'ACIS DPA State Power';
    hdr.appendChild(hdrTitle);

    const body = document.createElement('div');
    body.className = 'card-body p-2';
    body.style.cssText = 'display:flex;flex-direction:column;height:320px;';

    const plotEl = document.createElement('div');
    plotEl.style.cssText = 'flex:1;min-height:0;';

    // HTML legend (built once)
    const legendEl = document.createElement('div');
    legendEl.style.cssText = 'display:flex;gap:16px;padding:5px 4px 2px;' +
      'border-top:1px solid #e5e7eb;flex-shrink:0;';

    const NS = 'http://www.w3.org/2000/svg';
    const legendItems = [
      { color: CLK_COLOR,  label: 'Clocking' },
      { color: NCLK_COLOR, label: 'Not Clocking' },
      ...(hasWild ? [{ color: WILD_COLOR, label: 'Mixed' }] : []),
    ];
    legendItems.forEach(({ color, label }) => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', '6'); c.setAttribute('cy', '6');
      c.setAttribute('r', '5'); c.setAttribute('fill', color);
      svg.appendChild(c);
      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:.75rem;color:#374151;';
      lbl.textContent = label;
      item.append(svg, lbl);
      legendEl.appendChild(item);
    });

    body.append(plotEl, legendEl);
    card.append(hdr, body);
    container.appendChild(card);

    // ── Draw ─────────────────────────────────────────────────────────────
    function draw() {
      const margin = { top: 24, right: 30, bottom: 52, left: 85 };
      const { svg, defs, g, w, h } = initSvg(plotEl, margin);

      const fepVals = rows.map(r => r.fep);
      const fepMin  = Math.min(...fepVals), fepMax = Math.max(...fepVals);
      const xSc = d3.scaleLinear().domain([fepMin - 0.5, fepMax + 0.5]).range([0, w]);

      const pMax = d3.max(rows, r => r.power) || 1;
      const ySc  = d3.scaleLinear().domain([0, pMax * 1.1]).nice().range([h, 0]);

      addGridlines(g, xSc, ySc, w, h);

      const fepTicks = [...new Set(fepVals)].sort((a, b) => a - b);
      g.append('g').attr('transform', `translate(0,${h})`)
        .call(d3.axisBottom(xSc).tickValues(fepTicks).tickFormat(d3.format('d')))
        .selectAll('text').attr('font-size', 14);
      g.append('g').call(d3.axisLeft(ySc).ticks(6))
        .selectAll('text').attr('font-size', 14);

      g.append('text').attr('x', w / 2).attr('y', h + 44)
        .attr('text-anchor', 'middle').attr('font-size', 16).attr('fill', '#374151')
        .text('FEP Count');
      g.append('text').attr('transform', `translate(-68,${h / 2})rotate(-90)`)
        .attr('text-anchor', 'middle').attr('font-size', 16).attr('fill', '#374151')
        .text('Power (W)');

      const clipId = 'dp-' + Math.random().toString(36).slice(2);
      defs.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);
      const pg = g.append('g').attr('clip-path', `url(#${clipId})`);

      pg.selectAll('circle').data(rows).enter().append('circle')
        .attr('cx', r => xSc(r.fep + r.jx))
        .attr('cy', r => ySc(r.power))
        .attr('r', 5)
        .attr('fill', rowColor)
        .attr('stroke', '#fff')
        .attr('stroke-width', 0.8)
        .attr('opacity', 0.80)
        .style('cursor', 'pointer')
        .on('mouseenter', (event, r) => {
          const clkLabel = r.clocking === true ? 'Yes' : r.clocking === false ? 'No' : '—';
          const lines = [
            `<b>State: ${r.state}</b>`,
            `FEP Count: ${r.fep}`,
            `Clocking: ${clkLabel}`,
            `Power: ${r.power.toFixed(2)} W`,
          ].join('<br>');
          showTip(lines, event.clientX, event.clientY);
        })
        .on('mouseleave', hideTip);
    }

    draw();

    let _rt;
    const ro = new ResizeObserver(() => { clearTimeout(_rt); _rt = setTimeout(draw, 120); });
    ro.observe(plotEl);

    return { destroy() { ro.disconnect(); card.remove(); } };
  }

  return { loadManifest, loadModelData, renderQuadPlot, renderPitchErrorCard, renderDwellExplorationCard, renderSolarheatCard, renderDpaPowerCard, _cache };
})();
