/**
 * app.js — Xija Steady States website application logic
 *
 * Exported as a global App object so QUnit tests in tests.html can import
 * these functions without a module bundler.
 *
 * Schema contract (SCHEMA.md):
 *   manifest.json  → array of NavEntry {nav_id, display_name, msid, units, controls}
 *   metadata.json  → {nav_id, display_name, pitch_step, configs: {config_id: {dates, files, table_csv, lookahead}}}
 *                    (lookahead: static data for the lookahead card, SCHEMA.md §3.4; may be absent)
 *   <date>.json.gz → gzip of {times, series[{pitch, temperatures}], meta{start_date,end_date,units,annotation}}
 *                    (fetched as bytes and decompressed with DecompressionStream; see parseJsonBytes)
 *
 * All paths in metadata.json begin with "data/" and are passed directly to fetch().
 */
(function (global) {
  'use strict';

  // ─── In-memory data cache ─────────────────────────────────────────────────
  // Prevents duplicate network requests when the user revisits a tab.
  const _cache = {
    manifest: null,       // null | NavEntry[]
    metadata: {},         // { [nav_id]: MetadataObject }
    charts: {},           // { [chart_json_path]: ChartDataObject }
    tables: {}            // { [table_csv_path]: string }
  };

  // ─── Pure helper functions (testable) ─────────────────────────────────────

  /**
   * Validate and return a parsed manifest array.
   * Throws if input is not an array.
   *
   * @param   {*}            manifest  - value to validate
   * @returns {NavEntry[]}             - the same array
   */
  function parseManifest(manifest) {
    if (!Array.isArray(manifest)) {
      throw new Error('manifest must be an array');
    }
    return manifest;
  }

  /**
   * Resolve the config_id string from the current UI control state.
   *
   * Rules (SCHEMA.md §1.3):
   *   - No controls → "default"
   *   - Has feps_ccds + focal_plane_special, and specialCase is true → "feps_3_0ccd_noclk"
   *   - Has feps_ccds → "feps_<fepsValue>"
   *
   * @param {Array}   controls    - controls array from manifest/metadata
   * @param {number}  fepsValue   - currently selected FEPs/CCDs value (1–6)
   * @param {boolean} specialCase - true when "3 FEPs, 0 CCDs, Not Clocking" is selected
   * @returns {string} config_id
   */
  function resolveConfigId(controls, fepsValue, specialCase) {
    const hasFeps    = controls.some(c => c.type === 'feps_ccds');
    const hasSpecial = controls.some(c => c.type === 'focal_plane_special');

    if (!hasFeps) return 'default';
    if (hasSpecial && specialCase) return 'feps_3_0ccd_noclk';
    return `feps_${fepsValue}`;
  }

  /**
   * Build the HTML fragment for the configuration controls panel.
   * Returns an empty string for models with no user-selectable options.
   *
   * @param {NavEntry} navEntry - a single entry from the manifest
   * @returns {string} HTML string
   */
  function buildControlsHTML(navEntry) {
    const controls  = navEntry.controls || [];
    const hasFeps    = controls.some(c => c.type === 'feps_ccds');
    const hasSpecial = controls.some(c => c.type === 'focal_plane_special');

    if (!hasFeps && !hasSpecial) return '';

    let html = '<div class="controls-panel">';

    if (hasFeps) {
      const opts = controls.find(c => c.type === 'feps_ccds').options;
      html += '<div>';
      html += '<label class="form-label small text-muted mb-1" for="ctrl-feps">FEPs / CCDs</label>';
      html += '<select class="form-select form-select-sm" id="ctrl-feps">';
      opts.forEach(n => {
        const label = `${n} FEP${n !== 1 ? 's' : ''} / ${n} CCD${n !== 1 ? 's' : ''}`;
        html += `<option value="${n}">${label}</option>`;
      });
      html += '</select></div>';
    }

    if (hasSpecial) {
      html += '<div class="form-check mt-2">';
      html += '<input class="form-check-input" type="checkbox" id="ctrl-special">';
      html += '<label class="form-check-label small" for="ctrl-special">';
      html += '3 FEPs, 0 CCDs, Not Clocking (HRC sim_z)</label>';
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  /**
   * Build the HTML fragment for the date selector dropdown.
   * Converts file-key dates ("YYYYddd") to Chandra DOY format ("YYYY:ddd") for display.
   *
   * @param {string[]} dates - array of file-key date strings
   * @returns {string} HTML string
   */
  function buildDateSelectorHTML(dates) {
    if (!dates || dates.length === 0) return '';

    let html = '<div>';
    html += '<label class="form-label small text-muted mb-1" for="ctrl-date">Date</label>';
    html += '<select class="form-select form-select-sm" id="ctrl-date">';
    dates.forEach(d => {
      // File-key date "2024001" → display "2024:001"
      const display = (d.length === 7) ? `${d.slice(0, 4)}:${d.slice(4)}` : d;
      html += `<option value="${d}">${display}</option>`;
    });
    html += '</select></div>';
    return html;
  }

  /**
   * Return the cache key for a chart data file (currently just the path).
   *
   * @param {string} chartJsonPath
   * @returns {string}
   */
  function getChartCacheKey(chartJsonPath) {
    return chartJsonPath;
  }

  /**
   * Return the available dates for a given config_id from metadata.
   *
   * @param {Object} metadata  - parsed metadata JSON
   * @param {string} configId
   * @returns {string[]}
   */
  function getDatesForConfig(metadata, configId) {
    if (!metadata || !metadata.configs || !metadata.configs[configId]) return [];
    return metadata.configs[configId].dates || [];
  }

  /**
   * Return the FileRef object {chart_json, csv} for a config+date, or null.
   *
   * @param {Object} metadata
   * @param {string} configId
   * @param {string} date     - file-key date ("YYYYddd")
   * @returns {{chart_json:string, csv:string}|null}
   */
  function getFileRef(metadata, configId, date) {
    const config = metadata && metadata.configs && metadata.configs[configId];
    if (!config || !config.files || !config.files[date]) return null;
    return config.files[date];
  }

  // ─── Pitch resolution (5° / 1° view) ──────────────────────────────────────
  // The data may be generated at a fine pitch step (1° by default, SCHEMA.md
  // §3.1). The page shows the 5° subset by default and offers a toggle to show
  // every pitch. Filtering happens in the browser on cached data, so switching
  // resolution never fetches anything.

  /**
   * Pitch step of a model's data, from metadata.json. Metadata written before
   * pitch_step was recorded holds 5° data, so a missing key means 5.
   *
   * @param {Object|null} metadata
   * @returns {number}
   */
  function getPitchStep(metadata) {
    return (metadata && metadata.pitch_step) || 5;
  }

  /**
   * Display resolutions available for data at `pitchStep`, default first.
   * A 5° view is offered only when it is a subset of the data (5 is a
   * multiple of the step); otherwise the data is shown as is.
   *
   * @param {number} pitchStep
   * @returns {number[]} e.g. [5, 1] for 1° data, [5] for 5° data
   */
  function getResolutionOptions(pitchStep) {
    if (pitchStep < 5 && 5 % pitchStep === 0) return [5, pitchStep];
    return [pitchStep];
  }

  /**
   * The step to display: the user's preference if available, else the default.
   *
   * @param {number[]} options    - from getResolutionOptions
   * @param {number}   preferred  - the last step the user picked (5 on page load)
   * @returns {number}
   */
  function resolveDisplayStep(options, preferred) {
    return options.includes(preferred) ? preferred : options[0];
  }

  /**
   * Build the HTML for the pitch resolution toggle (a Bootstrap button group
   * of radio inputs). Returns '' when there is nothing to choose between.
   *
   * @param {number[]} options  - from getResolutionOptions
   * @param {number}   selected - the step currently displayed
   * @returns {string} HTML string
   */
  function buildResolutionToggleHTML(options, selected) {
    if (!options || options.length < 2) return '';

    let html = '<div>';
    html += '<div class="form-label small text-muted mb-1" id="ctrl-resolution-label">Pitch resolution</div>';
    html += '<div class="btn-group btn-group-sm" role="group" aria-label="Pitch resolution">';
    options.forEach(step => {
      const id = `ctrl-res-${step}`;
      html += `<input type="radio" class="btn-check" name="ctrl-resolution" id="${id}" value="${step}" autocomplete="off"${step === selected ? ' checked' : ''}>`;
      html += `<label class="btn btn-outline-primary" for="${id}">${step}°</label>`;
    });
    html += '</div></div>';
    return html;
  }

  // A pitch is on the `step` grid when it is a multiple of `step` from 45°.
  function onPitchGrid(pitch, step) {
    return (pitch - 45) % step === 0;
  }

  /**
   * Return chart data showing only the pitches on the `step` grid. The input
   * (a cached object) is never modified; when every pitch is already on the
   * grid it is returned as is.
   *
   * @param {Object} data - chart JSON (SCHEMA.md §4)
   * @param {number} step - display step in degrees
   * @returns {Object}
   */
  function filterChartByStep(data, step) {
    if (data.series.every(s => onPitchGrid(s.pitch, step))) return data;
    return Object.assign({}, data, {
      series: data.series.filter(s => onPitchGrid(s.pitch, step))
    });
  }

  /**
   * Return summary-table CSV text keeping the header and the rows whose pitch
   * (first column) is on the `step` grid. Unchanged text when nothing is
   * dropped.
   *
   * @param {string} csvText
   * @param {number} step
   * @returns {string}
   */
  function filterTableCsvByStep(csvText, step) {
    const lines = csvText.split('\n');
    const kept  = lines.filter((line, i) => {
      if (i === 0 || line.trim() === '') return true;
      const pitch = parseInt(line.split(',')[0], 10);
      return !isFinite(pitch) || onPitchGrid(pitch, step);
    });
    return kept.length === lines.length ? csvText : kept.join('\n');
  }

  // ─── Fetch helpers ────────────────────────────────────────────────────────

  async function fetchJSON(path) {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${path}`);
    return resp.json();
  }

  /**
   * Parse JSON from fetched bytes, gunzipping first if they are gzip data.
   *
   * Chart files are stored as .json.gz (SCHEMA.md §4) and decompressed with
   * the browser's built-in DecompressionStream, as the Meridian apps do, so no
   * library is needed. The gzip magic bytes are checked rather than assumed:
   * a server configured to send .gz files with "Content-Encoding: gzip" has
   * the browser decompress them already, and the bytes arrive as plain JSON.
   *
   * @param {ArrayBuffer} buffer
   * @returns {Promise<any>}
   */
  async function parseJsonBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    let text;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder().decode(bytes);
    }
    return JSON.parse(text);
  }

  async function fetchGzipJSON(path) {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${path}`);
    return parseJsonBytes(await resp.arrayBuffer());
  }

  async function fetchText(path) {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${path}`);
    return resp.text();
  }

  // ─── Cached async loaders ─────────────────────────────────────────────────
  // Each loader checks _cache first; network requests are made at most once
  // per key within a page session.

  async function loadManifest() {
    if (_cache.manifest) return _cache.manifest;
    _cache.manifest = await fetchJSON('data/manifest.json');
    return _cache.manifest;
  }

  async function loadMetadata(navId) {
    if (_cache.metadata[navId]) return _cache.metadata[navId];
    _cache.metadata[navId] = await fetchJSON(`data/${navId}/metadata.json`);
    return _cache.metadata[navId];
  }

  async function loadChartData(chartJsonPath) {
    const key = getChartCacheKey(chartJsonPath);
    if (_cache.charts[key]) return _cache.charts[key];
    _cache.charts[key] = await fetchGzipJSON(chartJsonPath);
    return _cache.charts[key];
  }

  // The summary table is one file per config, shared by all its dates.
  async function loadTableCsv(tableCsvPath) {
    if (tableCsvPath in _cache.tables) return _cache.tables[tableCsvPath];
    _cache.tables[tableCsvPath] = await fetchText(tableCsvPath);
    return _cache.tables[tableCsvPath];
  }

  // ─── D3 dwell chart renderer ──────────────────────────────────────────────

  /**
   * Render a multi-line dwell chart into `container` using D3 v7.
   *
   * Data schema (SCHEMA.md §4):
   *   data.times                   – shared x-axis, kiloseconds (ks)
   *   data.series[i].pitch         – pitch angle, 45–180° ascending at the run's
   *                                  pitch step (28 entries at the default 5°)
   *   data.series[i].temperatures  – y-values, same length as times
   *   data.meta.units              – "Celsius" or "Fahrenheit" (y-axis label)
   *   data.meta.annotation         – chart subtitle string
   *
   * Color mapping depends on the pitch step, read from the data (gap between
   * the first two pitches):
   *   - 5° or coarser (≤ 28 curves): categorical d3.schemeCategory10, indexed
   *     by curve position and cycling every 10, so adjacent lines always
   *     differ. Legend: one swatch per pitch.
   *   - Finer than 5° (e.g. 1°, 136 curves): sequential viridis gradient over
   *     45–180°, so color encodes pitch. Legend: a color bar labelled every
   *     15°. The tooltip lists the 5° pitches plus the curve nearest the
   *     cursor (bold), instead of every curve.
   * Either way the mapping depends only on the pitches in the data, so colors
   * are consistent across renders and model switches.
   *
   * @param {HTMLElement} container - wrapping div; SVG fills container.clientWidth
   * @param {Object}      data      - parsed chart JSON matching schema above
   */
  function renderDwellChart(container, data) {
    // Clear any previous render
    d3.select(container).selectAll('*').remove();

    const margin = { top: 30, right: 115, bottom: 52, left: 65 };
    const totalWidth  = Math.max(container.clientWidth || 600, 400);
    const totalHeight = 600;
    const w = totalWidth  - margin.left - margin.right;
    const h = totalHeight - margin.top  - margin.bottom;

    const svg = d3.select(container)
      .append('svg')
      .attr('width',  totalWidth)
      .attr('height', totalHeight)
      .attr('role',       'img')
      .attr('aria-label', `Dwell chart: ${data.meta.annotation}`);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // ── Scales ──────────────────────────────────────────────────────────────
    // x: time in ks; domain derived from actual data (not a constant)
    const xScale = d3.scaleLinear()
      .domain([data.times[0], data.times[data.times.length - 1]])
      .range([0, w]);

    // y: temperature; padded 5% so lines aren't clipped at edges
    const allTemps = data.series.flatMap(s => s.temperatures);
    const [yMin, yMax] = d3.extent(allTemps);
    const yPad = (yMax - yMin) * 0.05;
    const yScale = d3.scaleLinear()
      .domain([yMin - yPad, yMax + yPad])
      .range([h, 0]);

    // color: categorical by curve position (cycling every 10) at 5° or coarser;
    // a viridis gradient over 45–180° for finer steps, where 10 cycling colors
    // would repeat every few degrees. Viridis stops at 0.9: its last tenth is
    // too pale to see on a white background.
    const pitches   = data.series.map(s => s.pitch);
    const pitchStep = pitches.length > 1 ? pitches[1] - pitches[0] : 5;
    const finePitch = pitchStep < 5;
    const pitchIndex = new Map(pitches.map((p, i) => [p, i]));
    const viridisT  = pitch => 0.9 * (pitch - 45) / 135;
    const pitchColor = finePitch
      ? pitch => d3.interpolateViridis(viridisT(pitch))
      : pitch => d3.schemeCategory10[pitchIndex.get(pitch) % 10];

    // ── Grid lines ───────────────────────────────────────────────────────────
    g.append('g')
      .attr('class', 'grid')
      .attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(xScale).ticks(8).tickSize(-h).tickFormat(''))
      .select('.domain').remove();

    g.append('g')
      .attr('class', 'grid')
      .call(d3.axisLeft(yScale).ticks(8).tickSize(-w).tickFormat(''))
      .select('.domain').remove();

    g.selectAll('.grid line')
      .attr('stroke', '#e5e7eb')
      .attr('stroke-dasharray', '2 3');

    // ── Pitch lines ──────────────────────────────────────────────────────────
    const lineGen = d3.line()
      .x((_, i) => xScale(data.times[i]))
      .y(d => yScale(d));

    data.series.forEach(series => {
      g.append('path')
        .datum(series.temperatures)
        .attr('fill',         'none')
        .attr('stroke',       pitchColor(series.pitch))
        .attr('stroke-width', finePitch ? 1 : 1.5)
        .attr('opacity',      0.85)
        .attr('class',        'pitch-line')
        .attr('data-pitch',   series.pitch)
        .attr('d',            lineGen);
    });

    // ── Axes ─────────────────────────────────────────────────────────────────
    // g.append('g')
    //   .attr('transform', `translate(0,${h})`)
    //   .attr('font-size', '26px')
    //   .call(d3.axisBottom(xScale).ticks(8));

    // g.append('g')
    //   .attr('font-size', '16px')
    //   .call(d3.axisLeft(yScale).ticks(8));

    const xAxis = g.append('g')
      .attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(xScale).ticks(8));

    xAxis.selectAll('.tick text')
      .attr('font-size', '16px');

    const yAxis = g.append('g')
      .call(d3.axisLeft(yScale).ticks(8));

    yAxis.selectAll('.tick text')
      .attr('font-size', '16px');

    // ── Axis labels ──────────────────────────────────────────────────────────
    g.append('text')
      .attr('text-anchor', 'middle')
      .attr('x', w / 2)
      .attr('y', h + 44)
      .attr('fill', '#444')
      .attr('font-size', '16px')
      .text('Dwell Time (ks)');

    g.append('text')
      .attr('text-anchor', 'middle')
      .attr('transform',   `rotate(-90) translate(${-h / 2}, ${-53})`)
      .attr('fill', '#444')
      .attr('font-size', '16px')
      .text(`Temperature (${data.meta.units})`);

    // Chart subtitle (annotation string from meta)
    g.append('text')
      .attr('text-anchor', 'middle')
      .attr('x', w / 2)
      .attr('y', -5)
      .attr('fill', '#666')
      .attr('font-size', '26px')
      .text(data.meta.annotation);

    // ── Crosshair + tooltip hover ─────────────────────────────────────────
    const bisect = d3.bisector(t => t).left;

    // Vertical crosshair line (hidden until mousemove)
    const crosshair = g.append('line')
      .attr('y1', 0).attr('y2', h)
      .attr('stroke', '#9ca3af')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4 3')
      .style('display', 'none');

    // Tooltip div absolutely positioned inside container
    const tooltip = d3.select(container)
      .append('div')
      .attr('class', 'dwell-tooltip')
      .style('display', 'none');

    // Transparent overlay captures pointer events (drawn last → on top)
    g.append('rect')
      .attr('width',   w)
      .attr('height',  h)
      .attr('fill',    'none')
      .attr('pointer-events', 'all')
      .on('mousemove', function (event) {
        const [mx, my] = d3.pointer(event);
        const xVal = xScale.invert(mx);
        let idx = bisect(data.times, xVal);
        // Snap to nearest time index
        if (idx > 0 && idx < data.times.length) {
          const d0 = Math.abs(data.times[idx - 1] - xVal);
          const d1 = Math.abs(data.times[idx]     - xVal);
          if (d0 < d1) idx = idx - 1;
        }
        idx = Math.max(0, Math.min(idx, data.times.length - 1));
        const t = data.times[idx];

        crosshair
          .attr('x1', xScale(t)).attr('x2', xScale(t))
          .style('display', null);

        // Build compact tooltip rows — one per pitch angle. For fine steps,
        // only the 5° pitches plus the curve nearest the cursor (in bold).
        let shown   = data.series;
        let nearest = null;
        if (finePitch) {
          const yVal = yScale.invert(my);
          nearest = d3.least(data.series, s => Math.abs(s.temperatures[idx] - yVal)).pitch;
          shown = data.series.filter(s => (s.pitch - 45) % 5 === 0 || s.pitch === nearest);
        }
        const rows = shown.map(s => {
          const temp  = s.temperatures[idx].toFixed(2);
          const color = pitchColor(s.pitch);
          return `<tr${s.pitch === nearest ? ' class="tt-nearest"' : ''}>
            <td><span class="tt-swatch" style="background:${color}"></span>${s.pitch}°</td>
            <td class="tt-temp">${temp}</td>
          </tr>`;
        }).join('');

        // Place tooltip right of cursor; flip left if it would overflow
        const ttLeft = (mx + margin.left + 14 + 160 > totalWidth)
          ? mx + margin.left - 166
          : mx + margin.left + 14;

        // Pin tooltip at chart top; auto-scroll via mouse Y (pointer-events:none prevents
        // the user from reaching the scrollbar directly).
        tooltip
          .style('display', 'block')
          .style('left',    `${ttLeft}px`)
          .style('top',     `${margin.top}px`)
          .html(`
            <div class="tt-header">${t.toFixed(1)} ks</div>
            <table class="tt-table">
              <thead><tr><th>Pitch</th><th>${data.meta.units}</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          `);
        // Scroll proportional to vertical mouse position within the plot area.
        const ttEl    = tooltip.node();
        const maxScroll = Math.max(0, ttEl.scrollHeight - ttEl.clientHeight);
        ttEl.scrollTop  = (my / h) * maxScroll;
      })
      .on('mouseleave', function () {
        crosshair.style('display', 'none');
        tooltip.style('display', 'none');
      });

    // ── Pitch color legend ────────────────────────────────────────────────
    const legX      = w + 10;
    const headerGap = 10;   // padding between title and first row

    if (finePitch) {
      drawColorBar();
    } else {
      drawSwatches();
    }

    // Categorical swatches: one row per pitch in the data, single column at
    // 9px font (28 rows × 14 px = 392 px at the default 5° step).
    function drawSwatches() {
      const swSize = 8;    // swatch width & height in px
      const rowH   = 14;   // row pitch (px)
      const legH   = pitches.length * rowH;
      const legY   = (h - legH) / 2 + headerGap;

      // "Pitch°" header
      g.append('text')
        .attr('x', legX + 20).attr('y', legY - 12)
        .attr('text-anchor', 'middle')
        .attr('font-size', '14px').attr('fill', '#555')
        .text('Pitch°');

      pitches.forEach((pitch, i) => {
        const row = i;
        const px  = legX;
        const py  = legY + row * rowH;

        g.append('rect')
          .attr('x', px).attr('y', py - swSize + 1)
          .attr('width', swSize).attr('height', swSize)
          .attr('fill', pitchColor(pitch));

        g.append('text')
          .attr('x', px + swSize + 3).attr('y', py)
          .attr('font-size', '9px').attr('fill', '#444')
          .text(`${pitch}°`);
      });
    }

    // Continuous color bar for fine steps: 45° at the top (matching the
    // swatch order), labelled every 15°. Same height as the 5° swatch legend.
    function drawColorBar() {
      const barW = 12;
      const barH = 392;
      const barY = (h - barH) / 2 + headerGap;
      const gradId = `pitch-gradient-${++colorBarCount}`;

      const grad = svg.append('defs').append('linearGradient')
        .attr('id', gradId)
        .attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
      d3.range(0, 1.0001, 0.1).forEach(f => {
        grad.append('stop')
          .attr('offset', f)
          .attr('stop-color', pitchColor(45 + f * 135));
      });

      g.append('text')
        .attr('x', legX + 20).attr('y', barY - 12)
        .attr('text-anchor', 'middle')
        .attr('font-size', '14px').attr('fill', '#555')
        .text('Pitch°');

      const bar = g.append('g').attr('class', 'pitch-colorbar');
      bar.append('rect')
        .attr('x', legX).attr('y', barY)
        .attr('width', barW).attr('height', barH)
        .attr('fill', `url(#${gradId})`);

      d3.range(45, 181, 15).forEach(pitch => {
        const py = barY + (pitch - 45) / 135 * barH;
        bar.append('line')
          .attr('x1', legX + barW).attr('x2', legX + barW + 3)
          .attr('y1', py).attr('y2', py)
          .attr('stroke', '#444');
        bar.append('text')
          .attr('x', legX + barW + 5).attr('y', py)
          .attr('dominant-baseline', 'middle')
          .attr('font-size', '9px').attr('fill', '#444')
          .text(`${pitch}°`);
      });
    }
  }

  // Gradient ids must be unique in the document; charts can be re-rendered.
  let colorBarCount = 0;

  // ─── Summary table renderer ───────────────────────────────────────────────

  /**
   * Parse a CSV text string and render a Bootstrap table into container.
   *
   * The summary table CSV has a pitch-angle index column and Chandra DOY date
   * columns (YYYY:ddd format — see SCHEMA.md §1.1 and Phase 4 note 4).
   *
   * @param {HTMLElement} container
   * @param {string}      csvText
   */
  function renderSummaryTable(container, csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      container.innerHTML = '<p class="text-muted small">No table data available.</p>';
      return;
    }

    const headers = lines[0].split(',').map(h => h.trim());
    // Finer pitch steps give more than 28 rows (136 at 1°): cap the height
    // and keep the header row visible while scrolling.
    const tall    = lines.length - 1 > 28;
    const parts   = [tall
      ? '<div class="table-responsive summary-scroll" style="max-height:600px;overflow-y:auto"><table class="table table-sm table-striped table-hover small mb-0">'
      : '<div class="table-responsive"><table class="table table-sm table-striped table-hover small mb-0">'];

    parts.push(tall
      ? '<thead class="table-dark" style="position:sticky;top:0;z-index:1"><tr>'
      : '<thead class="table-dark"><tr>');
    headers.forEach(h => parts.push(`<th scope="col">${h}</th>`));
    parts.push('</tr></thead><tbody>');

    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',');
      parts.push('<tr>');
      cells.forEach((c, ci) => {
        const tag = ci === 0 ? 'th scope="row"' : 'td';
        let val = c.trim();
        if (ci > 0) {
          const n = parseFloat(val);
          if (isFinite(n)) val = n.toFixed(2);  // CSV values have 2 decimals (TEMP_DECIMALS)
        }
        parts.push(`<${tag}>${val}</${tag.split(' ')[0]}>`);
      });
      parts.push('</tr>');
    }
    parts.push('</tbody></table></div>');
    container.innerHTML = parts.join('');
  }

  // ─── Settling-temperature lookahead: pure helpers ─────────────────────────
  //
  // Data contract (SCHEMA.md §3.4): metadata.configs[<id>].lookahead holds all
  // static data — limits (ascending), regimes (fill, pattern, label; regime k
  // spans [limits[k-1], limits[k])), headline, y_range, annotations — resolved
  // in Python from lookahead.yaml. The curves come from the summary table CSV
  // (rows = pitch, columns 'YYYY:ddd'): one column per year at the selected day
  // of year. Ported from the original steady_state_temperature_lookahead
  // render.py; comments there explain the label and range rules.

  const UNIT_SYMBOL = { Celsius: '°C', Fahrenheit: '°F' };

  function unitSymbol(units) {
    return UNIT_SYMBOL[units] || units;
  }

  /** The block for configs that have none (web roots written before 2026-10-20). */
  function defaultLookahead(metadata) {
    return {
      configured: false, subject: metadata.display_name, config_text: null,
      units_symbol: unitSymbol(metadata.units), limits: [], regimes: [], headline: null,
      years: null, y_range: null, nodes: null, line_width: 1.6, band_opacity: 0.1,
      annotations: [],
    };
  }

  function getLookahead(metadata, configId) {
    const cfg = metadata && metadata.configs && metadata.configs[configId];
    return (cfg && cfg.lookahead) || defaultLookahead(metadata);
  }

  /** '2026091' or '2026:091' -> '091'. */
  function dateDoy(dateKey) {
    return String(dateKey).replace(':', '').slice(4, 7);
  }

  /**
   * One curve per year at day of year `doy` from the summary table CSV.
   * Years lacking that day are left out (the default range ends at 2032:001).
   * @returns {{pitch: number[], years: number[], temps: number[][]}}
   */
  function selectLookaheadColumns(csvText, doy, years) {
    const lines  = csvText.trim().split('\n');
    const header = lines[0].split(',').map(h => h.trim());
    const cols   = [];
    header.forEach((h, i) => {
      const m = /^(\d{4}):(\d{3})$/.exec(h);
      if (i === 0 || !m || m[2] !== doy) return;
      const year = parseInt(m[1], 10);
      if (!years || (year >= years[0] && year <= years[1])) cols.push({ i, year });
    });
    cols.sort((a, b) => a.year - b.year);
    const pitch = [];
    const temps = cols.map(() => []);
    for (let r = 1; r < lines.length; r++) {
      const cells = lines[r].split(',');
      const p = parseFloat(cells[0]);
      if (!Number.isFinite(p)) continue;
      pitch.push(p);
      cols.forEach((c, k) => {
        const v = parseFloat(cells[c.i]);
        temps[k].push(Number.isFinite(v) ? v : NaN);
      });
    }
    return { pitch, years: cols.map(c => c.year), temps };
  }

  /**
   * Regime of temperature t: the number of limits at or below it, so a value
   * exactly on a threshold belongs to the hotter regime (upper limits are
   * violated at T >= value, lower limits at T < value). NaN -> null.
   */
  function regimeIndex(t, limits) {
    if (!Number.isFinite(t)) return null;
    let r = 0;
    limits.forEach(l => { if (t >= l.value) r += 1; });
    return r;
  }

  /**
   * Pitch intervals where temp >= limit (temp > limit if not inclusive), with
   * endpoints linearly interpolated. NaN samples count as not exceeding and are
   * never interpolated across.
   */
  function exceedanceIntervals(pitch, temp, limit, inclusive = true) {
    const n = pitch.length;
    const above = temp.map(v => Number.isFinite(v) && (inclusive ? v >= limit : v > limit));
    const cross = i => {   // crossing between samples i-1 and i
      const a = temp[i - 1], b = temp[i];
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
        return pitch[i - 1] + (limit - a) / (b - a) * (pitch[i] - pitch[i - 1]);
      }
      return above[i] ? pitch[i] : pitch[i - 1];
    };
    const out = [];
    let start = null;
    for (let i = 0; i < n; i++) {
      if (above[i] && start === null) start = i === 0 ? pitch[0] : cross(i);
      if (start !== null && (!above[i] || i === n - 1)) {
        out.push([start, above[i] ? pitch[i] : cross(i)]);
        start = null;
      }
    }
    return out;
  }

  /** Pitch intervals violating a limit, respecting its side. */
  function violationIntervals(pitch, temp, limit) {
    if (limit.side === 'upper') return exceedanceIntervals(pitch, temp, limit.value, true);
    // lower: violated at temp < value  <=>  -temp > -value
    return exceedanceIntervals(pitch, temp.map(v => -v), -limit.value, false);
  }

  /** "121–180°, 45–60°"; a range whose ends round equal prints once ("175°"). */
  function formatRanges(ivals) {
    if (!ivals.length) return 'none';
    return ivals.map(([a, b]) => {
      const ra = a.toFixed(0), rb = b.toFixed(0);
      return ra === rb ? `${ra}°` : `${ra}–${rb}°`;
    }).join(', ');
  }

  /**
   * "Hottest attitude (170°) warms ≈ 2.5 °C per year." The worst-case pitch of
   * the last year in the headline's direction (coldest for a lower headline),
   * and its change per year between the first and last year. '' for one year.
   */
  function trendText(pitch, years, temps, headline, unitsSym) {
    if (years.length < 2) return '';
    const first = temps[0], last = temps[temps.length - 1];
    const coldest = !!headline && headline.side === 'lower';
    let j = -1;
    last.forEach((v, i) => {
      if (Number.isFinite(v) && (j < 0 || (coldest ? v < last[j] : v > last[j]))) j = i;
    });
    if (j < 0 || !Number.isFinite(first[j])) return '';
    const rate  = (last[j] - first[j]) / (years[years.length - 1] - years[0]);
    const trend = rate > 0.05 ? `warms ≈ ${rate.toFixed(1)}`
                : rate < -0.05 ? `cools ≈ ${(-rate).toFixed(1)}`
                : 'changes < 0.1';
    return `${coldest ? 'Coldest' : 'Hottest'} attitude (${pitch[j].toFixed(0)}°) ${trend} ${unitsSym} per year.`;
  }

  /**
   * Pitch for the year labels: where adjacent curves are farthest apart,
   * avoiding the outer 5% of the range and pitches where a curve is missing;
   * with nodes, prefer segment midpoints (snapped to the grid) to avoid kinks.
   */
  function labelPitch(pitch, temps, nodes) {
    const n = pitch.length;
    const gap = pitch.map((_, i) => {
      const col = temps.map(row => row[i]);
      if (col.some(v => !Number.isFinite(v))) return -Infinity;
      if (col.length < 2) return 0;
      const s = col.slice().sort((a, b) => a - b);
      let g = Infinity;
      for (let k = 1; k < s.length; k++) g = Math.min(g, s[k] - s[k - 1]);
      return g;
    });
    const span = pitch[n - 1] - pitch[0];
    let ok = pitch.map(p => p > pitch[0] + 0.05 * span && p < pitch[n - 1] - 0.05 * span);
    if (nodes && nodes.length > 1) {
      const snapped = new Array(n).fill(false);
      for (let k = 1; k < nodes.length; k++) {
        const mid = (nodes[k - 1] + nodes[k]) / 2;
        let best = 0;
        pitch.forEach((p, i) => { if (Math.abs(p - mid) < Math.abs(pitch[best] - mid)) best = i; });
        snapped[best] = true;
      }
      const both = ok.map((v, i) => v && snapped[i]);
      if (both.some(Boolean)) ok = both;
    }
    if (!ok.some(Boolean)) ok = ok.map(() => true);
    let bestI = -1;
    ok.forEach((v, i) => { if (v && (bestI < 0 || gap[i] > gap[bestI])) bestI = i; });
    return pitch[bestI];
  }

  /** Indices of labels to draw so none are closer than minGap px; mustKeep always drawn. */
  function thinLabels(ypx, mustKeep, minGap) {
    const kept = mustKeep.filter(i => Number.isFinite(ypx[i]));
    const key = i => (Number.isFinite(ypx[i]) ? ypx[i] : Infinity);
    const order = ypx.map((_, i) => i).sort((a, b) => key(a) - key(b));
    for (const i of order) {
      if (kept.includes(i) || !Number.isFinite(ypx[i])) continue;
      if (kept.every(j => Math.abs(ypx[i] - ypx[j]) >= minGap)) kept.push(i);
    }
    return new Set(kept);
  }

  /** 1-D label repulsion: keep order, enforce min spacing, stay centred on targets. */
  function spreadLabels(desired, minGap) {
    const order = desired.map((_, i) => i).sort((a, b) => desired[a] - desired[b]);
    const d = order.map(i => desired[i]);
    const p = d.slice();
    for (let it = 0; it < 50; it++) {
      for (let i = 1; i < p.length; i++) p[i] = Math.max(p[i], p[i - 1] + minGap);
      const shift = d.reduce((s, v, i) => s + v - p[i], 0) / (p.length || 1);
      for (let i = 0; i < p.length; i++) p[i] += shift;
    }
    const out = new Array(p.length);
    order.forEach((idx, k) => { out[idx] = p[k]; });
    return out;
  }

  /** Top-panel y domain: data ± 6%, extended to limits within 15% of the range, or y_range. */
  function lookaheadYDomain(temps, limits, yRange) {
    if (yRange) return [yRange[0], yRange[1]];
    const all = temps.flat().filter(Number.isFinite);
    const lo = d3.min(all), hi = d3.max(all);
    const rng = Math.max(hi - lo, 1e-6), pad = 0.06 * rng;
    let a = lo - pad, b = hi + pad;
    limits.forEach(l => {
      if (a - 0.15 * rng < l.value && l.value < a) a = l.value - pad;
      if (b < l.value && l.value < b + 0.15 * rng) b = l.value + pad;
    });
    return [a, b];
  }

  function lookaheadTitle(block, years, doy) {
    let span = '';
    if (years.length) {
      const a = years[0], b = years[years.length - 1];
      span = a === b ? `${a}` : `${a}–${b}`;
    }
    let t = doy === '001'
      ? `${block.subject} Perihelion Settling Temperatures${span ? ' ' + span : ''}`
      : `${block.subject} Settling Temperatures, Day ${doy}${span ? ', ' + span : ''}`;
    if (block.config_text) t += `, ${block.config_text}`;
    return t;
  }

  function lookaheadDescription(doy) {
    return doy === '001'
      ? 'Steady-state temperature if held at each pitch at perihelion.'
      : `Steady-state temperature if held at each pitch on day ${doy}.`;
  }

  /** Curves for one config and day of year, from the cached summary table. */
  async function loadLookaheadData(tableCsvPath, dateKey, block) {
    const csvText = await loadTableCsv(tableCsvPath);
    return selectLookaheadColumns(csvText, dateDoy(dateKey), block ? block.years : null);
  }

  // ─── Settling-temperature lookahead: D3 renderer ──────────────────────────
  //
  // Two panels, matching the original Plotly figure (render.py):
  //   top   – one curve per year (blue ramp, newest darkest; first and last
  //           wider) over faint regime bands, dashed limit lines (dash-dot for
  //           safety) labelled in the right margin, optional annotations.
  //   strip – one bar per year coloured by regime, earliest year at the
  //           bottom and latest at the top so the bars stack like the curves
  //           (owner, 2026-10-19; the original had the earliest at the top).
  // A legend of regimes sits between them. Every visual property is an SVG
  // attribute and the hatch patterns live in this SVG's own <defs>, so the
  // <svg> can later be serialised for export without page CSS (spec §6.6).
  // Class names are hooks for tests and hover only; no CSS targets them.

  const LK_FONT  = 'Arial, sans-serif';
  const LK_INK   = '#1F2933';
  const LK_MUTED = '#6B7785';
  const LK_GRID  = '#E4E7EB';
  const LK_FRAME = '#C9CED4';
  const LK_RAMP  = ['#4A86C0', '#08306B'];   // keeps >= 3:1 contrast on every band tint
  const LK_TOP_H = 420;                      // top panel height (px)
  const LK_ROW_H = 22;                       // strip row pitch (px)
  const LK_CHAR_W = 6.6;                     // average glyph width at 12px Arial
  let lookaheadCount = 0;                    // unique <defs> ids across re-renders

  // White hatching at the original's density (Plotly pattern size 7, solidity 0.2).
  function addHatch(defs, id, fill, shape) {
    const s = 7;
    const p = defs.append('pattern')
      .attr('id', id).attr('class', 'lk-hatch').attr('data-shape', shape)
      .attr('patternUnits', 'userSpaceOnUse').attr('width', s).attr('height', s);
    p.append('rect').attr('width', s).attr('height', s).attr('fill', fill);
    const stroke = path => p.append('path').attr('d', path)
      .attr('stroke', 'white').attr('stroke-width', 1.4).attr('fill', 'none');
    if (shape === '/' || shape === 'x') {
      stroke(`M0,${s} L${s},0 M${-s / 2},${s / 2} L${s / 2},${-s / 2} M${s / 2},${1.5 * s} L${1.5 * s},${s / 2}`);
    }
    if (shape === 'x') {
      stroke(`M0,0 L${s},${s} M${-s / 2},${s / 2} L${s / 2},${1.5 * s} M${s / 2},${-s / 2} L${1.5 * s},${s / 2}`);
    }
    if (shape === '.') {
      p.append('circle').attr('cx', s / 2).attr('cy', s / 2).attr('r', 1.3).attr('fill', 'white');
    }
  }

  const LK_MIN_FONT = 9;                     // smallest margin text before truncating

  // Fit margin text into `avail` px. A limit tag that is too long wraps
  // before its "(value)"; any line that still does not fit shrinks, down to
  // LK_MIN_FONT, and past that is cut with "…" (the full text goes in a
  // <title>). Widths are estimated from LK_CHAR_W, so `avail` keeps a margin.
  function fitMarginText(text, avail, wrap) {
    const width = (s, size) => s.length * LK_CHAR_W * size / 12;
    let lines = [text];
    const cut = text.lastIndexOf(' (');
    if (wrap && width(text, 12) > avail && cut > 0) {
      lines = [text.slice(0, cut + 1), text.slice(cut + 1)];
    }
    const longest = Math.max(...lines.map(s => width(s, 12)));
    const size = Math.max(LK_MIN_FONT, Math.min(12, Math.floor(120 * avail / longest) / 10));
    const maxChars = Math.floor(avail / width('x', size));
    let truncated = false;
    lines = lines.map(s => {
      if (s.length <= maxChars) return s;
      truncated = true;
      let n = Math.max(1, maxChars - 1);
      const comma = s.lastIndexOf(', ', n);   // range lists: cut between intervals
      if (comma > 0) n = comma + 1;
      return s.slice(0, n).trimEnd() + '…';
    });
    return { lines, size, truncated };
  }

  // Append margin text built by fitMarginText, centred vertically on y.
  function appendMarginText(parent, text, x, y, avail, wrap) {
    const f = fitMarginText(text, avail, wrap);
    const t = parent.append('text').attr('x', x).attr('y', y)
      .attr('dominant-baseline', 'middle').attr('font-size', f.size);
    const lh = f.size * 1.15;
    f.lines.forEach((s, k) => t.append('tspan').attr('x', x)
      .attr('y', y + (k - (f.lines.length - 1) / 2) * lh)
      .attr('dominant-baseline', 'middle').text(s));
    if (f.truncated) t.append('title').text(text);
    return t;
  }

  // Tooltip cells are built as HTML; YAML labels may contain "<" or "&".
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // d3.axis writes font-size/font-family/fill on the group and uses
  // currentColor; replace with explicit attributes for export.
  function styleLookaheadAxis(sel) {
    sel.attr('font-family', LK_FONT).attr('font-size', 12);
    sel.selectAll('text').attr('fill', LK_INK);
    sel.selectAll('line, path').attr('stroke', LK_MUTED);
  }

  /**
   * @param {HTMLElement} container
   * @param {{pitch:number[], years:number[], temps:number[][]}} data  selectLookaheadColumns()
   * @param {Object} block   metadata lookahead block (SCHEMA.md §3.4)
   * @param {{doy:string, title?:string}} opts
   */
  function renderLookaheadChart(container, data, block, opts) {
    d3.select(container).selectAll('*').remove();

    const { pitch, years, temps } = data;
    const nY = years.length;
    const uid = `lk${++lookaheadCount}`;
    const sym = block.units_symbol;
    const configured = !!block.configured && block.regimes.length > 0;
    const limits  = configured ? block.limits : [];
    const regimes = configured ? block.regimes : [];
    const head    = configured ? block.headline : null;
    const headRanges = head ? temps.map(row => formatRanges(violationIntervals(pitch, row, head))) : [];

    // ── Geometry ────────────────────────────────────────────────────────────
    const totalWidth = Math.max(container.clientWidth || 700, 320);
    const marginTexts = [...limits.map(l => l.tag), ...headRanges, head ? head.text : ''];
    const longest = Math.max(0, ...marginTexts.map(s => s.length));
    const margin = {
      top: 10, bottom: 44, left: 62,
      // right margin holds limit labels and strip ranges; capped for phones
      right: Math.min(Math.max(90, Math.round(longest * LK_CHAR_W) + 28),
                      Math.round(totalWidth * 0.4)),
    };
    const w = totalWidth - margin.left - margin.right;

    // Legend items wrap left to right like Plotly's horizontal legend.
    const legend = regimes.map((r, k) => ({ ...r, k, width: 22 + r.label.length * LK_CHAR_W + 18 }));
    let lrow = 0, used = 0;
    legend.forEach(it => {
      if (used + it.width > w && used > 0) { lrow += 1; used = 0; }
      it.row = lrow; it.x = used; used += it.width;
    });
    const legendRows = legend.length ? lrow + 1 : 0;
    const legendY = LK_TOP_H + 30;                        // below the top panel's ticks
    const stripY0 = legendY + legendRows * 20 + 24;       // room for the margin heading
    const stripH  = configured ? nY * LK_ROW_H : 0;
    const axisY   = configured ? stripY0 + stripH : LK_TOP_H;
    const totalHeight = margin.top + axisY + margin.bottom;

    const svg = d3.select(container).append('svg')
      .attr('xmlns', 'http://www.w3.org/2000/svg')
      .attr('width', totalWidth).attr('height', totalHeight)
      .attr('font-family', LK_FONT).attr('font-size', 12).attr('fill', LK_INK)
      .attr('role', 'img')
      .attr('aria-label', opts.title || 'Settling temperature lookahead');
    const defs = svg.append('defs');
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // ── Scales ──────────────────────────────────────────────────────────────
    const x = d3.scaleLinear().domain([pitch[0], pitch[pitch.length - 1]]).range([0, w]);
    const [ymin, ymax] = lookaheadYDomain(temps, limits, block.y_range);
    const y = d3.scaleLinear().domain([ymin, ymax]).range([LK_TOP_H, 0]);
    const xTicks = d3.range(Math.ceil(pitch[0] / 15) * 15, pitch[pitch.length - 1] + 1e-9, 15);
    const ramp = d3.interpolateRgb(LK_RAMP[0], LK_RAMP[1]);
    const curveColor = i => ramp(nY > 1 ? i / (nY - 1) : 0);
    const baseWidth  = i => block.line_width * ((i === 0 || i === nY - 1) ? 1.6 : 1);
    const patId = k => `${uid}-pat-${k}`;
    const cellFill = k => (regimes[k].pattern ? `url(#${patId(k)})` : regimes[k].fill);
    regimes.forEach((r, k) => { if (r.pattern) addHatch(defs, patId(k), r.fill, r.pattern); });

    // ── Top panel ───────────────────────────────────────────────────────────
    defs.append('clipPath').attr('id', `${uid}-clip`)
      .append('rect').attr('width', w).attr('height', LK_TOP_H);
    const top  = g.append('g');
    const plot = top.append('g').attr('clip-path', `url(#${uid}-clip)`);

    regimes.forEach((r, k) => {             // faint regime bands behind the curves
      const lo = r.lo === null ? ymin : Math.max(r.lo, ymin);
      const hi = r.hi === null ? ymax : Math.min(r.hi, ymax);
      if (hi > lo) {
        plot.append('rect').attr('class', 'lk-band').attr('data-regime', k)
          .attr('x', 0).attr('width', w).attr('y', y(hi)).attr('height', y(lo) - y(hi))
          .attr('fill', r.fill).attr('fill-opacity', block.band_opacity);
      }
    });
    xTicks.forEach(t => plot.append('line').attr('x1', x(t)).attr('x2', x(t))
      .attr('y1', 0).attr('y2', LK_TOP_H).attr('stroke', LK_GRID));
    y.ticks(8).forEach(t => plot.append('line').attr('x1', 0).attr('x2', w)
      .attr('y1', y(t)).attr('y2', y(t)).attr('stroke', LK_GRID));

    const line = d3.line().defined(Number.isFinite)
      .x((_, i) => x(pitch[i])).y(v => y(v));
    const curves = temps.map((row, i) => plot.append('path')
      .attr('class', 'lk-curve').attr('data-year', years[i])
      .attr('fill', 'none').attr('stroke', curveColor(i))
      .attr('stroke-width', baseWidth(i)).attr('d', line(row)));

    if (block.nodes) {
      temps.forEach((row, i) => block.nodes.forEach(nd => {
        const j = pitch.findIndex(p => Math.abs(p - nd) < 1e-9);
        if (j >= 0 && Number.isFinite(row[j])) {
          plot.append('circle').attr('cx', x(pitch[j])).attr('cy', y(row[j]))
            .attr('r', 2.5).attr('fill', curveColor(i));
        }
      }));
    }

    // Limit lines and their margin labels (spread so they never overlap).
    const shown = limits.filter(l => l.value >= ymin && l.value <= ymax);
    const targets = shown.map(l => y(l.value));
    const labelAvail = margin.right - 15 - 4;
    const wrapped = shown.some(l => fitMarginText(l.tag, labelAvail, true).lines.length > 1);
    const placed = spreadLabels(targets, wrapped ? 28 : 16);
    shown.forEach((l, k) => {
      const safety = l.kind === 'safety';
      top.append('line').attr('class', 'lk-limit').attr('data-value', l.value)
        .attr('x1', 0).attr('x2', w).attr('y1', targets[k]).attr('y2', targets[k])
        .attr('stroke', l.line_color).attr('stroke-width', safety ? 2.4 : 1.6)
        .attr('stroke-dasharray', safety ? '9 3 2 3' : '6 4');
      top.append('line').attr('x1', w).attr('x2', w + 12)
        .attr('y1', targets[k]).attr('y2', placed[k])
        .attr('stroke', l.line_color).attr('stroke-width', 1);
      appendMarginText(top, l.tag, w + 15, placed[k], labelAvail, true)
        .attr('class', 'lk-limit-label').attr('fill', l.line_color);
    });

    // Year labels where the curves are farthest apart; first and last always.
    const lx = labelPitch(pitch, temps, block.nodes);
    const li = pitch.indexOf(lx);
    const ypx = temps.map(row => (Number.isFinite(row[li]) ? y(row[li]) : NaN));
    const showLabel = thinLabels(ypx, [0, nY - 1], 15);
    temps.forEach((_, i) => {
      if (!showLabel.has(i)) return;
      top.append('text').attr('class', 'lk-year-label').attr('data-year', years[i])
        .attr('x', x(lx)).attr('y', ypx[i])
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('font-size', 12).attr('font-weight', (i === 0 || i === nY - 1) ? 'bold' : 'normal')
        .attr('fill', curveColor(i))
        .attr('stroke', 'white').attr('stroke-width', 3).attr('stroke-opacity', 0.9)
        .attr('paint-order', 'stroke')
        .text(years[i]);
    });

    // Annotations describe perihelion data, so only day 001 shows them (D5).
    if (opts.doy === '001' && (block.annotations || []).length) {
      defs.append('marker').attr('id', `${uid}-arrow`)
        .attr('viewBox', '0 0 8 8').attr('refX', 7).attr('refY', 4)
        .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto')
        .append('path').attr('d', 'M0,0 L8,4 L0,8 z').attr('fill', LK_INK);
      block.annotations.forEach(a => {
        const lines = a.text.split(/<br\s*\/?>/i);
        const tx = x(a.at[0]), ty = y(a.at[1]);
        const bw = Math.max(...lines.map(s => s.length)) * 6.4 + 12;
        const bh = lines.length * 15 + 8;
        const ga = top.append('g').attr('class', 'lk-annotation');
        if (a.point_to) {
          const ptr = ga.append('line').attr('x1', tx).attr('y1', ty)
            .attr('x2', x(a.point_to[0])).attr('y2', y(a.point_to[1]))
            .attr('stroke', LK_INK).attr('stroke-width', 1.2);
          if (a.pointer === 'arrow') ptr.attr('marker-end', `url(#${uid}-arrow)`);
        }
        ga.append('rect').attr('x', tx - bw / 2).attr('y', ty - bh / 2)
          .attr('width', bw).attr('height', bh).attr('rx', 3)
          .attr('fill', 'white').attr('fill-opacity', 0.88).attr('stroke', LK_FRAME);
        const txt = ga.append('text').attr('font-size', 12).attr('fill', LK_INK);
        lines.forEach((s, k) => txt.append('tspan')
          .attr('x', tx - bw / 2 + 6).attr('y', ty - bh / 2 + 15 + k * 15).text(s));
      });
    }

    styleLookaheadAxis(top.append('g').call(d3.axisLeft(y).ticks(8)));
    styleLookaheadAxis(top.append('g').attr('transform', `translate(0,${LK_TOP_H})`)
      .call(d3.axisBottom(x).tickValues(xTicks).tickFormat(configured ? '' : d => `${d}°`)));
    top.append('text').attr('transform', 'rotate(-90)')
      .attr('x', -LK_TOP_H / 2).attr('y', -46).attr('text-anchor', 'middle')
      .attr('font-size', 13).attr('fill', LK_INK)
      .text(`Settling temperature (${sym})`);

    // ── Legend ──────────────────────────────────────────────────────────────
    const lg = g.append('g').attr('transform', `translate(0,${legendY})`);
    legend.forEach(it => {
      const gi = lg.append('g').attr('class', 'lk-legend-item').attr('data-regime', it.k)
        .attr('transform', `translate(${it.x},${it.row * 20})`);
      gi.append('rect').attr('y', -7).attr('width', 14).attr('height', 14)
        .attr('fill', cellFill(it.k)).attr('stroke', LK_FRAME);
      gi.append('text').attr('x', 20).attr('dominant-baseline', 'middle')
        .attr('font-size', 12).attr('fill', LK_INK).text(it.label);
    });

    // ── Regime strip ────────────────────────────────────────────────────────
    if (configured) {
      const strip = g.append('g').attr('transform', `translate(0,${stripY0})`);
      // Cell edges halfway between samples, so each pitch owns its neighbourhood.
      const edges = [pitch[0], ...pitch.slice(1).map((p, i) => (pitch[i] + p) / 2),
                     pitch[pitch.length - 1]];
      const barH = LK_ROW_H - 4;
      temps.forEach((row, i) => {
        // Earliest year at the bottom, latest at the top (D11).
        const rowTop = (nY - 1 - i) * LK_ROW_H + 2;
        const gr = strip.append('g').attr('class', 'lk-strip-row').attr('data-year', years[i])
          .attr('transform', `translate(0,${rowTop})`);
        const reg = row.map(v => regimeIndex(v, limits));
        let a = 0;
        for (let b = 1; b <= reg.length; b++) {
          if (b < reg.length && reg[b] === reg[a]) continue;
          const r = reg[a];
          const x0 = x(edges[a]), x1 = x(edges[b]);
          gr.append('rect').attr('class', 'lk-cell').attr('data-regime', r === null ? '' : r)
            .attr('x', x0).attr('width', x1 - x0).attr('height', barH)
            .attr('fill', r === null ? 'white' : cellFill(r));
          if (a > 0) {                       // white separator between runs
            gr.append('line').attr('x1', x0).attr('x2', x0).attr('y1', -2).attr('y2', barH + 2)
              .attr('stroke', 'white').attr('stroke-width', 2);
          }
          a = b;
        }
        // Outline: "within limits" cells can be pale, so keep each row a visible bar.
        gr.append('rect').attr('width', w).attr('height', barH)
          .attr('fill', 'none').attr('stroke', LK_FRAME);
        gr.append('text').attr('x', -6).attr('y', barH / 2)
          .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
          .attr('font-size', 12).attr('fill', LK_INK).text(years[i]);
        if (head) {
          appendMarginText(gr, headRanges[i], w + 8, barH / 2, margin.right - 8 - 4, false)
            .attr('class', 'lk-range').attr('fill', LK_MUTED);
        }
      });
      if (head) {
        appendMarginText(strip, head.text, w + 8, -10, margin.right - 8 - 4, false)
          .attr('font-weight', 'bold').attr('fill', LK_MUTED);
      }
      styleLookaheadAxis(g.append('g').attr('transform', `translate(0,${axisY})`)
        .call(d3.axisBottom(x).tickValues(xTicks).tickFormat(d => `${d}°`)));
    }
    g.append('text').attr('x', w / 2).attr('y', axisY + 36).attr('text-anchor', 'middle')
      .attr('font-size', 13).attr('fill', LK_INK).text('Pitch (deg)');

    // ── Hover: crosshair across both panels, tooltip per year ───────────────
    const crosshair = g.append('line').attr('y1', 0).attr('y2', axisY)
      .attr('stroke', '#9ca3af').attr('stroke-width', 1).attr('stroke-dasharray', '4 3')
      .attr('display', 'none');
    const tooltip = d3.select(container).append('div')
      .attr('class', 'dwell-tooltip').style('display', 'none');
    const bisect = d3.bisector(p => p).center;
    g.append('rect').attr('class', 'lk-overlay')
      .attr('width', w).attr('height', axisY)
      .attr('fill', 'none').attr('pointer-events', 'all')
      .on('mousemove', event => {
        const [mx, my] = d3.pointer(event);
        const idx = Math.max(0, Math.min(pitch.length - 1, bisect(pitch, x.invert(mx))));
        const px = x(pitch[idx]);
        crosshair.attr('x1', px).attr('x2', px).attr('display', null);
        // Over a strip row: emphasise that year's curve.
        let hot = -1;
        if (configured && my >= stripY0 && my < stripY0 + stripH) {
          hot = nY - 1 - Math.floor((my - stripY0) / LK_ROW_H);
        }
        curves.forEach((c, i) => c.attr('stroke-width', baseWidth(i) * (i === hot ? 2 : 1)));
        const rows = temps.map((row, i) => {
          const v = row[idx];
          const r = regimeIndex(v, limits);
          const label = configured && r !== null ? escapeHtml(regimes[r].label) : '';
          return `<tr${i === hot ? ' class="tt-nearest"' : ''}>
            <td><span class="tt-swatch" style="background:${curveColor(i)}"></span>${years[i]}</td>
            <td class="tt-temp">${Number.isFinite(v) ? v.toFixed(2) : '—'}</td>
            <td>${label}</td></tr>`;
        }).reverse().join('');                // newest first, as the strip reads top-down
        const left = mx + margin.left + 14 + 260 > totalWidth ? mx + margin.left - 274 : mx + margin.left + 14;
        tooltip.style('display', 'block').style('left', `${Math.max(0, left)}px`)
          .style('top', `${margin.top}px`)
          .html(`<div class="tt-header">${pitch[idx]}°</div>
            <table class="tt-table"><thead><tr><th>Year</th><th>${escapeHtml(sym)}</th><th>${configured ? 'Regime' : ''}</th></tr></thead>
            <tbody>${rows}</tbody></table>`);
      })
      .on('mouseleave', () => {
        crosshair.attr('display', 'none');
        tooltip.style('display', 'none');
        curves.forEach((c, i) => c.attr('stroke-width', baseWidth(i)));
      });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  global.App = {
    // Pure / testable helpers
    parseManifest,
    resolveConfigId,
    buildControlsHTML,
    buildDateSelectorHTML,
    getChartCacheKey,
    getDatesForConfig,
    getFileRef,
    getPitchStep,
    getResolutionOptions,
    resolveDisplayStep,
    buildResolutionToggleHTML,
    filterChartByStep,
    filterTableCsvByStep,
    parseJsonBytes,
    unitSymbol,
    defaultLookahead,
    getLookahead,
    dateDoy,
    selectLookaheadColumns,
    regimeIndex,
    exceedanceIntervals,
    violationIntervals,
    formatRanges,
    trendText,
    labelPitch,
    thinLabels,
    spreadLabels,
    lookaheadYDomain,
    lookaheadTitle,
    lookaheadDescription,
    // Cache (exposed so tests can inspect and reset it)
    _cache,
    // Async data loaders
    loadManifest,
    loadMetadata,
    loadChartData,
    loadTableCsv,
    loadLookaheadData,
    // Renderers
    renderDwellChart,
    renderSummaryTable,
    renderLookaheadChart,
  };

}(window));
