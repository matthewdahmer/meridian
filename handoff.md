# Meridian – Development Handoff

This document captures the current state of the application in enough detail to pick up development without reading individual data files. Read alongside `CLAUDE.md` (conventions, MSID names, data schemas), `data.md` (protractor data format detail), `README.md` (dev/build/deploy workflows), and `web_theme.md` (CSS conventions).

---

## What Exists

### Site structure

Meridian is a static multi-page site with two apps served from a shared dev root:

```
meridian/
├── CLAUDE.md
├── data.md
├── README.md
├── web_theme.md
├── handoff.md
├── build.py                    ← assembles dist/ for deployment
├── data/                       ← protractor scenario data (do NOT read individual files)
│   ├── manifest.json           ← read freely; small index file
│   └── YYYY-DDD-*_chipsN.json.gz   ← 60 compressed JSON files
├── protractor/
│   ├── index.html
│   ├── app.js                  ← all logic, IIFE pattern
│   └── vendor/                 ← bootstrap.min.css, bootstrap.bundle.min.js, d3.min.js
└── steady_states/
    ├── index.html
    ├── app.js                  ← verbatim copy of ../xija_steady_states/templates/app.js
    ├── vendor/                 ← same vendor files as protractor/vendor/
    └── data/                   ← generated; do NOT read individual files (manifest.json OK)
        ├── manifest.json
        └── <nav_id>/...
```

**Dev server:** `python -m http.server 8765` from `meridian/` — no build step needed.

**URLs:**
- `http://localhost:8765/protractor/` — Pitch Sensitivity (Protractor) app
- `http://localhost:8765/steady_states/` — Steady States app

**Build for deployment:** `python build.py [--force]` → assembles `dist/`

---

## App 1: Protractor (`protractor/`)

### What it does

Three rendered outputs:

1. **Condition bar** — 16 dropdowns at top: Date, Chips, and 14 thermal limit selectors. Date/Chips → network fetch + re-render. Any limit → re-filter in memory + re-render (no fetch).

2. **Semicircular polar plot** — 135° arc (pitch 45–180°). One radial band per thermal model (MSID). Color coding: light red = limited dwell, dark red = active limiting constraint, light blue = offset, gray = neutral. HRC bands use half-width overlapping blue-over-red rendering.

3. **Two data tables** — below the plot. Limited dwell times and offset dwell times, one row per pitch, one column per active MSID, plus Limiting Model and Composite Minimum columns.

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
  └── attach resize handler (debounced 150ms, re-renders last args)

refilterAndRender()
  └── getSelectedLimits() → Map<col, numericValue>  (reads all 14 selects)
  └── filterAndAggregate(rawLim, selectedLimits) → lim  (Uint8Array mask filter → min per pitch)
  └── filterAndAggregate(rawOff, selectedLimits) → off
  └── buildConditions(rawLim, selectedLimits) → [{label, value}]
  └── render(container, lim, off, meta, conditions) → { summary, msids, pitches }
        └── detectMsids()        — output columns only (not metadata, not _limit suffix)
        └── buildPitchSummary()  — Map<pitch, Map<msid, {limMin, offMin}>>
        └── activeMsids()        — filters to PREFERRED_ORDER, skips entirely-null MSIDs
        └── findLimitingMsids()  — HRC excluded; per pitch: lowest limMin wins
        └── draws bands, labels, ticks, title, legend, conditions legend via D3
        └── returns { summary, msids, pitches }
  └── renderTables(summary, msids, pitches) → builds two Bootstrap table cards into #tables-area
```

### Key constants (`app.js`)

#### `ALL_LIMITS`

**Replaces the old `VARIABLE_LIMITS` + `CONSTANT_LIMITS` split.** Every limit column now gets a UI dropdown regardless of how many unique values it has. 14 entries in display order:

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
  { col: 'pm1thv2t_limit',   msid: 'pm1thv2t'   },
  { col: '1pdeaat_limit',    msid: '1pdeaat'    },
  { col: 'tpc_fsse_limit',   msid: 'tpc_fsse'   },
];
```

