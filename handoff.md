# Meridian – Development Handoff

This document captures the current state of the application in enough detail to recreate it from scratch using only `CLAUDE.md`, `data.md`, and `web_theme.md`. For data schema details see `data.md`; for project conventions, web stack, theme, and MSID common names see `CLAUDE.md`.

---

## What Exists

### Deliverable: `protractor/`

A self-contained, deployable single-page web app. Serve **from the project root** (`meridian/`) over HTTP — the app fetches data from `../data/` so the server root must be `meridian/`, not `protractor/`.

```
meridian/
├── data/
│   ├── manifest.json                            ← lists available dates and chips values
│   └── YYYY-DDD-00-00-00_<dwell_type>_chipsN.json.gz   ← 60 compressed scenario files
└── protractor/
    ├── index.html              ← Bootstrap shell, sidebar, condition bar, boot script
    ├── app.js                  ← IIFE App object — all logic
    └── vendor/
        ├── bootstrap.min.css
        ├── bootstrap.bundle.min.js
        └── d3.min.js
```

**Start server:** `python3 -m http.server 8765` from `meridian/`
**URL:** `http://localhost:8765/protractor/`
**Hard refresh:** `Cmd+Shift+R` (bypasses browser cache — required after `app.js` edits)

No build step is needed.

### What the App Does

Renders three things:

1. **Condition selectors** — a bar of dropdowns at the top of the plot card: Date, Chips, and 5 variable thermal limit dropdowns (ACIS FP, ACA CCD, Thruster 2A, Thruster 1B, Fine Sun Sensor). Changing Date or Chips triggers a network fetch + re-render. Changing a limit dropdown re-filters in memory and re-renders (no fetch).

2. **Constraint pitch sensitivity protractor plot** — a 135° arc showing, for each thermal model (MSID), whether a given pitch angle is a heating-limited region, a cooling-offset region, or neutral, and which non-HRC model is the active limiting constraint at each pitch. A conditions legend is drawn inside the SVG at the bottom edge listing all active limits (date, chips, all 14 limit values).

3. **Two data tables** below the plot — one for limited dwell times and one for offset dwell times, each with one row per pitch and one column per active MSID, plus computed "Limiting Model" and "Composite Minimum" summary columns.

---

## Architecture

### Data flow

```
init()
  └── fetch ../data/manifest.json
  └── populate date + chips dropdowns
  └── loadAndRender()
        └── loadRaw(date, chips)
              └── fetchGz() — fetch + LRU-cache compressed ArrayBuffers
              └── decompressAndParse() — DecompressionStream → NaN→null → JSON.parse
              └── parseScenarioColumns() — extracts raw.columns object
              └── returns { rawLim, rawOff, meta }
        └── populateLimitDropdowns(rawLim) — fills the 5 variable-limit selects
        └── refilterAndRender()
  └── attach change listeners (date/chips → loadAndRender; limits → refilterAndRender)
  └── attach resize handler (debounced 150ms, re-renders last args)

refilterAndRender()
  └── getSelectedLimits() → Map<col, numericValue>
  └── filterAndAggregate(rawLim, selectedLimits) → lim (one row per pitch)
  └── filterAndAggregate(rawOff, selectedLimits) → off (one row per pitch)
  └── buildConditions(rawLim, selectedLimits) → [{label, value}]
  └── render(container, lim, off, meta, conditions) → { summary, msids, pitches }
        └── detectMsids()        — output columns only (not metadata, not _limit suffix)
        └── buildPitchSummary()  — Map<pitch, Map<msid, {limMin, offMin}>>
        └── activeMsids()        — filters to PREFERRED_ORDER, skips entirely-null MSIDs
        └── findLimitingMsids()  — HRC excluded; per pitch: which MSID has lowest limMin
        └── draws bands, labels, ticks, title, legend, conditions legend via D3
        └── returns { summary, msids, pitches }
  └── renderTables(summary, msids, pitches)
        └── builds two Bootstrap table cards into #tables-area
```

