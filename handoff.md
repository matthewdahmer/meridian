# Meridian – Development Handoff

This document captures the current state of the application in enough detail to pick up development without reading individual data files. Read alongside `CLAUDE.md` (conventions, MSID names, data schemas), each `protractor/data/timbre_data_*/data.md` (protractor data format detail per version), `README.md` (dev/build/deploy workflows), and `web_theme.md` (CSS conventions).

---

## What Exists

### Site structure

Meridian is a static multi-page site with three apps served from a shared dev root:

```
meridian/
├── CLAUDE.md
├── README.md
├── web_theme.md
├── handoff.md                       ← this file
├── build.py                         ← assembles dist/ for deployment
├── deploy.py                        ← regenerate both data sets, build, rsync to server (see Deploy Process)
├── deploy_config.example.json       ← template for deploy_config.json (gitignored, per machine)
├── protractor/
│   ├── index.html
│   ├── app.js                       ← all logic, IIFE pattern
│   ├── changelog.md                 ← manually maintained dataset changelog (displayed in Changelog tab)
│   ├── vendor/                      ← bootstrap.min.css, bootstrap.bundle.min.js, d3.min.js
│   └── data/                        ← all protractor data (same pattern as steady_states/data/ and model_dash/data/)
│       ├── timbre_sources.json      ← lists available timbre data directories (tracked in git)
│       ├── timbre_data_f513ee0_3.76.0/   ← scenario data v3.76.0 (gitignored; do NOT read individual files)
│       │   ├── manifest.json        ← dates (unsorted) and chips only; no limits array, no data.md
│       │   └── YYYY-DDD-*_chipsN.json.gz ← 204 compressed JSON scenario files (17 dates × 2 types × 6 chips)
│       ├── timbre_data_7328a78_3.74.0/   ← scenario data v3.74.0 (gitignored; do NOT read individual files)
│       │   ├── data.md              ← protractor data format detail for this version
│       │   ├── manifest.json        ← read freely; dates, chips, limits arrays
│       │   └── YYYY-DDD-*_chipsN.json.gz ← 48 compressed JSON scenario files (4 dates × 2 types × 6 chips)
│       └── timbre_data_b073e82_3.73.1/   ← scenario data v3.73.1 (gitignored; do NOT read individual files)
│           ├── data.md              ← protractor data format detail for this version
│           ├── manifest.json        ← read freely; dates, chips, limits arrays
│           └── YYYY-DDD-*_chipsN.json.gz ← 60 compressed JSON scenario files (5 dates × 2 types × 6 chips)
├── steady_states/
│   ├── index.html                   ← installed by xija_steady_states --setup; edit there, not here
│   ├── app.js                       ← installed by xija_steady_states --setup; edit there, not here
│   ├── vendor/                      ← same vendor files as protractor/vendor/ (D3 7.9.0, Bootstrap 5.3.3)
│   └── data/                        ← generated; do NOT read individual files (manifest.json OK)
│       ├── manifest.json
│       └── <nav_id>/...
└── model_dash/                      ← Model Dashboard app (see model_dash/handoff.md)
    ├── index.html
    ├── app.js                       ← all logic, IIFE pattern (~1972 lines)
    ├── config.js                    ← per-model axis/bin overrides
    ├── handoff.md                   ← dedicated handoff for this app — read this first
    ├── data_file_structure.md       ← authoritative schema for *.json.gz files
    ├── vendor/                      ← same vendor files as other apps
    └── data/                        ← one *.json.gz per model + manifest.json (not in repo)
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

1. **Timbre Data Selection card** — compact card above the plot, inline with the right column. Contains a "Timbre Data Selection" label and a dropdown (`#sel-timbre-source`) listing all available data source directories from `timbre_sources.json`. Switching sources re-fetches the manifest, repopulates Date/Chips, shows/hides limit selectors, and triggers a full data reload.

2. **Configuration Selection card** — fixed 170px-wide left card with a "Configuration / Selection" card header, containing up to 17 dropdowns stacked vertically: Date, Chips, and up to 15 thermal limit selectors. The set of visible limit selectors is controlled by the selected data source's `manifest.limits` array — selectors for limits not present in the active dataset are hidden. Date/Chips changes → network fetch + full re-render. Any limit change → re-filter in memory + re-render (no fetch).

