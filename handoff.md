# Meridian – Development Handoff

This document captures the current state of the application in enough detail to recreate it from scratch using only `CLAUDE.md`, `data.md`, and `web_theme.md`. For data schema details see `data.md`; for project conventions, web stack, theme, and MSID common names see `CLAUDE.md`.

---

## What Exists

### Deliverable: `protractor/`

A self-contained, deployable single-page web app. Serve the directory over HTTP (e.g. `python3 -m http.server 8765`).

```
protractor/
├── index.html              ← Bootstrap shell, sidebar, boot script
├── app.js                  ← IIFE App object — all logic
├── limited_results.json    ← current data source (limit-dwell scenario)
├── offset_results.json     ← current data source (offset-dwell scenario)
└── vendor/
    ├── bootstrap.min.css
    ├── bootstrap.bundle.min.js
    └── d3.min.js
```

Refreshing the browser re-fetches `limited_results.json` and `offset_results.json` from disk. A hard refresh (`Cmd+Shift+R`) bypasses any browser cache. No build step is needed.

### What the App Does

Renders two things:

1. **Constraint pitch sensitivity protractor plot** — a 135° arc showing, for each thermal model (MSID), whether a given pitch angle is a heating-limited region, a cooling-offset region, or neutral, and which non-HRC model is the active limiting constraint at each pitch.

2. **Two data tables** below the plot — one for limited dwell times and one for offset dwell times, each with one row per pitch and one column per active MSID, plus computed "Limiting Model" and "Composite Minimum" summary columns.

---

## Architecture

### Data flow

```
init()
  └── loadData()
        └── fetches limited_results.json + offset_results.json in parallel
        └── fetchNaNSafeJSON() — replaces literal NaN with null before JSON.parse
        └── columnsOrientToArrays() — converts pandas orient='columns' to plain arrays
        └── returns { lim, off, meta }
  └── render(container, lim, off, meta) → { summary, msids, pitches }
        └── detectMsids()        — output columns only (not metadata, not _limit suffix)
        └── buildPitchSummary()  — Map<pitch, Map<msid, {limMin, offMin}>> using min across rows
        └── activeMsids()        — filters to PREFERRED_ORDER, skips entirely-null MSIDs
        └── findLimitingMsids()  — called with HRC excluded; per pitch: which MSID has lowest limMin
        └── draws bands, labels, ticks, title, legend via D3
        └── returns { summary, msids, pitches }
  └── renderTables(summary, msids, pitches)
        └── builds two Bootstrap table cards into #tables-area
```

### Data source swap point

`loadData()` is the **only function that needs to change** when switching from the two simple files to the multi-condition `./data/*.json` files. The returned shape `{ lim, off, meta }` must remain the same. See `data.md` for the `./data/` file schema.

### Angle geometry