### Data file structure

**`data/manifest.json`** — static index file:
```json
{
  "dates": ["2026-001-00-00-00","2026-091-00-00-00","2026-182-00-00-00","2026-274-00-00-00","2027-001-00-00-00"],
  "chips": [1, 2, 3, 4, 5, 6]
}
```

**`data/YYYY-DDD-00-00-00_<dwell_type>_chipsN.json.gz`** — 60 files (5 dates × 2 dwell types × 6 chips). Each is a gzip-compressed JSON file with schema `{ date, dwell_type, chips, columns: { col: [...] } }`. Contains literal `NaN` (not valid JSON) — must replace before `JSON.parse()`.

### Factorial data structure within each file

Each scenario file is a **full factorial grid**: rows = all combinations of the 5 variable limit values × all pitch values. A file with, e.g., 4 values per limit across 46 pitches has ~32–368 rows per pitch. The `filterAndAggregate` function:
1. Filters rows to those matching all 5 selected limit values (Uint8Array inclusion mask)
2. Reduces to one row per pitch using `min`

### Data source swap point

`loadRaw()` and `refilterAndRender()` are the only functions that need to change when switching data sources. The `render()` and `renderTables()` functions expect aggregated `{ pitch: [...], msid: [...], ...}` arrays.

### Gzip LRU cache

`_gzCache` is a `Map<url, {buffer: ArrayBuffer, lastUsed: number}>` holding at most `GZ_CACHE_MAX = 20` entries. Evicts the least-recently-used entry when full. Compressed buffers are stored (not decompressed data) to minimize memory. Decompression runs on every `refilterAndRender` call but is fast relative to network fetch.

### Angle geometry

