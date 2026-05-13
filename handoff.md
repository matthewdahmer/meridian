# Meridian – Development Handoff

This document captures the current state of the application in enough detail to pick up development without reading individual data files. Read alongside `CLAUDE.md` (conventions, MSID names, data schemas), `data.md` (protractor data format detail), `README.md` (dev/build/deploy workflows), and `web_theme.md` (CSS conventions).

---

## What Exists

### Site structure

Meridian is a static multi-page site with three apps served from a shared dev root:

```
meridian/
├── CLAUDE.md
├── data.md
├── README.md
├── web_theme.md
├── handoff.md                  ← this file (Protractor + Steady States)
├── build.py                    ← assembles dist/ for deployment
├── data/                       ← protractor scenario data (do NOT read individual files)
│   ├── manifest.json           ← read freely; small index file
│   └── YYYY-DDD-*_chipsN.json.gz   ← 60 compressed JSON files
├── protractor/
│   ├── index.html
│   ├── app.js                  ← all logic, IIFE pattern
│   ├── changelog.md            ← manually maintained dataset changelog (displayed in Changelog tab)
│   └── vendor/                 ← bootstrap.min.css, bootstrap.bundle.min.js, d3.min.js
├── steady_states/
│   ├── index.html
│   ├── app.js                  ← verbatim copy of ../xija_steady_states/templates/app.js
│   ├── vendor/                 ← same vendor files as protractor/vendor/
│   └── data/                   ← generated; do NOT read individual files (manifest.json OK)
│       ├── manifest.json
│       └── <nav_id>/...
└── model_dash/                 ← Model Dashboard app (see model_dash/handoff.md)
    ├── index.html
    ├── app.js                  ← all logic, IIFE pattern (~1972 lines)
    ├── config.js               ← per-model axis/bin overrides
    ├── handoff.md              ← dedicated handoff for this app — read this first
    ├── data_file_structure.md  ← authoritative schema for *.json.gz files
    ├── vendor/                 ← same vendor files as other apps
    └── data/                   ← one *.json.gz per model + manifest.json (not in repo)
```

**Dev server:** `python -m http.server 8765` from `meridian/` — no build step needed.

**URLs:**
- `http://localhost:8765/protractor/` — Pitch Sensitivity (Protractor) app
- `http://localhost:8765/steady_states/` — Steady States app
- `http://localhost:8765/model_dash/` — Model Dashboard app

**Build for deployment:** `python build.py [--force]` → assembles `dist/`

---

## App 1: Protractor (`protractor/`)

### What it does

Four rendered outputs, all driven by the same condition selectors:

1. **Configuration Selection card** — fixed 170px-wide left card with a "Configuration / Selection" card header, containing 16 dropdowns stacked vertically: Date, Chips, and 14 thermal limit selectors. Date/Chips → network fetch + full re-render. Any limit → re-filter in memory + re-render (no fetch).

2. **Tabbed data graphic card** — right card with three Bootstrap tabs:
   - **Protractor tab** — semicircular polar plot (135° arc, pitch 45–180°). One radial band per thermal model. Color coding: light red = limited dwell, dark red = active limiting constraint, light blue = offset, gray = neutral. HRC bands use half-width overlapping blue-over-red rendering.
   - **Line Plot tab** — "Composite Dwell Capability" line chart. Pitch 45–180° on x-axis, dwell duration in kiloseconds on y-axis. See Line Plot section below.
   - **Changelog tab** — displays `protractor/changelog.md`, parsed and rendered as structured HTML. One entry per `## ` header: bold `**Key:** Value` lines become a metadata row; the markdown table becomes a two-column parameter grid. Fetched independently of scenario data at init time.

3. **Configuration Legend card** — HTML card below the tabbed graphic card, to the right of the Configuration Selection card. Shows the current selected values (Date, Chips, all 14 thermal limits) as a 4-column grid. Previously this was drawn inside the SVG; it was split out into its own card. This card is hidden (`display:none`) until first render.

4. **Two data tables** — below the entire content area. Limited dwell times and offset dwell times, one row per pitch, one column per active MSID, plus Limiting Model and Composite Minimum columns.

### ⚠️ Critical: Data Units