Note: HRC limit columns use `2ceahvpt_limit_s` / `2ceahvpt_limit_i` (suffix after "limit"), unlike all other columns which use `<msid>_limit`.

`populateLimitDropdowns(rawLim)` iterates `ALL_LIMITS` and reads unique non-null values from data for each. `getSelectedLimits()` reads all 14 selects. `buildConditions()` reads all values from `selectedLimits` (no longer reads raw data for "constant" limits).

#### `MSID_INFO`

Maps each MSID to `{ name, units }` where `units` is `'C'` or `'F'`. Used everywhere a name or unit is needed.

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
};
```

`MSID_COMMON_NAMES` is derived from `MSID_INFO` for backward-compatible use in render/table code.

#### `PREFERRED_ORDER`

Canonical inner→outer band render order. Only MSIDs in this list appear on the plot:

```
'2ceahvpt_s', '2ceahvpt_i', 'pline03t', 'pline04t', '1dpamzt', '1deamzt',
'fptemp_11', '4rt700t', 'aacccdpt', 'pftank2t', 'pm2thv1t', 'pm1thv2t', '1pdeaat'
```

Note: `tpc_fsse` is in `MSID_INFO` and `ALL_LIMITS` but **not** in `PREFERRED_ORDER` — it has a limit dropdown and appears in the conditions legend, but is not rendered as a band. See Known Issues.

#### `HRC_MSIDS`

`new Set(['2ceahvpt_s', '2ceahvpt_i'])` — drives special rendering and exclusions.

#### `NON_OUTPUT_COLS`

`Set(['pitch', 'date', 'datesecs', 'dwell_type', 'chips', 'roll', '2ceahvpt'])` — never treated as MSID outputs.

#### `COLORS`

```js
limited:        'rgb(228, 172, 164)'       // rgba(220,80,60,0.40) composited over neutral
limitingFactor: 'rgba(200, 50, 30, 1.00)'
offset:         'rgb(168, 192, 220)'       // rgba(70,130,200,0.40) composited over neutral
offsetSolid:    'rgb(156, 193, 226)'       // opaque blue for HRC overlay over red
neutral:        'rgba(180, 180, 180, 0.28)'
```

All colored fills are **fully opaque** (no SVG alpha). Translucent fills produce sub-pixel seam artifacts. All colored arc paths carry `.attr('stroke', <same color>).attr('stroke-width', 0.5)` to eliminate anti-aliasing seams.

#### Gzip LRU cache

`_gzCache = Map<url, {buffer: ArrayBuffer, lastUsed: number}>`, max `GZ_CACHE_MAX = 20` entries. Stores compressed buffers (not decompressed data). Decompression runs on every `refilterAndRender()` call but is fast relative to network fetch.

### Rendering details

#### Angle geometry

- `pitchToAngle(p) = (180 − p) × π / 180`
- `mathToD3(a) = π/2 − a` (D3 arc: 0=12 o'clock, CW)
- pitch 180 → 0° (horizontal right), pitch 90 → 90° (straight up), pitch 45 → 135° (upper-left)

#### SVG layout

ViewBox `W × H`, `H = W × 0.60`. Arc center `(cx, cy)` where `cy = H − marginBottom`.

- `marginTop = H × 0.12`, `marginBottom = H × 0.13`
- `labelAreaW = W × 0.22`, `marginRight = W × 0.04`, `pitchPad = 0.10`
- `outerR` = largest value fitting `availH / (1 + pitchPad)` and `availW / (1.707 + pitchPad)` (the 1.707 factor = 1 + 1/√2, the arc's x-span)

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
2. **Excluded from `findLimitingMsids()` and table composite minimum/limiting model**

#### Limiting factor logic

`findLimitingMsids(summary, msids)` receives only non-HRC active MSIDs (`msids`, not `allMsids`). Returns `Map<pitch, Set<msid>>` — the lowest `limMin` wins at each pitch; ties included.

**Critical**: must pass `msids` (displayed, non-HRC), NOT `allMsids`. If called with `allMsids`, unrendered MSIDs like `tpc_fsse` can win the minimum at every pitch and suppress all dark-red rendering.

#### MSID labels

- Positioned at pitch=45 boundary (left edge of each band)
- `labelR = rMid − bandW × 0.35` along the pitch=45 radial
- `rotate(-45)` — text perpendicular to arc, extending lower-left; `text-anchor: 'end'`
- `font-size = max(7, min(14, bandW × 0.72))`

#### Conditions legend

`drawConditionsLegend()` draws a full-width box pinned 4px above SVG bottom edge. 4 columns × 4 rows, 16 entries: Date, Chips, all 14 limit values (with °C/°F units from `MSID_INFO`).

### HTML structure (`protractor/index.html`)

Fixed 260px dark sidebar + flex-grow `#main`.