Pitch maps directly to physical angle:
- `pitchToAngle(p) = (180 − p) × π / 180`
- `mathToD3(a) = π/2 − a` (converts math angle to D3 arc angle: 0=12 o'clock, CW)
- pitch 180 → 0° (horizontal right)
- pitch 90 → 90° (straight up)
- pitch 45 → 135° (45° above horizontal, upper-left)

---

## Key Constants (all in `app.js`)

### `MSID_INFO`

Replaces the old `MSID_COMMON_NAMES` dict. Maps each MSID to `{ name, units }` where `units` is `'C'` or `'F'`. Used everywhere a name or unit is needed.

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

Note: `tpc_fsse` is in `MSID_INFO` but **not in `PREFERRED_ORDER`** and therefore does not appear on the plot or tables. See Known Issues.

`MSID_COMMON_NAMES` is derived from `MSID_INFO` for backward-compatible use in render/table code:
```js
const MSID_COMMON_NAMES = Object.fromEntries(
  Object.entries(MSID_INFO).map(([k, v]) => [k, v.name])
);
```

### `PREFERRED_ORDER`

Canonical inner→outer band render order:
```
'2ceahvpt_s', '2ceahvpt_i', 'pline03t', 'pline04t', '1dpamzt', '1deamzt',
'fptemp_11', '4rt700t', 'aacccdpt', 'pftank2t', 'pm2thv1t', 'pm1thv2t', '1pdeaat'
```
Only MSIDs in this list are rendered. MSIDs absent from data or entirely null are silently skipped.

### `HRC_MSIDS`

`new Set(['2ceahvpt_s', '2ceahvpt_i'])` — drives special rendering and exclusions.

### `NON_OUTPUT_COLS`

`Set(['pitch', 'date', 'datesecs', 'dwell_type', 'chips', 'roll', '2ceahvpt'])` — columns never treated as MSID outputs.

### `VARIABLE_LIMITS`

The 5 limit columns that **vary within each scenario file** and have UI dropdowns:
```js
const VARIABLE_LIMITS = [
  { col: 'fptemp_11_limit',  msid: 'fptemp_11'  },
  { col: 'aacccdpt_limit',   msid: 'aacccdpt'   },
  { col: 'pm1thv2t_limit',   msid: 'pm1thv2t'   },
  { col: 'pm2thv1t_limit',   msid: 'pm2thv1t'   },
  { col: 'tpc_fsse_limit',   msid: 'tpc_fsse'   },
];
```

### `CONSTANT_LIMITS`

The 9 limit columns that are **constant across all rows and files** (no dropdown needed, but shown in conditions legend):
```js
const CONSTANT_LIMITS = [
  { col: '1dpamzt_limit',     msid: '1dpamzt'    },
  { col: '1deamzt_limit',     msid: '1deamzt'    },
  { col: '1pdeaat_limit',     msid: '1pdeaat'    },
  { col: '2ceahvpt_limit_s',  msid: '2ceahvpt_s' },
  { col: '2ceahvpt_limit_i',  msid: '2ceahvpt_i' },
  { col: '4rt700t_limit',     msid: '4rt700t'    },
  { col: 'pftank2t_limit',    msid: 'pftank2t'   },
  { col: 'pline03t_limit',    msid: 'pline03t'   },
  { col: 'pline04t_limit',    msid: 'pline04t'   },
];
```

Note: HRC uses non-standard column name format: `2ceahvpt_limit_s` / `2ceahvpt_limit_i` (suffix after "limit" rather than before).

### `COLORS`

```js
limited:        'rgb(228, 172, 164)'      // solid — rgba(220,80,60,0.40) composited over neutral
limitingFactor: 'rgba(200, 50, 30, 1.00)'
offset:         'rgb(168, 192, 220)'      // solid — rgba(70,130,200,0.40) composited over neutral
offsetSolid:    'rgb(156, 193, 226)'      // solid opaque blue for HRC offset overlay over red
neutral:        'rgba(180, 180, 180, 0.28)'
```

`limited`, `offset`, and `offsetSolid` are **fully opaque**. Translucent fills on adjacent arc segments produce sub-pixel seam artifacts. All colored arc paths also carry `.attr('stroke', <same color>).attr('stroke-width', 0.5)` to eliminate anti-aliasing seams.

---

## Rendering Details

### Layout

SVG viewBox is `W × H` where `H = W × 0.60`. The arc center `(cx, cy)` is positioned so that:
- `cy = H − marginBottom` (center sits near the SVG bottom edge)
- `cx = labelAreaW + outerR / √2` (outermost band's pitch=45 endpoint aligns with left label area boundary)

Layout regions:
- `marginTop = H × 0.12` — title space
- `marginBottom = H × 0.13` — breathing room below center
- `labelAreaW = W × 0.22` — MSID label area on the left
- `marginRight = W × 0.04`
- `pitchPad = 0.10` — fraction of outerR reserved outside arc for pitch tick labels

`outerR` = largest value fitting both `availH / (1 + pitchPad)` and `availW / (1.707 + pitchPad)`. The factor 1.707 comes from the arc's x-span: `outerR × (1 + 1/√2)`.

### Band geometry

- Inner bands start at `outerR × 0.25` — the inner 25% is intentionally empty (reserved for future use)
- `bandGap = max(0.8, outerR × 0.007)` between bands
- `bandW = (outerR − innerGap − bandGap × (nBands − 1)) / nBands`
- Band `bi`: `iR = innerGap + bi × (bandW + bandGap)`, `oR = iR + bandW`, `rMid = (iR + oR) / 2`

### Band rendering order (per band, per pitch)

1. **Neutral background** — single full-span arc, `rgba(180,180,180,0.28)`, no stroke
2. **Limited (light red)** — solid `rgb(228,172,164)` + matching stroke, wherever `limMin != null`
3. **Offset (light blue)** — different logic per MSID type:
   - Non-HRC: solid `rgb(168,192,220)`, only where `offMin != null AND limMin == null`
   - HRC: solid `rgb(156,193,226)`, wherever `offMin != null` (including pitches that also have `limMin`), drawn on outer half of band only (`iR = rMid`)
4. **Limiting factor (dark red)** — solid `rgba(200,50,30,1)`, wherever `limMin != null AND msid ∈ limiting set`

### HRC special cases

`HRC_MSIDS = {'2ceahvpt_s', '2ceahvpt_i'}`. Two behaviors differ from all other MSIDs:

1. **Offset rendering**: Every HRC offset pitch also has a limited value (100% overlap). The standard guard `limMin != null → skip offset` would suppress all HRC blue bars. For HRC, the guard is omitted. The offset arc uses only the outer half of the band (`iR = rMid`) and `offsetSolid` color.

2. **Excluded from limiting factor and composite minimum**: HRC is excluded from `findLimitingMsids()` and from table composite minimum/limiting model calculations.

### Limiting factor logic

`findLimitingMsids(summary, msids)` receives only non-HRC active MSIDs. At each pitch, finds the strictly lowest `limMin` and returns `Map<pitch, Set<msid>>`. Ties include all tied MSIDs.

**Critical**: must be called with `msids` (displayed, non-HRC), NOT `allMsids`. If called with `allMsids`, unrendered MSIDs like `tpc_fsse` (in data but not in `PREFERRED_ORDER`) can win the minimum at every pitch, suppressing all dark-red rendering.

### MSID labels

- Positioned at pitch=45 boundary (left edge of each band)
- `labelR = rMid − bandW × 0.35` along the pitch=45 radial direction
- `rotate(-45)` — text perpendicular to pitch=45 boundary, extending lower-left
- `text-anchor: 'end'` — right end of label touches arc boundary (with padding `max(6, labelFontSize × 0.75)`)
- `font-size = max(7, min(14, bandW × 0.72))`

### Pitch ticks

Ticks at `[45, 60, 75, 90, 105, 120, 135, 150, 165, 180]°`, drawn just outside `outerR`.

### Title and subtitle

Centered horizontally at `y = marginTop × 0.42` (title) and `y = marginTop × 0.72` (subtitle). Subtitle shows `meta.date` and `meta.chips` if available.

### Color legend

Top-right box with four color swatches. Position: `(W − boxW − 8, marginTop × 0.05)`.

### Conditions legend (inside SVG)

`drawConditionsLegend(svg, W, H, cy, pitchFontSize, conditions)` draws a full-width box at the **bottom of the SVG**, pinned `4px` above the SVG bottom edge (`by = H - boxH - 4`). Contains all 16 selected conditions:
- Date (human-readable, converted from DOY format via `doyLabel()`)
- Chips
- 5 variable limit values (with units: °C or °F from `MSID_INFO`)
- 9 constant limit values (with units)

Layout: 4 columns, `nRows = ceil(16/4) = 4` rows. Each entry is a `<text>` element with two `<tspan>` children: bold label + normal value. Box spans nearly full SVG width (`bx=4, bw=W-8`).

`buildConditions(rawLim, selectedLimits)` assembles the `[{label, value}]` array. Constant limit values are read from the first non-null value in `rawLim[col]`.

---

## HTML Structure (`index.html`)

Fixed 260px dark sidebar (`#1e2937`) + flex-grow `#main`.

### Condition bar (`#condition-bar`)

Seven label+select pairs inside `#protractor-panel.card`:
- `sel-date` — populated from `manifest.json` at init; options show human-readable date via `doyLabel()`
- `sel-chips` — populated from `manifest.json` at init; defaults to chips=4 if available
- `sel-fptemp_11_limit` — ACIS FP Limit (°C)
- `sel-aacccdpt_limit` — ACA CCD Limit (°C)
- `sel-pm1thv2t_limit` — Thruster 2A Limit (°F)
- `sel-pm2thv1t_limit` — Thruster 1B Limit (°F)
- `sel-tpc_fsse_limit` — Fine Sun Sensor Limit (°F)

Variable limit selects are empty on load; populated by `populateLimitDropdowns()` after the first fetch.

```
body (flex row)
├── #sidebar (sticky, 260px)
│   ├── .brand "Meridian"
│   └── nav > a#nav-protractor.active "Pitch Sensitivity"
└── #main (flex:1, padding 1.25rem, overflow-y:auto)
    ├── #mobile-nav-btn (hidden on desktop)
    └── #content-area
        ├── #protractor-panel.card
        │   ├── #condition-bar (7 label+select pairs)
        │   ├── #loading-state (spinner, hidden after load)
        │   └── #chart-container (display:none until load)
        └── #tables-area (populated by renderTables())
    └── #error-panel.alert.alert-danger (display:none until error)
```

Scripts loaded at bottom: `bootstrap.bundle.min.js`, `d3.min.js`, `app.js`, then `App.init()`.

---

## Data Tables

`renderTables(summary, msids, pitches)` builds two cards into `#tables-area`.

Each table:
- Bootstrap `table table-sm table-striped table-bordered`, `font-size: 0.78rem`, `width: 100%`
- Horizontal scroll wrapper
- Columns: **Pitch** | one column per active MSID | **Limiting Model** | **Composite Minimum**
- Header `<th>`: `white-space: wrap`, `text-align: center`, width hints (Pitch: 2.5rem, MSID cols: 2.5rem, Limiting Model: 5rem, Composite Min: 3.5rem)
- Value `<td>`: `white-space: nowrap`, right-aligned, `font-variant-numeric: tabular-nums`
- `null` → `"—"`, numbers → `toFixed(1)`
- **Limiting Model** and **Composite Minimum** exclude HRC MSIDs. First-wins on ties.

Two tables:
1. `Limited Dwell Times (ksec)` — uses `e.limMin`
2. `Offset Dwell Times (ksec)` — uses `e.offMin`

Tables re-render on every `refilterAndRender()` call.

---

## Module-level State (`app.js`)

```js
let _loadedData    = null;  // { rawLim, rawOff, meta } — raw columns, not aggregated
let _lastRenderArgs = null; // [container, lim, off, meta, conditions] for resize handler
const _gzCache     = new Map();  // URL → { buffer, lastUsed }
```

---

## Known Issues and Things to Revisit

### Label placement (priority: medium)

The `rotate(-45)` label approach works well for outer bands. For inner bands, labels may clip against the arc or extend near the SVG bottom edge on smaller screens. Options:
- Clip labels to the available label area using SVG `clipPath`.
- Shorten inner-band labels to abbreviations when band width is very small.

### `tpc_fsse` exclusion from plot

`tpc_fsse` (Fine Sun Sensor Elec.) is present in the data files, in `MSID_INFO`, and has a limit selector (`sel-tpc_fsse_limit`), but is not in `PREFERRED_ORDER` and therefore does not appear on the plot or tables. To add it: append `'tpc_fsse'` to `PREFERRED_ORDER`.

---

## Roadmap: Next Development Steps

### 1. Center area content

The inner 25% of the arc radius (`r < outerR × 0.25`) is intentionally reserved. Candidates:
- A composite minimum dwell time as a filled arc
- A radial axis showing dwell-time magnitude scale
- A sun-direction indicator

### 2. Interactivity

- **Hover tooltip**: MSID common name, pitch value, limited dwell time (ksec), offset dwell time
- **Band highlight**: clicking a band raises its opacity, dims others
- **Pitch crosshair**: radial line following the mouse across all bands simultaneously

### 3. Export

"Download SVG" or "Download PNG" button for PowerPoint slides.

### 4. Multi-condition overlay or faceting

Compare pitch sensitivity across dates or chips settings as overlaid plots or a faceted grid.

### 5. `tpc_fsse` on the plot

Add `'tpc_fsse'` to `PREFERRED_ORDER` to make it visible.