3. **Tabbed data graphic card** — right card with three Bootstrap tabs:
   - **Protractor tab** — semicircular polar plot (135° arc, pitch 45–180°). One radial band per thermal model. Color coding: light red = limited dwell, dark red = active limiting constraint, light blue = offset, gray = neutral. HRC bands use half-width overlapping blue-over-red rendering.
   - **Line Plot tab** — "Composite Dwell Capability" line chart. Pitch 45–180° on x-axis, dwell duration in kiloseconds on y-axis. Legend items are clickable to hide/show individual MSID line pairs (solid + dashed). See Line Plot section below.
   - **Changelog tab** — displays `protractor/changelog.md`, parsed and rendered as structured HTML. One entry per `## ` header: bold `**Key:** Value` lines become a metadata row; the markdown table becomes a two-column parameter grid. Fetched independently of scenario data at init time.

4. **Configuration Legend card** — HTML card below the tabbed graphic card, to the right of the Configuration Selection card. Shows the current selected values (Date, Chips, all visible thermal limits) as a 4-column grid. Hidden (`display:none`) until first render.

5. **Two data tables** — below the entire content area. Limited dwell times and offset dwell times, one row per pitch, one column per active MSID, plus Limiting Model and Composite Minimum columns.

### ⚠️ Critical: Data Units

**Dwell values in the scenario files are in SECONDS, not ksec.** A typical limited dwell might be 50,000 seconds (50 ksec). The line plot y-axis divides raw values by 1000 to display in ksec. The protractor uses raw second values comparatively (units don't matter for the color logic). Data tables display raw seconds and are labeled "(sec)".

**Thermal limit values in the scenario files are always in Celsius**, regardless of which MSID they belong to. `formatLimitVal(v, units)` handles the conversion: when `units === 'F'`, it applies `v * 9/5 + 32` before formatting. This affects both the limit dropdown option labels and the Configuration Legend card values. The unit string shown in the UI (`°C` or `°F`) comes from `MSID_INFO[msid].units`.

### Data flow

```
init()
  └── fetch data/timbre_sources.json → [dir, dir, ...]
  └── sort by version (semver, descending); set _currentDataDir = sources[0]
  └── populate #sel-timbre-source dropdown
  └── attach selSource.change → update _currentDataDir + loadManifestAndSetup()
  └── attach selDate.change  → loadAndRender()
  └── attach selChips.change → loadAndRender()
  └── attach all limit selector change events → refilterAndRender()
  └── attach tab-shown listener: tab-lineplot-btn → re-render lineplot at correct width
  └── attach resize handler (debounced 150ms, re-renders both protractor and lineplot)
  └── loadManifestAndSetup(_currentDataDir)
        └── fetch data/${_currentDataDir}/manifest.json
        └── repopulate selDate + selChips dropdowns (innerHTML = '' first)
        └── updateLimitSelectorVisibility(manifest.limits)
              └── each [data-limit-col] div: display='' if col in limits, else display='none'
        └── loadAndRender()
              └── loadRaw(date, chips) → { rawLim, rawOff, meta }
                    └── fetchGz() — fetch + LRU-cache compressed ArrayBuffers
                         URL pattern: data/${_currentDataDir}/${date}_${type}_chips${chips}.json.gz
                    └── decompressAndParse() — DecompressionStream (skipped if bytes lack the gzip magic, i.e. server already decoded them) → NaN→null → JSON.parse
                    └── parseScenarioColumns()
              └── populateLimitDropdowns(rawLim)
                    └── each ALL_LIMITS entry: unique values sorted ascending; preserves
                         prior selection if still valid, else uses defaultVal if specified,
                         else picks middle value. aacccdpt_limit has defaultVal: -1.5.
              └── hiddenMsids.clear()
              └── refilterAndRender()
  └── fetch ./changelog.md (independent of data loading)
        └── parseChangelog(text) → [{title, meta:{}, params:[{param,values}]}]
        └── renderChangelogEntries(entries, #tab-changelog-content)

refilterAndRender()
  └── getSelectedLimits() → Map<col, numericValue>  (reads all visible limit selects)
  └── filterAndAggregate(rawLim, selectedLimits) → lim  (Uint8Array mask filter → min per pitch)
  └── filterAndAggregate(rawOff, selectedLimits) → off
  └── buildConditions(rawLim, selectedLimits) → [{label, value}]  (skips hidden limit divs)
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
        └── reapplies current hiddenMsids state to freshly built paths
  └── store _lastLineplotArgs = [lineplotContainer, lim, off, msids]
  └── renderConditionsLegend(conditions) → HTML grid in #legend-content, shows #legend-card
  └── renderTables(summary, msids, pitches) → builds two Bootstrap table cards into #tables-area
```

### Key constants (`app.js`)

#### `ALL_LIMITS`

Every limit column that may appear across any data source gets a UI dropdown. 15 entries in display order. The `defaultVal` field (optional) specifies the preferred initial value when no prior selection exists.

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
  { col: 'aacccdpt_limit',   msid: 'aacccdpt',   defaultVal: -1.5 },
  { col: 'pftank2t_limit',   msid: 'pftank2t'   },
  { col: 'pm2thv1t_limit',   msid: 'pm2thv1t'   },
  { col: 'pm1thv2t_limit',   msid: 'pm1thv2t'   },
  { col: '1pdeaat_limit',    msid: '1pdeaat'    },
  { col: 'tpc_fsse_limit',   msid: 'tpc_fsse'   },
  { col: 'tpcm_rw5_limit',   msid: 'tpcm_rw5'   },
];
```

Note: HRC limit columns use `2ceahvpt_limit_s` / `2ceahvpt_limit_i` (suffix after "limit"), unlike all other columns which use `<msid>_limit`. The `tpcm_rw5_limit` selector is hidden when the active data source is v3.73.1 (not present in that dataset).

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
  'tpcm_rw5':   { name: 'Reaction Wheel #5',       units: 'F' },
};
```

