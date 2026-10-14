/**
 * app.js — Xija Steady States website application logic
 *
 * Exported as a global App object so QUnit tests in tests.html can import
 * these functions without a module bundler.
 *
 * Schema contract (SCHEMA.md):
 *   manifest.json  → array of NavEntry {nav_id, display_name, msid, units, controls}
 *   metadata.json  → {nav_id, display_name, pitch_step, configs: {config_id: {dates, files, table_csv}}}
 *   <date>.json    → {times, series[{pitch, temperatures}], meta{start_date,end_date,units,annotation}}
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
    _cache.charts[key] = await fetchJSON(chartJsonPath);
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
          if (isFinite(n)) val = n.toFixed(3);
        }
        parts.push(`<${tag}>${val}</${tag.split(' ')[0]}>`);
      });
      parts.push('</tr>');
    }
    parts.push('</tbody></table></div>');
    container.innerHTML = parts.join('');
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
    // Cache (exposed so tests can inspect and reset it)
    _cache,
    // Async data loaders
    loadManifest,
    loadMetadata,
    loadChartData,
    loadTableCsv,
    // Renderers
    renderDwellChart,
    renderSummaryTable,
  };

}(window));