Pitch maps directly to physical angle:
- `pitchToAngle(p) = (180 − p) × π / 180`
- `mathToD3(a) = π/2 − a` (converts math angle to D3 arc angle: 0=12 o'clock, CW)
- pitch 180 → 0° (horizontal right)
- pitch 90 → 90° (straight up)
- pitch 45 → 135° (45° above horizontal, upper-left)

### Key constants (all in `app.js`)

**`PREFERRED_ORDER`** — canonical inner→outer band render order:
```
'2ceahvpt_s', '2ceahvpt_i', 'pline03t', 'pline04t', '1dpamzt', '1deamzt',
'fptemp_11', '4rt700t', 'aacccdpt', 'pftank2t', 'pm2thv1t', 'pm1thv2t', '1pdeaat'
```
Only MSIDs in this list are rendered. MSIDs absent from data or entirely null are silently skipped.

**`HRC_MSIDS`** — `Set(['2ceahvpt_s', '2ceahvpt_i'])`. Module-level constant shared by both `render()` and `renderTables()`. Drives special rendering behavior and exclusions.

**`NON_OUTPUT_COLS`** — columns never treated as MSID outputs:
`pitch, date, datesecs, dwell_type, chips, roll, 2ceahvpt` (the last is a legacy unsuffixed column).

**`COLORS`**:
```js
limited:        'rgb(228, 172, 164)'    // solid — rgba(220,80,60,0.40) composited over neutral
limitingFactor: 'rgba(200, 50, 30, 1.00)'
offset:         'rgb(168, 192, 220)'    // solid — rgba(70,130,200,0.40) composited over neutral
offsetSolid:    'rgb(156, 193, 226)'    // solid opaque blue for HRC offset overlay over red
neutral:        'rgba(180, 180, 180, 0.28)'
```
`limited`, `offset`, and `offsetSolid` are **fully opaque** (no alpha < 1 except `neutral`). This is intentional: translucent fills on adjacent arc segments produce sub-pixel seam artifacts. The neutral background is a single continuous arc per band and does not have this problem.

All colored arc paths also carry `.attr('stroke', <same color>).attr('stroke-width', 0.5)` to eliminate any residual anti-aliasing seams at segment boundaries.

---

## Rendering Details

### Layout

SVG viewBox is `W × H` where `H = W × 0.60`. The arc center `(cx, cy)` is positioned so that:
- `cy = H − marginBottom` (center sits near the SVG bottom edge)
- `cx = labelAreaW + outerR / √2` (so the outermost band's pitch=45 endpoint aligns with the left label area boundary)

Layout regions:
- `marginTop = H × 0.12` — title space
- `marginBottom = H × 0.13` — breathing room below center (angled labels extend here)
- `labelAreaW = W × 0.22` — MSID label area on the left
- `marginRight = W × 0.04`
- `pitchPad = 0.10` — fraction of outerR reserved outside arc for pitch tick labels

`outerR` is set to the largest value that fits within both `availH / (1 + pitchPad)` and `availW / (1.707 + pitchPad)`. The factor 1.707 comes from the arc's x-span: `outerR × (1 + 1/√2)`.

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

1. **Offset rendering**: In the data, every pitch with an HRC offset value also has an HRC limited value (100% overlap). The standard guard `limMin != null → skip offset` would suppress all HRC blue bars. For HRC, the guard is omitted. The offset arc uses only the outer half of the band (`iR = rMid`) and a fully opaque color (`offsetSolid`) to prevent the red underneath from bleeding through.

2. **Excluded from limiting factor and composite minimum**: HRC is excluded from `findLimitingMsids()` (via `.filter(m => !HRC_MSIDS.has(m))`) and from the table composite minimum/limiting model calculations. These models are special cases that do not affect general dwell capability.

### Limiting factor logic

`findLimitingMsids(summary, msids)` receives only non-HRC active MSIDs. At each pitch, it finds the strictly lowest `limMin` among those MSIDs and returns a `Map<pitch, Set<msid>>`. Ties include all tied MSIDs.

**Critical**: must be called with `msids` (displayed, non-HRC), NOT `allMsids`. If called with `allMsids`, unrendered MSIDs like `tpc_fsse` (present in the data but not in `PREFERRED_ORDER`) can win the minimum at every pitch, suppressing all dark-red rendering.

### MSID labels

- Positioned at the pitch=45 boundary (left edge of each band's arc)
- Anchor: `labelR = rMid − bandW × 0.35` along the pitch=45 radial direction
  - The inward shift (smaller radius) moves the anchor slightly lower on screen, compensating for visual offset introduced by `dominant-baseline: 'middle'` on rotated text
- `rotate(-45)` — text runs perpendicular to the pitch=45 boundary, extending lower-left into the triangular whitespace between the pitch=45 line and the horizontal (pitch=180) line
- `text-anchor: 'end'` — right end of label touches the arc boundary (with a padding offset of `max(6, labelFontSize × 0.75)` pixels)
- `font-size = max(7, min(14, bandW × 0.72))`

### Pitch ticks

Ticks at `[45, 60, 75, 90, 105, 120, 135, 150, 165, 180]°`, drawn just outside `outerR` using `pitchLabelRoom = outerR × 0.10`.

### Title and subtitle

Centered horizontally in the SVG at `y = marginTop × 0.42` (title) and `y = marginTop × 0.72` (subtitle). Subtitle shows `meta.date` and `meta.chips` if available.

### Legend

Top-right box showing the four color states. Position: `(W − 160, marginTop × 0.05)`.

---

## Data Tables

`renderTables(summary, msids, pitches)` builds two cards into `#tables-area` (below the chart card in `index.html`). Cards have `margin-top: 2rem`.

Each table:
- Bootstrap `table table-sm table-striped table-bordered`
- Font size `0.78rem`, horizontal scroll wrapper
- Columns: **Pitch (°)** | one column per active MSID (common name header) | **Limiting Model** | **Composite Minimum**
- Values: `null` → `"—"`, numbers → `toFixed(1)`, right-aligned, `font-variant-numeric: tabular-nums`
- **Limiting Model** and **Composite Minimum** are computed excluding HRC MSIDs. First-wins on ties.

Two tables rendered:
1. `Limited Dwell Times (ksec)` — uses `e.limMin`
2. `Offset Dwell Times (ksec)` — uses `e.offMin`

Tables are rendered once at init. They do not re-render on window resize (only the SVG does).

---

## HTML Structure (`index.html`)

Fixed 260px dark sidebar (`#1e2937`) + flex-grow `#main` per `web_theme.md`.

```
body (flex row)
├── #sidebar (sticky, 260px)
│   ├── .brand "Meridian"
│   └── nav > a#nav-protractor.active "Pitch Sensitivity"
└── #main (flex:1, padding 1.25rem, overflow-y:auto)
    ├── #mobile-nav-btn (hidden on desktop)
    └── #content-area
        ├── #protractor-panel.card
        │   ├── #loading-state (spinner, hidden after load)
        │   └── #chart-container (display:none until load)
        └── #tables-area (populated by renderTables())
    └── #error-panel.alert.alert-danger (display:none until error)
```

Scripts loaded at bottom: `bootstrap.bundle.min.js`, `d3.min.js`, `app.js`, then `App.init()`.

---

## Known Issues and Things to Revisit

### Label placement (priority: medium)

The `rotate(-45)` label approach works well for outer bands. For inner bands, labels may clip against the arc or extend near the SVG bottom edge on smaller screens. Options:
- Clip labels to the available label area using SVG `clipPath`.
- Shorten inner-band labels to abbreviations when band width is very small.

### `tpc_fsse` exclusion

`tpc_fsse` (TPC FSSE) is present in the data files but is not in `PREFERRED_ORDER` and therefore does not appear on the plot or tables. To add it: append `'tpc_fsse'` to `PREFERRED_ORDER` and add `'tpc_fsse': 'TPC FSSE'` to `MSID_COMMON_NAMES`.

---

## Roadmap: Next Development Steps

### 1. Condition selector (multi-scenario data)

The `./data/` directory contains files across multiple dates × 2 dwell types × chips settings (see `data.md`). The UI needs:
- Sidebar controls (dropdowns or linked list) to select `date`, `chips`, and optionally `dwell_type`
- `loadData()` rewritten to enumerate available files, fetch and parse the selected `limit` and `offset` file pair, handle literal `NaN → null` pre-parse, and aggregate repeated pitch rows using `min`
- Chart title/subtitle should update to reflect the selected condition

### 2. Center area content

The inner 25% of the arc radius (`r < outerR × 0.25`) is intentionally reserved. Candidates:
- A composite minimum dwell time as a filled arc
- A radial axis showing dwell-time magnitude scale
- A sun-direction indicator

### 3. Interactivity

- **Hover tooltip**: MSID common name, pitch value, limited dwell time (ksec), offset dwell time
- **Band highlight**: clicking a band raises its opacity, dims others
- **Pitch crosshair**: radial line following the mouse across all bands simultaneously

### 4. Export

"Download SVG" or "Download PNG" button for PowerPoint slides. D3's SVG is already in the DOM; PNG export requires `canvas` + `drawImage`.

### 5. Multi-condition overlay or faceting

Compare pitch sensitivity across dates or chips settings as overlaid plots or a faceted grid.