`MSID_COMMON_NAMES` is derived from `MSID_INFO` for backward-compatible use in render/table code.

#### `PREFERRED_ORDER`

Canonical inner→outer band render order. Only MSIDs in this list appear on the plot. Also used to assign stable colors in the line plot (index in `PREFERRED_ORDER` → index in `LINE_COLORS`):

```
'2ceahvpt_s', '2ceahvpt_i', 'pline03t', 'pline04t', '1dpamzt', '1deamzt',
'fptemp_11', '4rt700t', 'tpc_fsse', 'aacccdpt', 'pftank2t', 'pm2thv1t', 'pm1thv2t', '1pdeaat',
'tpcm_rw5'
```

`tpcm_rw5` is at the end. When the active data source is v3.73.1 (no `tpcm_rw5` data), `activeMsids()` will filter it out and it simply won't render — no code change required to handle the per-source model difference.

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

15-color palette, indexed by position in `PREFERRED_ORDER`. Assigned via `msidColor(msid)`:

```js
const LINE_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2',
  '#59a14f', '#edc948', '#b07aa1', '#ff9da7',
  '#9c755f', '#bab0ac', '#d37295', '#499894',
  '#f4e685', '#86bcb6', '#54a0c5',
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

Shared helper called by both `render()` and `renderLineplot()` when `activeMsids()` returns an empty array. Clears the container and injects an explanatory HTML message with three numbered notes about common conditions causing no data.

When `render()` calls `renderNoData()`, it still computes and returns `{ summary, msids: [], pitches }` so `refilterAndRender()` can pass empty msids to `renderLineplot()` and `renderTables()` without errors.

#### Gzip LRU cache

`_gzCache = Map<url, {buffer: ArrayBuffer, lastUsed: number}>`, max `GZ_CACHE_MAX = 20` entries. Stores compressed buffers (not decompressed data). Keys include the full URL path (including data directory), so switching data sources does not produce cache collisions.

### Module-level state

```js
let _loadedData       = null;  // { rawLim, rawOff, meta }
let _lastRenderArgs   = null;  // [container, lim, off, meta, conditions] — protractor resize
let _lastLineplotArgs = null;  // [container, lim, off, msids] — lineplot resize / tab-shown
let _currentDataDir   = null;  // currently selected timbre data directory name
const hiddenMsids     = new Set();  // MSIDs hidden in line plot via legend click
const _gzCache        = new Map();
```

`hiddenMsids` persists across `refilterAndRender()` calls (limit changes) but is cleared by `loadAndRender()` (date/chips/source changes).

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
- Y: dwell in seconds (raw data units), domain [0, yMax] where `yMax = min(data_max, 100000)` (capped at 100,000 seconds = 100 ksec). After D3 `.nice()`. Tick format: `d => `${d / 1000}k``. Label: "Dwell Duration (Kiloseconds)". Font size 16px.

**SVG layout:**
- `LEGEND_W = 170` (pixels reserved for the right-side legend column)
- `W = max((container.clientWidth || 900) - LEGEND_W, 400)` — SVG width only; legend sits beside it
- `H = round(W × 0.55)`
- `margin = { top: 84, right: 24, bottom: 50, left: 78 }`
- Explicit `width` / `height` attributes on SVG (not viewBox — unlike the protractor)
- `clipPath id="lp-clip"` rect of `iW × iH` applied to all line paths

**DOM structure inside `#lineplot-container`:**
```
wrapper div (flex row, align-items:flex-start)
  chartDiv (flex:0 0 auto)
    svg (W × H, explicit width/height)
  legendDiv (width:170px, padding-top:margin.top, flex column)
    composite min entry (non-clickable)
    one entry per active MSID (clickable, cursor:pointer)
notes div (below wrapper, padding-left:margin.left)
```