**Dwell values in the scenario files are in SECONDS, not ksec.** A typical limited dwell might be 50,000 seconds (50 ksec). The line plot y-axis divides raw values by 1000 to display in ksec. The protractor uses raw second values comparatively (units don't matter for the color logic). Data tables display raw seconds and are labeled "(sec)" — the label was corrected from the original "(ksec)" in April 2026.

**Thermal limit values in the scenario files are always in Celsius**, regardless of which MSID they belong to. `formatLimitVal(v, units)` handles the conversion: when `units === 'F'`, it applies `v * 9/5 + 32` before formatting. This affects both the limit dropdown option labels and the Configuration Legend card values. The unit string shown in the UI (`°C` or `°F`) comes from `MSID_INFO[msid].units`.

### Data flow

```
init()
  └── fetch ../data/manifest.json
  └── populate date + chips dropdowns
  └── loadAndRender()
        └── loadRaw(date, chips) → { rawLim, rawOff, meta }
              └── fetchGz() — fetch + LRU-cache compressed ArrayBuffers
              └── decompressAndParse() — DecompressionStream → NaN→null → JSON.parse
              └── parseScenarioColumns()
        └── populateLimitDropdowns(rawLim) — fills all 14 limit selects with unique values from data
        └── refilterAndRender()
  └── attach change listeners: date/chips → loadAndRender; all 14 limits → refilterAndRender
  └── attach tab-shown listener: tab-lineplot-btn → re-render lineplot at correct width
  └── attach resize handler (debounced 150ms, re-renders both protractor and lineplot)
  └── fetch ./changelog.md (independent of data loading)
        └── parseChangelog(text) → [{title, meta:{}, params:[{param,values}]}]
        └── renderChangelogEntries(entries, #tab-changelog-content)

refilterAndRender()
  └── getSelectedLimits() → Map<col, numericValue>  (reads all 14 selects)
  └── filterAndAggregate(rawLim, selectedLimits) → lim  (Uint8Array mask filter → min per pitch)
  └── filterAndAggregate(rawOff, selectedLimits) → off
  └── buildConditions(rawLim, selectedLimits) → [{label, value}]
  └── show #chart-tabs (hides #loading-state)
  └── render(protractorContainer, lim, off, meta, conditions) → { summary, msids, pitches }
        └── detectMsids()        — output columns only (not metadata, not _limit suffix)
        └── buildPitchSummary()  — Map<pitch, Map<msid, {limMin, offMin}>>
        └── activeMsids()        — filters to PREFERRED_ORDER, skips entirely-null MSIDs
        └── if msids.length === 0 → renderNoData(container); return { summary, msids:[], pitches }
        └── findLimitingMsids()  — HRC excluded; per pitch: lowest limMin wins
        └── draws bands, labels, ticks, title, color legend via D3 SVG
        └── returns { summary, msids, pitches }
  └── store _lastRenderArgs = [protractorContainer, lim, off, meta, conditions]
  └── renderLineplot(lineplotContainer, lim, off, msids)
        └── if msids.length === 0 → renderNoData(container); return
  └── store _lastLineplotArgs = [lineplotContainer, lim, off, msids]
  └── renderConditionsLegend(conditions) → HTML grid in #legend-content, shows #legend-card
  └── renderTables(summary, msids, pitches) → builds two Bootstrap table cards into #tables-area
```

### Key constants (`app.js`)

#### `ALL_LIMITS`

Every limit column gets a UI dropdown. 14 entries in display order:

```js
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
  { col: '1pdeaat_limit',    msid: '1pdeaat'    },
  { col: 'tpc_fsse_limit',   msid: 'tpc_fsse'   },
];
```

Note: HRC limit columns use `2ceahvpt_limit_s` / `2ceahvpt_limit_i` (suffix after "limit"), unlike all other columns which use `<msid>_limit`.

#### `MSID_INFO`

Maps each MSID to `{ name, units }` where `units` is `'C'` or `'F'`:

```js
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
  'tpcm_rw5':   { name: 'TPCM RW5',               units: 'F' },
};
```

`MSID_COMMON_NAMES` is derived from `MSID_INFO` for backward-compatible use in render/table code.

#### `PREFERRED_ORDER`

Canonical inner→outer band render order. Only MSIDs in this list appear on the plot. Also used to assign stable colors in the line plot (index in `PREFERRED_ORDER` → index in `LINE_COLORS`):

```
'2ceahvpt_s', '2ceahvpt_i', 'pline03t', 'pline04t', '1dpamzt', '1deamzt',
'fptemp_11', '4rt700t', 'tpc_fsse', 'aacccdpt', 'pftank2t', 'pm2thv1t', 'pm1thv2t', '1pdeaat'
```

#### `HRC_MSIDS`

`new Set(['2ceahvpt_s', '2ceahvpt_i'])` — drives special rendering in the protractor and exclusion from the composite minimum in the line plot.

#### `NON_OUTPUT_COLS`

`Set(['pitch', 'date', 'datesecs', 'dwell_type', 'chips', 'roll', '2ceahvpt'])` — never treated as MSID outputs.

#### `COLORS` (protractor arc colors)

```js
limited:        'rgb(228, 172, 164)'       // rgba(220,80,60,0.40) composited over neutral
limitingFactor: 'rgba(200, 50, 30, 1.00)'
offset:         'rgb(168, 192, 220)'       // rgba(70,130,200,0.40) composited over neutral
offsetSolid:    'rgb(156, 193, 226)'       // opaque blue for HRC overlay over red
neutral:        'rgba(180, 180, 180, 0.28)'
```

All colored fills are **fully opaque** (no SVG alpha). Translucent fills produce sub-pixel seam artifacts. All colored arc paths carry `.attr('stroke', <same color>).attr('stroke-width', 0.5)` to eliminate anti-aliasing seams.

#### `LINE_COLORS` (line plot per-MSID colors)

14-color palette, indexed by position in `PREFERRED_ORDER`. Assigned via `msidColor(msid)`:

```js
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
```

#### `formatLimitVal(v, units)`

Formats a thermal limit value for display in dropdown options and the Configuration Legend card. **Data values are always in Celsius.** When `units === 'F'`, converts via `v * 9/5 + 32` before formatting. Integer results display without decimal places; non-integer results use `.toFixed(2)`. Returns `"—"` for null/undefined.

```js
function formatLimitVal(v, units) {
  if (v === null || v === undefined) return '—';
  const display = units === 'F' ? v * 9 / 5 + 32 : v;
  const num = Number.isInteger(display) ? String(display) : display.toFixed(2);
  return units === 'F' ? `${num} °F` : `${num} °C`;
}
```

#### `renderNoData(container)`

Shared helper called by both `render()` and `renderLineplot()` when `activeMsids()` returns an empty array (no MSIDs have non-null values for the selected conditions). Clears the container and injects an explanatory HTML message at 1rem font size:

> **No data exists for the chosen set of conditions.**
>
> If you expected data to be available, consider the following notes:
> 1. Both propulsion lines are usually set to the same limit
> 2. Both MUPS valves are usually set to the same limit
> 3. A large range of ACA limits are usually available, however not all ACA conditions have data associated with every other location condition

When `render()` calls `renderNoData()`, it still computes and returns `{ summary, msids: [], pitches }` so `refilterAndRender()` can pass empty msids to `renderLineplot()` and `renderTables()` without errors.

#### Gzip LRU cache

`_gzCache = Map<url, {buffer: ArrayBuffer, lastUsed: number}>`, max `GZ_CACHE_MAX = 20` entries. Stores compressed buffers (not decompressed data). Decompression runs on every `refilterAndRender()` call but is fast relative to network fetch.

### Module-level state

```js
let _loadedData       = null;  // { rawLim, rawOff, meta }
let _lastRenderArgs   = null;  // [container, lim, off, meta, conditions] — protractor resize
let _lastLineplotArgs = null;  // [container, lim, off, msids] — lineplot resize / tab-shown
const _gzCache        = new Map();
```

---

### Protractor rendering details

#### Angle geometry

- `pitchToAngle(p) = (180 − p) × π / 180`
- `mathToD3(a) = π/2 − a` (D3 arc: 0=12 o'clock, CW)
- pitch 180 → 0° (horizontal right), pitch 90 → 90° (straight up), pitch 45 → 135° (upper-left)

#### SVG layout

ViewBox `W × H`, `H = W × 0.70`. Arc center `(cx, cy)` where `cy = H − marginBottom`.

- `marginTop = H × 0.12`, `marginBottom = H × 0.13`
- `labelAreaW = W × 0.22`, `marginRight = W × 0.04`, `pitchPad = 0.10`
- `outerR` = largest value fitting `availH / (1 + pitchPad)` and `availW / (1.707 + pitchPad)` (the 1.707 factor = 1 + 1/√2, the arc's x-span)
- SVG uses `viewBox` + `preserveAspectRatio="xMidYMid meet"` (responsive, no explicit width/height on the SVG element)

**Note on marginBottom:** Was previously `H × 0.25` to accommodate the in-SVG conditions legend. After moving the conditions legend to an HTML card, restored to `H × 0.13`.

#### Band geometry

- Inner bands start at `outerR × 0.25` (inner 25% reserved)
- `bandGap = max(0.8, outerR × 0.007)`, `bandW = (outerR − innerGap − bandGap × (nBands−1)) / nBands`
- Band `bi`: `iR = innerGap + bi × (bandW + bandGap)`, `oR = iR + bandW`, `rMid = (iR + oR) / 2`

#### Band rendering order (per band, per pitch)

1. Neutral background — single full-span arc, `rgba(180,180,180,0.28)`, no stroke
2. Limited (light red) — wherever `limMin != null`
3. Offset (light blue) — non-HRC: only where `offMin != null AND limMin == null`; HRC: wherever `offMin != null`, drawn on outer half only (`iR = rMid`), using `offsetSolid`
4. Limiting factor (dark red) — wherever `limMin != null AND msid ∈ limiting set`

#### HRC special cases

`2ceahvpt_s` and `2ceahvpt_i` always have `limMin` and `offMin` at the same pitches (100% overlap). Two special behaviors:
1. **Offset is not suppressed** by the presence of `limMin` — guard omitted for HRC
2. **Excluded from `findLimitingMsids()`, table composite minimum/limiting model, and line plot composite minimum**

#### Limiting factor logic

`findLimitingMsids(summary, msids)` receives only non-HRC active MSIDs. Returns `Map<pitch, Set<msid>>` — the lowest `limMin` wins at each pitch; ties included.

**Critical**: must pass `msids` (displayed, non-HRC), NOT `allMsids`. If called with `allMsids`, a low-valued MSID can win the minimum at every pitch and suppress all dark-red rendering.

#### MSID labels

- Positioned at pitch=45 boundary (left edge of each band)
- `labelR = rMid − bandW × 0.35` along the pitch=45 radial
- `rotate(-45)` — text perpendicular to arc, extending lower-left; `text-anchor: 'end'`
- `font-size = max(7, min(14, bandW × 0.72))`

#### Color legend (in-SVG, top-right corner)

`drawLegend(svg, W, marginTop, pitchFontSize)` — draws a 152px-wide box in the top-right margin of the SVG with 4 items: Limited Pitch Range, Limiting Factor, Neutral, Offset Pitch Range.

---

### Line Plot rendering details (`renderLineplot`)

**Title:** "Composite Dwell Capability"

**Axes:**
- X: pitch in degrees, domain [45, 180], ticks at every 15°, labeled `45°`, `60°`, ..., `180°`. Label: "Pitch". Font size 16px.
- Y: dwell in seconds (raw data units), domain [0, yMax] where `yMax = min(data_max, 100000)` (capped at 100,000 seconds = 100 ksec). After D3 `.nice()`. Tick format: `d => `${d / 1000}k`` (e.g. `"50k"` for 50,000 s). Label: "Dwell Duration (Kiloseconds)". Font size 16px.

**SVG layout:**
- `LEGEND_W = 170` (pixels reserved for the right-side legend column)
- `W = max((container.clientWidth || 900) - LEGEND_W, 400)` — SVG width only; legend sits beside it
- `H = round(W × 0.55)`
- `margin = { top: 44, right: 24, bottom: 50, left: 78 }`
- `iW = W - margin.left - margin.right`, `iH = H - margin.top - margin.bottom`
- Explicit `width` / `height` attributes on SVG (not viewBox — unlike the protractor)
- `clipPath id="lp-clip"` rect of `iW × iH` applied to all line paths via `<g clip-path="url(#lp-clip)">`. Ensures values above the y-cap do not draw into the margin or title area.

**DOM structure inside `#lineplot-container`:**
```
wrapper div (flex row, align-items:flex-start)
  chartDiv (flex:0 0 auto)
    svg (W × H, explicit width/height)
  legendDiv (width:170px, flex-shrink:0, flex column, padding-top:margin.top)
    composite min entry
    one entry per active MSID
```
The wrapper is a flex row so the legend column sits to the right of the SVG. `legendDiv.padding-top = margin.top` aligns the first legend item with the top of the chart area (below the title).

**Line encoding:**
- **Composite minimum** (non-HRC limited only): thick gray stroke, `stroke-width: 12`, color `#bbbbbb`, `stroke-linejoin/cap: round`. Drawn first, behind all other lines.
- **Per-MSID limited:** solid, `stroke-width: 3`, color from `msidColor(msid)`.
- **Per-MSID offset:** dashed, `stroke-width: 2`, `stroke-dasharray: "5,3"`, same color as limited.
- HRC MSIDs (`2ceahvpt_s`, `2ceahvpt_i`) ARE included in per-MSID lines but are excluded from the composite minimum.
- `lineGen.defined(d => d.v != null && isFinite(d.v))` — null/NaN values create line breaks.

**Composite minimum calculation:**
```js
pitchArr.map((p, i) => {
  let min = null;
  for (const msid of msids) {
    if (HRC_MSIDS.has(msid)) continue;
    const v = lim[msid]?.[i];
    if (v != null && isFinite(v)) min = min === null ? v : Math.min(min, v);
  }
  return { p, v: min };
});
```

**Hover interactivity:**
Lines are rendered in two passes inside `linesG`:
1. **Visible pass** — limited (solid, `stroke-width:3`) and offset (dashed, `stroke-width:2`) paths drawn for each MSID. References stored in `linesByMsid: Map<msid, {limPath, offPath, limData, offData}>`.
2. **Hit-area pass** — for each MSID, two transparent `stroke-width:10` paths (one over limData, one over offData) are appended on top of all visible lines. These carry `.style('pointer-events','stroke')` so hover registers on the stroke area regardless of color. `cursor:pointer`.

On `mouseenter` (either hit area for an MSID):
- `limPath.stroke-width` → 6 (doubled)
- `offPath.stroke-width` → 4 (doubled)
- The MSID's legend `<span>` → `font-weight: 700` (bold)

On `mouseleave`: restores `stroke-width` 3/2 and clears `font-weight`.

`legendSpanByMsid: Map<msid, HTMLSpanElement>` — built during the legend section; referenced by the hover closures. Because closures execute at call time (not definition time), the map is populated before any hover can fire.

**Legend (right-side vertical column):**
HTML items built inside `legendDiv`. First entry: composite min (gray 22×6px swatch, label "Composite Min"). Then one entry per active MSID in `msids` order: colored 16×2px swatch + `<span>` with common name. The span is stored in `legendSpanByMsid` for hover bolding.

**Line-type notes (below the chart):**
After the flex `wrapper` (chart + legend) is appended to `container`, a separate `<div>` is appended directly to `container` with the following text (two lines):

> Solid lines represent limited dwell time
> Dashed lines represent offset dwell time

Style: `font-size:.78rem; color:#666; margin-top:.5rem; padding-left:${margin.left}px; line-height:1.6`. The `padding-left` matches the chart's left margin (78px) so the text aligns with the left edge of the plot area. Rendered via `innerHTML` with a `<br>` separator.

**No-data state:**
If `msids` is empty or falsy, `renderNoData(container)` is called immediately and the function returns without rendering any SVG. See `renderNoData` in Key Constants section.

**Resize / tab-shown behavior:**
- `shown.bs.tab` on `#tab-lineplot-btn` → re-renders with stored `_lastLineplotArgs` at correct container width
- Window resize (debounced 150ms) → re-renders both protractor (`_lastRenderArgs`) and line plot (`_lastLineplotArgs`)
- When lineplot is rendered while tab is hidden, `container.clientWidth` is 0; fallback is 900px. The `shown.bs.tab` event immediately re-renders at the correct width.

---

### Changelog tab (`protractor/changelog.md`)

`changelog.md` is a manually maintained markdown file fetched at init time. It is independent of scenario data — it loads and renders even if data loading fails.

**Format:** one entry per `## ` header line. Entries should be ordered newest-first (add at the top). Never delete old entries.

```markdown
## Entry Title

**Generated:** YYYY-MM-DD
**Models version:** chandra_models X.XX
**MD5:** (hash)

| Parameter | Available Values |
|---|---|
| Date | Jan 1 2026, Apr 1 2026, ... |
| Chips | 1, 2, 3, 4, 5, 6 |
| HRC-S CEA (°C) | -10, -20 |
...
```

**`parseChangelog(text)` — parsing rules:**
- Splits on `\n(?=## )` to isolate sections
- Within each section, `**Key:** value` lines before any table row are collected as `entry.meta`
- Table parsing uses a three-phase state machine: first `|` row = header (skipped), second = separator (skipped), subsequent = data rows → `entry.params[]`
- A non-blank, non-`|` line after the table resets phase to 0, allowing multiple tables per entry (not currently used)

**`renderChangelogEntries(entries, container)` — output structure:**
- Entry title: dark-blue bold `div`, 0.9rem
- Metadata: `flex` row of `<span>` elements at 0.75rem, `<strong>Key:</strong> value`
- Params: `<table>` with alternating `#f7f8fa` / `#fff` row backgrounds, 0.75rem
- Entries separated by `<hr>` with `border-color:#e5e7eb`

**`escapeHtml(s)`** is used on all metadata key and value strings before inserting into `innerHTML`. Param values are set via `textContent` (no escaping needed).

If the file is missing or the fetch fails, `#tab-changelog-content` shows "Changelog unavailable."

---

### HTML structure (`protractor/index.html`)

Fixed 260px dark sidebar + flex-grow `#main`.

**Top area layout** — `#content-area` is a flex row (`display:flex; gap:.75rem; align-items:stretch`) containing:

**Left card** (fixed `width:170px`, `flex-shrink:0`):
- Card header: "Configuration / Selection" (two-line, centered, `fw-semibold small`)
- Body: `#condition-bar` — all 16 condition selects stacked vertically
- `#condition-bar { font-size: 0.8em; font-weight: bold }`, `#condition-bar select { font-size: 0.8em }`

**Right column** (`flex:1; min-width:0; display:flex; flex-direction:column; gap:.75rem`):

  **Tabbed card** (`#protractor-panel`, `.card`, `flex:1; min-height:0`):
  - `flex:1` causes it to grow and fill the remaining vertical space in the right column after the Configuration Legend card takes its natural height. This makes the bottom of the Configuration Legend card align with the bottom of the Configuration/Selection card on the left. Both cards are in a `#content-area` flex row with `align-items:stretch`, so the right column already fills the left card's full height.
  - `#loading-state` — visible while fetching; hidden once `#chart-tabs` is shown
  - `#chart-tabs` — hidden until first render; shown by `refilterAndRender()`
    - Bootstrap tab nav: "Protractor" (`#tab-protractor-btn`) | "Line Plot" (`#tab-lineplot-btn`) | "Changelog" (`#tab-changelog-btn`)
    - Tab pane `#tab-protractor` (default active): contains `#chart-container` (SVG rendered here)
    - Tab pane `#tab-lineplot`: contains `#lineplot-container` (wrapper div with SVG + legendDiv rendered here)
    - Tab pane `#tab-changelog`: contains `#tab-changelog-content` (populated by `renderChangelogEntries()` from `changelog.md`)

  **Configuration Legend card** (`#legend-card`, `.card`, `display:none` until first render):
  - Card header: "Configuration" (`fw-semibold small`)
  - Body `#legend-content`: 4-column CSS grid, one cell per condition item (Date, Chips, 14 limits)
  - Cell format: `<span style="font-weight:600;">Label:</span> Value`
  - Font size 0.78rem
  - Bottom edge aligns with bottom of the Configuration/Selection card because `#protractor-panel` has `flex:1` and absorbs all remaining vertical space above it.

**Condition selects** (`id=sel-<col>`, `w-100`):
- `sel-date` — populated from manifest at init, options via `doyLabel()`
- `sel-chips` — populated from manifest at init
- 14 limit selects (`sel-<col>`) — populated by `populateLimitDropdowns()` after first fetch

**Condition select labels** (displayed in the left card, top to bottom):
Date, Chips, HRC-S CEA (°C), HRC-I CEA (°C), Prop. Line #3 (°F), Prop. Line #4 (°F), ACIS DPA (°C), ACIS DEA (°C), ACIS FP (°C), OBA Fwd Bulkhead (°F), ACA CCD (°C), IPS Tank (°F), MUPS Thruster 1B (°F), MUPS Thruster 2A (°F), ACIS PSMC (°C), Fine Sun Sensor Elec. (°F)

**Below `#content-area`:**
- `#tables-area` — two data table cards rendered by `renderTables()`
- `#error-panel` — Bootstrap alert, hidden by default

**Sidebar** structure:
```
#sidebar
  .brand "Meridian"
  .section-label "Views"
  nav
    a#nav-protractor.active "Pitch Sensitivity"
    a[data-bs-toggle=collapse, href="#ss-collapse"] "Steady States ▾"
    div#ss-collapse.collapse           ← closed by default on protractor page
      ul#ss-model-nav                  ← populated by JS after App.init()
```

After `App.init()`, the boot script fetches `../steady_states/data/manifest.json` and builds `<a href="../steady_states/?model=${entry.nav_id}" class="nav-link sub-nav-link">` links into `#ss-model-nav`. Fails silently if the manifest doesn't exist.

---

## App 2: Steady States (`steady_states/`)

### What it does

Shows Xija thermal model steady-state temperatures as multi-line dwell curves and summary tables. One model at a time, selectable from the sidebar. Single-page app (no page reload on model switch).

### Architecture

`steady_states/app.js` is a **verbatim copy** of `../xija_steady_states/templates/app.js`. It exposes a global `App` object:

```
App.loadManifest()       → fetches data/manifest.json
App.loadMetadata(nav_id) → fetches data/<nav_id>/metadata.json
App.loadChartData(...)   → fetches per-date JSON files
App.renderDwellChart()   → D3 chart
App.renderSummaryTable() → Bootstrap table
App.parseManifest()      → normalizes manifest structure
App.resolveConfigId()    → selects appropriate config
App.buildControlsHTML()  → builds config/date control HTML
App.buildDateSelectorHTML()
```

All data fetches are relative to the page URL — resolves correctly from `steady_states/`.

### HTML structure (`steady_states/index.html`)

Uses identical `#sidebar` CSS as `protractor/index.html`. Sidebar structure:

```
#sidebar
  .brand "Meridian"
  .section-label "Views"
  nav
    a[href="../protractor/"] "Pitch Sensitivity"
    a[data-bs-toggle=collapse, href="#ss-collapse"] "Steady States ▾"
    div#ss-collapse.collapse.show      ← open by default on steady_states page
      ul#sidebar-nav                   ← populated by buildNav() from manifest
```

Model links call `selectModel(nav_id)` (SPA in-place update, no page reload). Links have `class="nav-link sub-nav-link"`.

Scripts loaded at bottom: `vendor/d3.min.js`, `vendor/bootstrap.bundle.min.js`, `app.js`.

### URL param auto-selection

`init()` reads `?model=<nav_id>` from the URL after building the nav. If the param matches a manifest entry, `selectModel()` is called immediately. This enables the protractor sidebar to link directly to a specific model:

```
../steady_states/?model=aca
```

### Data location

`steady_states/data/` is generated by running `xija_steady_states` (see README.md). The app gracefully handles its absence — `loadManifest()` will reject and show an error. The protractor sidebar silently omits model links when the manifest fetch fails.

---

## App 3: Model Dashboard (`model_dash/`)

Full documentation lives in **`model_dash/handoff.md`** — read that file for everything related to
this app. Brief summary:

- Displays historical thermal model performance: telemetry vs. time, scatter, error histogram,
  pitch-bin error traces, dwell exploration scatter, solarheat parameters, and ACIS DPA state power.
- One gzip-compressed JSON file per model in `model_dash/data/`, plus `manifest.json`. Data files
  are not in the repository — they must be generated by a separate pipeline and placed there.
- All rendering is in `app.js` (IIFE, ~1972 lines); `index.html` owns navigation and model switching.
- `config.js` provides per-model axis range and bin size overrides.

---

## Build Process (`build.py`)

Pure Python stdlib — no ska3-dev or other dependencies.

```
python build.py [--output-dir DIR] [--force]
```

Copies into `dist/` (or `DIR`):
- `protractor/` → `dist/protractor/`
- `data/` → `dist/data/`
- `steady_states/index.html`, `app.js`, `vendor/` → `dist/steady_states/`
- `steady_states/data/` → `dist/steady_states/data/` (warns but succeeds if absent)
- `model_dash/index.html`, `app.js`, `config.js`, `vendor/` → `dist/model_dash/`
- `model_dash/data/` → `dist/model_dash/data/` (warns but succeeds if absent)

Vendor files are per-app — no shared copy. ~500 KB duplication is acceptable and avoids changing existing `vendor/` paths.

`handoff.md`, `data_file_structure.md`, and `reference.md` inside `model_dash/` are **not** copied to dist — they are developer documentation only.

---

## Cross-Page Navigation

| From | To | Mechanism |
|---|---|---|
| Protractor sidebar | Steady States (specific model) | `<a href="../steady_states/?model=<nav_id>">` — full page load |
| Protractor sidebar | Model Dashboard | `<a href="../model_dash/">` — full page load |
| Steady States sidebar | Protractor | `<a href="../protractor/">` — full page load |
| Steady States sidebar | Model Dashboard | `<a href="../model_dash/">` — full page load |
| Steady States sidebar (model links) | Same page, different model | `selectModel()` — SPA, no reload |
| Model Dashboard sidebar | Protractor | `<a href="../protractor/">` — full page load |
| Model Dashboard sidebar | Steady States (specific model) | `<a href="../steady_states/?model=<nav_id>">` — full page load |
| Model Dashboard sidebar (model links) | Same page, different model | `selectModel()` — SPA, `?model=<nav_id>` URL param updated |

All three sidebars share the same dark theme and three-section structure (Pitch Sensitivity, Steady States collapse, Model Dashboard collapse). Active link CSS: `color: #60a5fa; background: #1e3a56; border-left: 3px solid #3b82f6`.

The Steady States and Model Dashboard sidebar sections are collapsible Bootstrap collapses. Each page expands its own section by default (`collapse show`) and leaves the others closed.

---

## Data Tables

`renderTables(summary, msids, pitches)` builds two cards into `#tables-area`:

- Bootstrap `table table-sm table-striped table-bordered`, `font-size: 0.78rem`, horizontal scroll wrapper
- Columns: **Pitch** | one per active MSID | **Limiting Model** | **Composite Minimum**
- `null` → `"—"`, numbers → `toFixed(1)`
- Limiting Model and Composite Minimum exclude HRC MSIDs; first-wins on ties

Two tables: "Limited Dwell Times (sec)" and "Offset Dwell Times (sec)".

Table values are raw seconds from the data files. The unit label was corrected from "(ksec)" to "(sec)" in April 2026.

---

## Known Issues and Things to Revisit

### ~~Table unit label~~ — resolved

Table titles now correctly show "(sec)" instead of "(ksec)". Fixed April 2026.

### ~~Line plot legend swatch for offset lines~~ — resolved

A note below the line plot now reads "Solid lines represent limited dwell time / Dashed lines represent offset dwell time". Added April 2026.

### Label placement on protractor (priority: medium)

The `rotate(-45)` label approach works well for outer bands. For inner bands, labels may clip near the SVG bottom edge on smaller viewports. Options:
- Clip to label area using SVG `clipPath`
- Shorten inner-band labels to abbreviations when band width is very small

---

## Roadmap: Next Development Steps

### 1. Center area content (protractor)

The inner 25% of the arc (`r < outerR × 0.25`) is reserved. Candidates:
- Composite minimum dwell time as a filled arc
- Radial axis showing dwell-time magnitude scale
- Sun-direction indicator

### 2. Interactivity

- **Hover tooltip**: MSID name, pitch, limited dwell (ksec), offset dwell
- **Band highlight**: clicking a band raises its opacity, dims others
- **Pitch crosshair**: radial line following the mouse across all bands
- **Line plot hover**: crosshair + tooltip showing all MSID values at a given pitch

### 3. Export

"Download SVG" / "Download PNG" button for use in PowerPoint slides.

### 4. Multi-condition overlay or faceting

Compare pitch sensitivity across dates or chips as overlaid plots or a faceted grid.

### 5. Line plot polish

- Add horizontal reference line at a user-specified dwell duration
- Consider log scale option for y-axis (wide dynamic range between MSIDs)
- Hover tooltip: show pitch value, limited dwell (ksec), and offset dwell for the hovered MSID at the cursor's x position