**Condition bar** (`#condition-bar`) uses Bootstrap `row g-2 align-items-end` with `col-auto` children — wraps naturally at container width:
- `sel-date` (min-width:145px) — populated from manifest at init, options via `doyLabel()`
- `sel-chips` (min-width:60px) — populated from manifest at init
- 14 limit selects (min-width:90px each, id=`sel-<col>`) — populated by `populateLimitDropdowns()` after first fetch

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

**Module-level state:**
```js
let _loadedData    = null;  // { rawLim, rawOff, meta }
let _lastRenderArgs = null; // [container, lim, off, meta, conditions]
const _gzCache     = new Map();
```

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

Vendor files are per-app — no shared copy. ~500 KB duplication is acceptable and avoids changing existing `vendor/` paths.

---

## Cross-Page Navigation

| From | To | Mechanism |
|---|---|---|
| Protractor sidebar | Steady States (specific model) | `<a href="../steady_states/?model=<nav_id>">` — full page load |
| Steady States sidebar | Protractor | `<a href="../protractor/">` — full page load |
| Steady States sidebar (model links) | Same page, different model | `selectModel()` — SPA, no reload |

Active link CSS: `color: #60a5fa; background: #1e3a56; border-left: 3px solid #3b82f6`. Applied to `#nav-protractor` on protractor page, to the selected model link on steady_states page.

---

## Data Tables

`renderTables(summary, msids, pitches)` builds two cards into `#tables-area`:

- Bootstrap `table table-sm table-striped table-bordered`, `font-size: 0.78rem`, horizontal scroll wrapper
- Columns: **Pitch** | one per active MSID | **Limiting Model** | **Composite Minimum**
- `null` → `"—"`, numbers → `toFixed(1)`
- Limiting Model and Composite Minimum exclude HRC MSIDs; first-wins on ties

Two tables: "Limited Dwell Times (ksec)" and "Offset Dwell Times (ksec)".

---

## Known Issues and Things to Revisit

### `tpc_fsse` not on the plot (priority: low)

`tpc_fsse` (Fine Sun Sensor Elec.) has an entry in `MSID_INFO`, a limit selector in the condition bar, and appears in the conditions legend — but is not in `PREFERRED_ORDER` and therefore not rendered as a band. To add it: append `'tpc_fsse'` to `PREFERRED_ORDER` in `app.js`.

### Label placement (priority: medium)

The `rotate(-45)` label approach works well for outer bands. For inner bands, labels may clip near the SVG bottom edge on smaller viewports. Options:
- Clip to label area using SVG `clipPath`
- Shorten inner-band labels to abbreviations when band width is very small

---

## Roadmap: Next Development Steps

### 1. Center area content

The inner 25% of the arc (`r < outerR × 0.25`) is reserved. Candidates:
- Composite minimum dwell time as a filled arc
- Radial axis showing dwell-time magnitude scale
- Sun-direction indicator

### 2. Interactivity

- **Hover tooltip**: MSID name, pitch, limited dwell (ksec), offset dwell
- **Band highlight**: clicking a band raises its opacity, dims others
- **Pitch crosshair**: radial line following the mouse across all bands

### 3. Export

"Download SVG" / "Download PNG" button for use in PowerPoint slides.

### 4. Multi-condition overlay or faceting

Compare pitch sensitivity across dates or chips as overlaid plots or a faceted grid.

### 5. `tpc_fsse` on the plot

Add `'tpc_fsse'` to `PREFERRED_ORDER` in `protractor/app.js`.