**Line encoding:**
- **Composite minimum** (non-HRC limited only): thick gray stroke, `stroke-width: 12`, color `#bbbbbb`, drawn first (behind all other lines).
- **Per-MSID limited:** solid, `stroke-width: 3`, color from `msidColor(msid)`.
- **Per-MSID offset:** dashed, `stroke-width: 2`, `stroke-dasharray: "5,3"`, same color as limited.
- HRC MSIDs ARE included in per-MSID lines but excluded from the composite minimum.
- `lineGen.defined(d => d.v != null && isFinite(d.v))` — null/NaN values create line breaks.

**Hover interactivity:**
Lines are rendered in two passes inside `linesG`:
1. **Visible pass** — limited and offset paths stored in `linesByMsid: Map<msid, {limPath, offPath, limData, offData}>`.
2. **Hit-area pass** — transparent `stroke-width:10` paths on top, `pointer-events:stroke`, `cursor:pointer`. Stored in `hitAreasByMsid: Map<msid, [limHitPath, offHitPath]>`.

On `mouseenter`: `limPath.stroke-width` → 6, `offPath.stroke-width` → 4, legend span → `font-weight:700`.
On `mouseleave`: restores stroke widths and clears font-weight.

**Legend toggle (click to hide/show):**
Each legend item (except Composite Min) is clickable. State is stored in module-level `hiddenMsids: Set<msid>`.

- **Hiding:** `hiddenMsids.add(msid)` → swatch turns `#ccc`, name turns `#bbb`, `limPath`/`offPath` get `display:none`, hit-area paths get `pointer-events:none` (prevents phantom hover on invisible lines).
- **Showing:** reverse of the above.
- **Persistence across re-renders:** `renderLineplot()` rebuilds from scratch on every call, but re-applies the current `hiddenMsids` state immediately after building paths, before returning. This ensures limit-selector changes preserve the hidden state.
- **Reset:** `loadAndRender()` calls `hiddenMsids.clear()` before rendering, so switching date/chips/source resets all visibility.

**Resize / tab-shown behavior:**
- `shown.bs.tab` on `#tab-lineplot-btn` → re-renders with stored `_lastLineplotArgs` at correct container width
- Window resize (debounced 150ms) → re-renders both protractor and line plot

---

### Changelog tab (`protractor/changelog.md`)

`changelog.md` is a manually maintained markdown file fetched at init time. It is independent of scenario data — it loads and renders even if data loading fails.

**Format:** one entry per `## ` header line. Entries are ordered newest-first (add at top). Never delete old entries.

```markdown
## 3.74.0 (7328a78)

**Promoted to flight:** YYYY-MM-DD
**Models version:** 3.74.0
**Hash:** 7328a78

| Parameter | Available Values |
|---|---|
| Date | Jul 1 2026, ... |
| Chips | 1, 2, 3, 4, 5, 6 |
| HRC-S CEA (°C) | 9.0, 9.5 |
...
```

**`parseChangelog(text)` — parsing rules:**
- Splits on `\n(?=## )` to isolate sections
- Within each section, `**Key:** value` lines before any table row are collected as `entry.meta`
- Table parsing uses a three-phase state machine: first `|` row = header (skipped), second = separator (skipped), subsequent = data rows → `entry.params[]`

**`renderChangelogEntries(entries, container)` — output structure:**
- Entry title: dark-blue bold `div`, 0.9rem
- Metadata: `flex` row of `<span>` elements at 0.75rem, `<strong>Key:</strong> value`
- Params: `<table>` with alternating `#f7f8fa` / `#fff` row backgrounds, 0.75rem
- Entries separated by `<hr>` with `border-color:#e5e7eb`

---

### HTML structure (`protractor/index.html`)

Fixed 260px dark sidebar + flex-grow `#main`.

**Top area layout** — `#content-area` is a flex row (`display:flex; gap:.75rem; align-items:stretch`) containing:

**Left card** (fixed `width:170px`, `flex-shrink:0`):
- Card header: "Configuration / Selection" (two-line, centered, `fw-semibold small`)
- Body: `#condition-bar` — all condition selects stacked vertically
- `#condition-bar { font-size: 0.8em; font-weight: bold }`, `#condition-bar select { font-size: 0.8em }`
- Each limit selector `<div>` has a `data-limit-col="<col>"` attribute used by `updateLimitSelectorVisibility()`

**Right column** (`flex:1; min-width:0; display:flex; flex-direction:column; gap:.75rem`):

  **Timbre Data Selection card** (`.card`, `flex-shrink:0`, `padding:.375rem .75rem`):
  - Inline flex row: "Timbre Data Selection" label + `#sel-timbre-source` select (`width:auto`)
  - Populated by `init()` from `timbre_sources.json`; default = highest version

  **Tabbed card** (`#protractor-panel`, `.card`, `flex:1; min-height:0`):
  - `#loading-state` — visible while fetching; hidden once `#chart-tabs` is shown
  - `#chart-tabs` — hidden until first render
    - Bootstrap tab nav: "Protractor" | "Line Plot" | "Changelog"
    - Tab pane `#tab-protractor` (default active): `#chart-container`
    - Tab pane `#tab-lineplot`: `#lineplot-container`
    - Tab pane `#tab-changelog`: `#tab-changelog-content`

  **Configuration Legend card** (`#legend-card`, `display:none` until first render):
  - 4-column CSS grid, one cell per visible condition (Date, Chips, visible limit selectors)
  - Hidden limit selectors are also omitted from this legend via `buildConditions()` skip logic

**Condition selects** (`id=sel-<col>`, `w-100`):
- `sel-date` — repopulated from manifest on every source/date/chips change
- `sel-chips` — repopulated from manifest on every source change
- 15 limit selects (`sel-<col>`) — populated by `populateLimitDropdowns()` after each fetch

**Condition select labels** (left card, top to bottom):
Date, Chips, HRC-S CEA (°C), HRC-I CEA (°C), Prop. Line #3 (°F), Prop. Line #4 (°F), ACIS DPA (°C), ACIS DEA (°C), ACIS FP (°C), OBA Fwd Bulkhead (°F), ACA CCD (°C), IPS Tank (°F), MUPS Thruster 1B (°F), MUPS Thruster 2A (°F), ACIS PSMC (°C), Fine Sun Sensor Elec. (°F), **Reaction Wheel #5 (°F)** *(hidden for v3.73.1)*

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
    a[data-bs-toggle=collapse, href="#md-collapse"] "Model Dashboard ▾"
    div#md-collapse.collapse
      ul#md-model-nav                  ← populated by JS after App.init()
```

After `App.init()`, the boot script fetches `../steady_states/data/manifest.json` and `../model_dash/data/manifest.json` and builds sidebar nav links. Both fail silently if manifests don't exist.

---

## App 2: Steady States (`steady_states/`)

### What it does

Shows Xija thermal model steady-state temperatures as multi-line dwell curves and summary tables. One model at a time, selectable from the sidebar. Single-page app (no page reload on model switch).

### Architecture

Since 2026-10-16 (`xija_steady_states` commit `66bd8f7`), `steady_states/index.html` and `steady_states/app.js` are **exact copies** of `../xija_steady_states/xija_steady_states/templates/index.html` and `app.js`, installed by that package's `--setup` (see Updating from xija_steady_states). The xija template *is* this Meridian page: Meridian sidebar with the Pitch Sensitivity link and the Steady States / Model Dashboard collapses, `?model=` deep links, `app.js` loaded from the page directory. Don't edit either file here; a change made here is overwritten by the next `--setup`. Make it in `xija_steady_states` and re-install. (Before 2026-10-16 the xija template was a standalone page and this `index.html` was a hand-merged Meridian variant, last synced at `faa9a5c`.)

`app.js` exposes a global `App` object with methods for loading manifest/metadata/chart data, rendering charts and tables, building controls HTML, pitch-resolution filtering, and handling URL params. The inline boot script in `index.html` builds the sidebar, wires the controls, and fills the Model Dashboard links from `../model_dash/data/manifest.json` (fails silently).

**Phone layout:** `#sidebar` carries Bootstrap's `offcanvas-md offcanvas-start`. At 768 px and wider it is the normal sticky sidebar; below that it is hidden and the ☰ Menu button (`data-bs-target="#sidebar"`) slides it in as a drawer with a close button, and picking a model closes it. The sticky/height rules live inside `@media (min-width: 768px)` (sticky positioning would break the drawer's `position: fixed`), and the sidebar background uses `!important` because `.offcanvas-md` forces a transparent background at md and up. The other two apps still have the broken Menu button this replaced (see Known Issues).

**Chart data is gzip-compressed** (`<nav_id>_<config_id>_<date>.json.gz`, temperatures at 2 decimals) since `xija_steady_states` 2026-10-15. `App.loadChartData` fetches the bytes and decompresses with `DecompressionStream('gzip')` when the file starts with the gzip magic bytes, and otherwise parses plain JSON, so it reads both old `.json` and new `.json.gz` data. `manifest.json`, `metadata.json` and all CSVs stay uncompressed.

### Pitch resolution (5° / 1°)

`xija_steady_states` writes `pitch_step` into each model's `metadata.json` (currently `1` for all models). When the data is finer than 5°, the page shows a "Pitch resolution" toggle in the controls row (`#resolution-col`) offering 5° (default) and 1°. Switching re-renders the chart and summary table from the in-memory cache via `App.filterChartByStep` / `App.filterTableCsvByStep`; nothing is refetched. The chosen step is kept when switching models. 5° data shows no toggle. In 1° mode, lines use a viridis gradient with a colour-bar legend, and the tooltip bolds the nearest curve (`.tt-nearest`).

### Updating from xija_steady_states

The steady-states site is developed in `../xija_steady_states/xija_steady_states/templates/`. Make changes there (with its tests), then install them into Meridian. From `meridian/`, in the `ska3-dev` environment:

1. **Page** (`index.html`, `app.js`):
   ```bash
   cd ../xija_steady_states/
   python -m xija_steady_states --setup --output-dir ../meridian/steady_states
   ```
   This copies `index.html` and `app.js` (always overwriting them), downloads any vendor file that is missing (D3 7.9.0, Bootstrap 5.3.3; files already present are skipped, so it runs offline), and deletes a stale `vendor/app.js` if one exists. It does not touch `data/`. Run it before step 2 whenever the reader changed: the current `app.js` reads both `.json` and `.json.gz`, but an older one cannot read new data.
2. **Data**:
   ```bash
   SKA=~/AXAFDATA/SKADATA python -m xija_steady_states --output-dir ../meridian/steady_states
   ```
   Without `--force` only missing per-date files are computed; summary tables and `metadata.json` are always rebuilt.
3. **Hard-refresh** the browser after a page update (see Browser caching below).

> ⚠️ **Never pass `--with-tests` with `--output-dir` pointing here.** It adds the QUnit browser suite (`tests.html`, `vendor/qunit.js`, `vendor/qunit.css`), and `build.py` copies all of `vendor/` into `dist/`. If it happens, delete those three files. `--setup --force` is safe but unnecessary: it only re-downloads the vendor libraries (needs internet).

Quick check that an update is complete:
```bash
diff -q steady_states/index.html ../xija_steady_states/xija_steady_states/templates/index.html   # no output
diff -q steady_states/app.js     ../xija_steady_states/xija_steady_states/templates/app.js       # no output
git status --short steady_states          # only index.html / app.js, if anything; no tests.html, vendor/app.js, vendor/qunit.*
ls steady_states/vendor                   # bootstrap.bundle.min.js  bootstrap.min.css  d3.min.js
```

### Browser caching after a deploy

`app.js` is loaded without a version tag, and `python -m http.server` (and most static hosts) let browsers cache it heuristically. After an update, a browser can combine the **new `index.html` with a stale cached `app.js`**: the boot script then calls functions that don't exist yet (e.g. `App.getResolutionOptions`), throws, and the page never finishes loading. This happened during the Oct 2026 1° update. Fix for a viewer: hard refresh (Cmd+Shift+R). See Known Issues for the permanent fix.

All data fetches are relative to the page URL — resolves correctly from `steady_states/`.

### Data location

`steady_states/data/` is generated by running `xija_steady_states` (see README.md). The app gracefully handles its absence — `loadManifest()` will reject and show an error. The protractor sidebar silently omits model links when the manifest fetch fails.

### URL param auto-selection

`init()` reads `?model=<nav_id>` from the URL. If the param matches a manifest entry, `selectModel()` is called immediately. This enables direct-linking from the protractor sidebar:
```
../steady_states/?model=aca
```

---

## App 3: Model Dashboard (`model_dash/`)

Full documentation lives in **`model_dash/handoff.md`** — read that file for everything related to this app. Brief summary:

- Displays historical thermal model performance: telemetry vs. time, scatter, error histogram, pitch-bin error traces, dwell exploration scatter, solarheat parameters, and ACIS DPA state power.
- One gzip-compressed JSON file per model in `model_dash/data/`, plus `manifest.json`. Data files are not in the repository — they must be generated by a separate pipeline and placed there.
- All rendering is in `app.js` (IIFE, ~1972 lines); `index.html` owns navigation and model switching.
- `config.js` provides per-model axis range and bin size overrides.

---

## Build Process (`build.py`)

Pure Python stdlib — no ska3-dev or other dependencies.

```
python build.py [--output-dir DIR] [--force]
```

Copies into `dist/` (or `DIR`):
- `protractor/` → `dist/protractor/` (whole directory, including `protractor/data/timbre_sources.json` and every `protractor/data/timbre_data_*/`)
- `steady_states/index.html`, `app.js`, `vendor/` → `dist/steady_states/`
- `steady_states/data/` → `dist/steady_states/data/` (warns but succeeds if absent)
- `model_dash/index.html`, `app.js`, `config.js`, `vendor/` → `dist/model_dash/`
- `model_dash/data/` → `dist/model_dash/data/` (warns but succeeds if absent)

Adding a new timbre data directory requires no changes to `build.py`: put it in `protractor/data/` and it is copied with the rest of `protractor/`. The directory must also be added to `protractor/data/timbre_sources.json` to be discovered by the app.

**Why protractor data lives in `protractor/data/`:** until Oct 2026 the `timbre_data_*/` directories and `timbre_sources.json` sat at the Meridian root and the app fetched them via `../`. They were moved so all three apps follow the same pattern (each app owns its `data/` subdirectory and fetches with relative `data/...` URLs). Don't move them back to the root; the app's fetch paths, `build.py`, and `.gitignore` all assume `protractor/data/`.

Vendor files are per-app — no shared copy. ~500 KB duplication is acceptable and avoids changing existing `vendor/` paths.

`handoff.md`, `data_file_structure.md`, and `reference.md` inside `model_dash/` are **not** copied to dist — developer documentation only.

---

## Deploy Process (`deploy.py`)

Runs, in order, stopping at the first failure:

```
deploy.py
  ├── check_environment()   all config problems reported together → exit 2
  ├── flock(.deploy.lock)   second concurrent run → exit 3
  ├── gen_steady_states()   (cd xija_repo) python -m xija_steady_states --output-dir <meridian>/steady_states [--force]
  ├── gen_model_dash()      python -m chandra_model_eval --trailing-days N model_dash/data <models_root> --log-file model_dash/data/run.log
  ├── build_site()          build.build(dist, force=True) → chmod 755/644 → delete .DS_Store
  └── deploy()              rsync -a -z -e "ssh -o BatchMode=yes" --itemize-changes dist/ <dest>/
```

Settings come from `deploy_config.json` (gitignored; template in `deploy_config.example.json`), overridable with `--dest` and `--model-days`. See README "Regenerating Data and Deploying" for the settings table, flags and an example crontab line. Logger name: `meridian.deploy`. Every subprocess line is re-logged at INFO with two-space indent; `--log-file` appends to a file as well as stderr.

**Design decisions:**
- **Must run under ska3-dev Python.** It runs both generators with `sys.executable`. `xija_steady_states` isn't installed in ska3-dev; it only imports when run from its own checkout, hence `xija_repo`. `chandra_model_eval` *is* installed in ska3-dev site-packages (non-editable), so changes in `~/AXAFLIB/chandra_model_eval` don't take effect until it is reinstalled.
- **Stop on any failure.** `chandra_model_eval` exits 1 if any single model fails. Deploying anyway would publish partial or mixed-age data, so nothing is synced.
- **Permissions are set in `dist/`, not by rsync.** macOS openrsync rejects `--chmod=D755,F644` and silently ignores the other `--chmod` forms. `rsync -a` then carries the normalized modes, which also prevents the execute-bit `old mode`/`new mode` noise seen on the server in Oct 2026.
- **No `--delete`.** The webroot may hold files Meridian doesn't own. Stale files must be removed by hand (see Known Issues for the current list).
- **`BatchMode=yes`.** Under cron, an SSH password or passphrase prompt would hang forever. With this, ssh fails immediately instead (`Permission denied`), rsync exits non-zero, and `deploy.py` exits 1.
- **`--dry-run` skips data generation** but still rebuilds `dist/`, so the itemized list reflects the current source tree.

**Normal log:** `── steady_states data ──`, the generator output, `done in Ns`, then the same for model_dash (its own detail goes to `model_dash/data/run.log`), the build's copy lines, the rsync `--itemize-changes` lines, and `finished in N min`. **Failure:** `ERROR FAILED: <module> exited with code N after Ns. Later steps were not run.` and exit 1.

**Runtime:** steady_states about 6 min for a full run (seconds to minutes when nothing is missing); model_dash about 1 min per model, about 14 min for 14 models; build about 5 s; first rsync of the 1.8 GB site depends on the link, later runs send only changed files.

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

---

## Data Tables

`renderTables(summary, msids, pitches)` builds two cards into `#tables-area`:

- Bootstrap `table table-sm table-striped table-bordered`, `font-size: 0.78rem`, horizontal scroll wrapper
- Columns: **Pitch** | one per active MSID | **Limiting Model** | **Composite Minimum**
- `null` → `"—"`, numbers → `toFixed(1)`
- Limiting Model and Composite Minimum exclude HRC MSIDs; first-wins on ties

Two tables: "Limited Dwell Times (sec)" and "Offset Dwell Times (sec)".

---

## Known Issues and Things to Revisit

### Model Dashboard: stale data causes missing cards on remote server (operational)

If `model_dash/data/` on the remote server was generated by an older version of `chandra_model_eval`, the "Error Segments by Pitch Bin" and "Dwell Exploration" cards silently don't render for non-ACIS models (propulsion lines, thrusters, etc.), while rendering correctly for ACIS models — with no error message. Root cause: older tool versions added `pitch_analysis`/`dwell_table` to ACIS model files before adding support for all models. Files from the older generation are 3–4× smaller. Check `model_dash/data/run.log` (present in `data/`, not in the repo) to confirm which generation is deployed. Fix: regenerate with current tool and redeploy. See `model_dash/handoff.md §18` for detailed diagnostics.

### Orphaned root-level timbre data on servers deployed before Oct 2026 (priority: low)

Deploys made before the move to `protractor/data/` put `timbre_data_*/` and `timbre_sources.json` at the webroot root. The current app no longer reads them, and syncing a new build without `--delete` leaves them in place. They're harmless but waste space and stay publicly browsable. Fix: after confirming the new build works (protractor loads data from `protractor/data/...`), delete the root-level `timbre_data_*/` and `timbre_sources.json` on the server by hand.

### Leftover `protractor/timbre_log/` on servers deployed before Oct 2026 (priority: low)

`protractor/timbre_log/` was a local scratch folder (clones of `sot/timbre` and `sot/chandra_models`, including their `.git/` directories). Older builds copied it into `dist/protractor/timbre_log/` because `build.py` copied all of `protractor/`. It has been deleted locally, and `build.py` now excludes `timbre_log` from the protractor copy, but a webroot deployed from an older build may still contain it. Fix: delete `protractor/timbre_log/` from the server by hand.

### Broken ☰ Menu button on phones in protractor and model_dash (priority: medium)

Below 768 px both apps hide `#sidebar` and show a `#mobile-nav-btn` "☰ Menu" button with `data-bs-target="#offcanvasSidebar"`, but no element has that id, so the button does nothing and a phone user cannot reach the sidebar (no switching models, data sources or apps). `steady_states/` had the same bug until 2026-10-16. Fix, as done there (see App 2 › Architecture › Phone layout): give `#sidebar` the classes `offcanvas-md offcanvas-start` and `tabindex="-1"`; point the button at `#sidebar`; move the sidebar's `position: sticky` / `height: 100vh` / `width` rules into `@media (min-width: 768px)` and drop the `display: none` rule for `#sidebar` below 768 px; set `--bs-offcanvas-width: 260px` and `background-color: #1e2937 !important` on `#sidebar`; optionally add a `btn-close btn-close-white d-md-none` button with `data-bs-dismiss="offcanvas" data-bs-target="#sidebar"`, and call `bootstrap.Offcanvas.getInstance(sidebar)?.hide()` after a sidebar selection. Check at ~375 px wide.

### `deploy.py` leaves local model_dash data mixed after a failed run (priority: low)

`chandra_model_eval` writes each model's `<msid>.json.gz` as it finishes. If a later model fails, `model_dash/data/` holds a mix of new and old files. The server is not touched (deploy stops), and the next successful run overwrites everything. Before running `deploy.py --skip-model-dash` after such a failure, check `model_dash/data/run.log`.

### Small site files are re-sent on every deploy (priority: low)

`build.py` copies `steady_states/` and `model_dash/` `index.html`/`app.js` with `shutil.copy`, which gives them a new modification time on each build, so rsync re-sends those four small files every time. Harmless. Fix if wanted: use `shutil.copy2`.

### Where the daily xija_steady_states cron writes is unknown (operational)

`xija_steady_states/HANDOFF.md` says a daily cron runs the generator somewhere, but its host and output directory aren't recorded. If it writes straight into the server's `steady_states/`, a `deploy.py` run overwrites it with this machine's copy (same generator, so normally the same data). Find that entry before scheduling `deploy.py` in cron, so the two don't fight.

### Stale cached `app.js` after deploys (all apps; priority: medium)

None of the apps version their script URLs (`<script src="app.js">`), so after a deploy a returning viewer's browser may run a cached old `app.js` against the new `index.html`. Symptom: the page loads its layout but never renders data, with a `TypeError: App.<fn> is not a function` (or similar) in the console. Confirmed on `steady_states/` during the 1° update. Workaround: hard refresh. Fix: add a version query string to local script/style URLs, e.g. `<script src="app.js?v=2026-10-14"></script>`, bumped whenever the file changes (or have `build.py` stamp a content hash into `dist/` copies so it can't be forgotten).

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
