# Model Dashboard — Development Handoff

This document is self-contained: everything needed to continue development without prior knowledge.
Read alongside `../CLAUDE.md` (project conventions, MSID names, data schemas) and `../README.md`
(site structure, dev server, build process). This document covers **only** the Model Dashboard
(`model_dash/`).

---

## 1. Purpose

The Model Dashboard displays historical model performance for each Chandra thermal model. For a
selected model it shows up to six cards (each renders only if its data is present):

**Card 1 — Model Provenance:**
- MSID, units, active limit and limit type, all named limits, model spec MD5, GitHub URL
  (displayed as just the spec filename, linked to full URL), release version, date range.

**Card 2 — Performance Overview (quad plot):**
- Telemetry vs. time (observed temperature, model-predicted temperature, thermal limit lines)
- Telemetry vs. residual error (scatter with jitter, percentile curves, limits)
- Residual error vs. time (error time series)
- Residual error histogram (distribution with bin annotation, stat reference lines)

**Card 3 — Error Segments by Pitch Bin:**
- A vertical stack of error-vs-dwell-duration plots, one per pitch bin
- Each line is one historical dwell, colored by dwell start temperature (viridis scale)
- X axes are linked across all pitch-bin plots; Y axis is independently zoomable per bin
- Stats table to the right of each pitch-bin plot (error statistics from `pitch_bin_statistics`)
- Horizontal colorbar below the plot column mapping viridis colors to start temperature

**Card 4 — Dwell Exploration Plot:**
- User-configurable scatter plot of any `dwell_table` field vs. any other
- Dots colored blue→yellow→red by recency (oldest=blue, newest=red)
- Box zoom (drag) + double-click reset
- UI panel on the left for X/Y axis selection; defaults to `err_p95` vs `pitch`
- Any numeric array fields added to `dwell_table` in the data file automatically appear as
  axis options — no code changes required
- Legend footer showing date range with a matching gradient bar

**Card 5 — Solarheat Parameters vs Pitch:**
- One line per solarheat component group: solid P curve, dashed P+dP curve (same color per group)
- dP is interpolated onto P_pitches before being added (grids may differ)
- SimZDep variants produce one line pair per instrument (HRC-S, HRC-I, ACIS-S, ACIS-I)
- Right Y axis shows 3° pitch-bin dwell count histogram from `dwell_table`
- Hover on any data point shows P, dP, and P+dP values
- Legend below the plot (HTML, not SVG)

**Card 6 — ACIS DPA State Power:**
- Scatter plot of power (W) vs FEP count for each ACIS configuration state
- Points colored orange (clocking), blue (not clocking), or gray (wildcard clocking state)
- Horizontal jitter applied to integer FEP counts so overlapping points are visible; offsets
  are computed once at card creation and are stable across window resize redraws
- Hover tooltip shows state string, FEP count, clocking status, and power in watts
- Renders only if `dpa_power` is present in the data file (models with `AcisDpaStatePower` only)

The intent is to give thermal model owners a single view for assessing whether a model is tracking
well, detecting systematic biases, and spotting pitch-dependent or temperature-dependent drift.

---

## 2. File Structure

```
model_dash/
├── index.html              ← page shell: sidebar, model panel, Bootstrap wiring
├── app.js                  ← all application logic (IIFE, ~1972 lines)
├── config.js               ← per-model axis range / bin size overrides (ModelDashConfig)
├── data_file_structure.md  ← authoritative schema for *.json.gz files (read this first)
├── reference.md            ← xija component physics reference (SolarHeat, AcisDpaStatePower, etc.)
├── handoff.md              ← this file
├── data/
│   ├── manifest.json       ← list of models [{nav_id, display_name}, ...]
│   └── <nav_id>.json.gz    ← one per model, gzip-compressed JSON
└── vendor/
    ├── bootstrap.min.css
    ├── bootstrap.bundle.min.js
    └── d3.min.js
```

Never load vendor files from CDN. Copy from `protractor/vendor/` or `steady_states/vendor/` if
the directory needs to be reconstructed.

---

## 3. Dev Server

```bash
# From meridian/
python -m http.server 8765
# Navigate to: http://localhost:8765/model_dash/
```

No build step for development. Hard-reload (`Cmd+Shift+R` / `Ctrl+Shift+R`) after editing JS or
HTML to bypass browser cache — the dev server does not set cache-control headers.

---

## 4. Architecture

- **Pattern:** IIFE (`const App = (() => { ... })()`) returning a public object. All state and
  helpers are private to the closure.
- **Stack:** Vanilla JS, D3 v7, Bootstrap 5. No React, Vue, webpack, or build tools.
- **Public API** (called from `index.html`):

```js
App.loadManifest()                           // → Promise<[{nav_id, display_name}, ...]>
App.loadModelData(navId)                     // → Promise<raw data object>
App.renderQuadPlot(el, data, opts)           // → { setJitter(bool), setShowNormal(bool),
                                             //     setShowHighlight(bool), hasHighlight(),
                                             //     destroy() }
App.renderPitchErrorCard(el, data)           // → { destroy() }
App.renderDwellExplorationCard(el, data)     // → { destroy() }
App.renderSolarheatCard(el, data)            // → { destroy() }
App.renderDpaPowerCard(el, data)             // → { destroy() }
App._cache                                   // internal cache; read by index.html for display_name
```

`index.html` owns navigation, model switching, the jitter checkbox, the 215pcast_off highlight
checkboxes, loading/error states, and calling all render functions. `app.js` owns all D3 rendering.

---

## 5. Complete Data File Schema

The authoritative schema is in `data_file_structure.md`. Key sections relevant to the app:

```
{msid}.json.gz
│
├── msid              str    MSID name — must match MSID_DISPLAY_UNITS key for unit lookup
├── limit             float  Planning warning limit value
├── limit_type        str    "max" (hot model) or "min" (cold model)
├── all_limits        dict   Spec limits by name (see §10 for how these are parsed)
├── units             str    "degC" or "degF" — native unit in file; always degC for data arrays
│
├── datestart         str    First time step as Chandra date "YYYY:DDD:HH:MM:SS.sss" ← STRING
├── datestop          str    Last time step — THESE ARE DATE STRINGS, NOT TEMPERATURES
├── times             [float]  CXC seconds since 1998-01-01; ~328 s cadence
├── predicted         [float|null]  Model temperature, ALWAYS in °C in the file
├── observed          [float|null]  Telemetry temperature, ALWAYS in °C in the file
├── residuals         [float|null]  observed − predicted, ALWAYS in °C in the file
│
├── stats             dict   Global residual statistics (mean, std, rms, percentiles)
│
├── inputs            dict   Optional model input arrays, same length as times
│   └── '215pcast_off'  [int|null]  1 when 215PCAST was off; present only in 2ceahvpt files
│
├── violations        dict   Times/values where predicted exceeds the limit
│   ├── count / fraction
│   └── times / values
│
├── pitch_analysis           ← used by the pitch-error card (§9)
│   ├── plist         [float]  Pitch bin boundary values (degrees); N+1 values for N bins
│   ├── telem_bounds  [float, float]  [global_min, global_max] of observed temp, in °C
│   │
│   ├── metadata      dict   Per-bin dwell state records; keyed by string bin index "0".."N-1"
│   │   └── "N"       [row, ...]  Each row: {tstart (CXC sec), tstop, pitch, simpos, …}
│   │
│   ├── telem_segments  dict  Per-bin observed-temperature traces (NOT used by current app)
│   │   └── "N"       [[seg], ...]  Each seg = [[rel_seconds, temp_degC], …]
│   │
│   ├── err_segments  dict   Per-bin residual error traces
│   │   └── "N"       [[seg], ...]  Each seg = [[rel_seconds, error_degC], …]
│   │                               rel_seconds starts at 0 at dwell start
│   │
│   ├── segment_norm  dict   Per-bin dwell start temperature, normalized 0–1
│   │   └── "N"       [float, ...]  One scalar per dwell; 0=telem_bounds[0], 1=telem_bounds[1]
│   │
│   └── pitch_bin_statistics  dict  Per-bin summary stats; keyed by string bin index "0".."N-1"
│       └── "N"
│           ├── telem   dict  Observed-temperature statistics (currently NOT shown in tables)
│           └── error   dict  Residual error statistics — shown in stats tables
│               ├── mean, std, rms, max_abs  float
│               ├── p05, p50, p95            float  (p25, p75 exist but not shown)
│               ├── segment_mean_mean        float  Mean of per-dwell mean errors
│               ├── segment_mean_std         float  Std of per-dwell mean errors
│               ├── segment_drift_mean       float  Mean intra-dwell linear slope (units/ks)
│               └── segment_drift_std        float  Std of intra-dwell slopes
│
├── dwell_table       dict   Parallel lists, one entry per qualifying dwell (>1 hr, NPNT)
│   ├── tstart        [float]   Dwell start in CXC seconds (chronological)
│   ├── datestart     [str]     Per-dwell date strings (different from top-level datestart)
│   ├── pitch         [float]   Mean pitch during dwell (degrees)
│   ├── simpos        [int]     SIM-Z position
│   ├── obs_start_temp [float]  Observed temperature at dwell start (°C in file)
│   ├── obs_max_temp  [float]   Peak observed temperature during dwell (°C)
│   ├── obs_mean_temp [float]   Mean observed temperature during dwell (°C)
│   ├── err_mean      [float]   Mean residual over dwell (°C)
│   ├── err_max_abs   [float]   Max |residual| over dwell (°C)
│   ├── err_p95       [float]   95th percentile of |residual| over dwell (°C)
│   ├── err_end       [float]   Mean residual in last 20% of dwell — drift indicator (°C)
│   ├── n_points      [int]     Finite time steps in dwell
│   ├── pitch_bin     [int]     Pitch bin index (matches pitch_analysis dict keys as integers)
│   └── <any additional numeric arrays>  Automatically appear as dwell exploration axis options
│                                         (no code change required — auto-detected at render time)
│
├── analytics         dict   Pre-computed diagnostics (not yet rendered by any card)
│   ├── near_limit_threshold  float
│   ├── monthly       {all: {months, mean, std, n}, near_limit: {...}}
│   ├── error_by_temperature  {bin_edges, bin_centers, mean, std, p95_abs, n}
│   └── period_comparison     {split_date, all: {early, recent}, near_limit: {early, recent}}
│
├── solar_heat_components  [object, ...]  One entry per SolarHeat component (see §13)
│
└── dpa_power  dict   ACIS DPA state power (see §14); only present for models with AcisDpaStatePower
    ├── lookup  dict   State pattern → pre-computed power in watts
    │           Keys are 4-char strings: "[fep_count]xx[clocking]"
    │             First char: FEP count digit (0–6)
    │             Middle chars: "xx" (wildcards — CCD count and vid_board not distinguished)
    │             Last char: "1" = clocking, "0" = not clocking, "x" = wildcard (e.g. 0-FEP)
    │           Example: {"0xxx": 16.38, "1xx0": 28.15, "1xx1": 29.99, ..., "6xx1": 78.69}
    ├── mult    float  Parameter multiplier (stored for reference; lookup values are pre-computed)
    └── bias    float  Parameter bias (stored for reference; lookup values are pre-computed)
```

### Critical data format notes

- `observed`, `predicted`, `residuals`, and all `dwell_table` temperature/error fields are
  **always in °C** in the file, regardless of the MSID's display unit. The app converts at render
  time. `all_limits` values are **already in the correct display unit** (°F for °F models).
- Top-level `datestart`/`datestop` are **Chandra date strings**, not temperatures. Do not use them
  as colorbar bounds.
- `telem_bounds` is a **2-element array** `[min, max]`, not an object. Access as `tb[0]`, `tb[1]`.
- `err_segments` and related pitch_analysis dicts are **objects keyed by string bin index**
  ("0", "1", …), not arrays. The app normalizes these to arrays via `toArr()`.
- Each segment in `err_segments["N"]` is an **array of `[rel_seconds, error_degC]` pairs**,
  not an object with `.times`/`.errors` properties.
- `solar_params`, `p_names`, `dp_names` — these were old format fields superseded by
  `solar_heat_components`. They may still appear in old data files but should be ignored.

---

## 6. Unit Handling

### `MSID_DISPLAY_UNITS` table

Maps `data.msid` (= nav_id) to `'C'` or `'F'`. Default when absent is `'C'`.

```js
const MSID_DISPLAY_UNITS = {
  '2ceahvpt': 'C',   // HRC CEA
  '1dpamzt':  'C',   // ACIS DPA
  '1deamzt':  'C',   // ACIS DEA
  'fptemp':   'C',   // ACIS Focal Plane
  'aacccdpt': 'C',   // Aspect Camera CCD
  '1pdeaat':  'C',   // ACIS Elec. (PSMC)
  'pline03t': 'F',   // Propulsion Line #3
  'pline04t': 'F',   // Propulsion Line #4
  '4rt700t':  'F',   // OBA Forward Bulkhead
  'pftank2t': 'F',   // IPS Fuel Tank
  'pm2thv1t': 'F',   // Thruster 1B
  'pm1thv2t': 'F',   // Thruster 2A
  'tpc_fsse': 'F',   // TPC FSSE
  'tpcm_rw5': 'F',   // TPCM RW5
};
```

### Quad plot conversion: `prepareDisplayData(rawData)`

Called at the top of `renderQuadPlot` before any chart factory runs. Returns a new object
(shallow spread + new arrays) for °F models:

```
observed[i]  → observed[i] * 1.8 + 32    (temperature — offset matters)
predicted[i] → predicted[i] * 1.8 + 32
residuals[i] → residuals[i] * 1.8        (delta — no +32 offset)
units        → 'degF'
```

Limits in `all_limits` are **not touched** — they are already in the display unit.

The `inputs` field (including `215pcast_off`) is preserved on the returned object because
`prepareDisplayData` does a shallow spread (`{ ...data, ... }`). Index alignment between
`inputs['215pcast_off']` and `observed`/`residuals` is maintained.

### Pitch error card conversion

`renderPitchErrorCard` applies its own conversion directly (does not call `prepareDisplayData`):

```js
const errToF = v => (v === null || !isFinite(v)) ? v : v * 1.8;
// Applied per segment: seg.map(d => errToF(d[1]))  — the error value
// telem_bounds conversion: tb[i] * 1.8 + 32  — temperature, needs +32 offset
```

Pitch error stats (`buildStatTable`) use two helpers:
- `absV(v)` — absolute temperature values: `v * 1.8 + 32` for °F (e.g. a temperature reading)
- `relV(v)` — relative/delta values: `v * 1.8` for °F (errors, stds, slopes)

Since `pitch_bin_statistics.error` fields are all residuals (deltas), every value in the stats
table uses `relV`. Do not use `absV` for error statistics — it would add 32 incorrectly.

### Dwell exploration card conversion

`renderDwellExplorationCard` converts inline via `toDisp(val, utype)`:
- `utype === 'temp'`: `val * 1.8 + 32` for °F
- `utype === 'err'`:  `val * 1.8` for °F
- Other utypes: `val` unchanged

Auto-detected fields (keys in `dwell_table` not in the hardcoded `ALL_FIELDS` list) are assigned
`utype: null` and are **not unit-converted**. If a new temperature or error field is added to
`dwell_table` and needs conversion, add it explicitly to `ALL_FIELDS` with the correct `utype`.

### Solarheat card

No unit conversion. Solarheat values (P, dP) are dimensionless heating coefficients — they are not
temperatures and do not need °C→°F conversion regardless of model display unit.

### DPA power card

No unit conversion. Power values are in watts and FEP counts are integers; neither depends on
temperature units.

**Important:** All render functions receive the **raw cached data object** from `loadModelData`.
Each converts locally. Never pass pre-converted data — double conversion results.

---

## 7. Quad Plot Card

`renderQuadPlot(container, data, opts)` creates a 2×2 CSS grid:

```
┌────────────────────────────┬──────────────┐
│  Telemetry + Model vs Time │  Telem vs    │
│  2fr wide × 2fr tall       │  Error       │
│                            │  1fr wide    │
├────────────────────────────┼──────────────┤
│  Error vs Time             │  Error       │
│  2fr wide × 1fr tall       │  Histogram   │
└────────────────────────────┴──────────────┘
```

CSS: `grid-template-columns: 2fr 1fr; grid-template-rows: 2fr 1fr; gap: 6px; height: 100%`

Card body height: `calc(100vh - 130px)` set in `index.html`.

### Shared axis extents

`renderQuadPlot` pre-computes `sharedTempExt` and `sharedErrorExt` from the full data before
constructing any chart. These are injected via `cfg` so paired charts start at identical domains
and reset identically on double-click:

- `sharedTempExt` (4% padded) → used by time series (Y) and scatter (Y)
- `sharedErrorExt` (4% padded) → used by scatter (X) and histogram (X)

If a `tempRange` or `errorRange` override is present in `ModelDashConfig`, those values are used
instead of the auto-computed extents.

### SVG scaffold: `initSvg(el, margin)`

Every chart calls this at the start of `draw()`. It:
1. Reads `el.getBoundingClientRect()` for pixel size
2. Creates or reuses an `<svg>`, clears with `.selectAll('*').remove()`
3. Sets `viewBox` + `preserveAspectRatio="none"` (fills the cell without letterboxing)
4. Returns `{ svg, defs, g, w, h }` — `g` is the inner group, already translated by margin

Charts fully redraw on every `draw()` call. State (zoom domains, jitter values) lives in the
closure, not in the DOM.

### Axis linking: `makeLinks()`

Returns `{ sub(channel, fn), pub(channel, val, src) }`. The `src` parameter prevents echo-back
to the chart that published.

| Channel  | Subscribers             | Publishers      |
|----------|-------------------------|-----------------|
| `timeX`  | Time series, Error-time | Either          |
| `tempY`  | Time series, Scatter    | Either          |
| `errorX` | Scatter, Histogram      | Either          |

A **separate** `makeLinks()` instance is created for the pitch-error card — completely independent
from the quad plot's links. The dwell exploration, solarheat, and DPA power cards have no linked
axes.

### Chart factory details

**`makeTimeSeriesChart`**
- Margin: `{ top: 28, right: 30, bottom: 52, left: 85 }`
- Samples to `MAX_TS_PTS = 8000` points
- Tick font 16px, Y axis label 20px, limit line labels 14px
- Legend: clickable, cycles through 4 corners on click (bottom-right → bottom-left → top-left →
  top-right). State (`tsLegCorner`) is a closure variable that survives redraws. The legend is
  rendered **after** `addBrushZoom` so it sits above the brush overlay in SVG z-order and
  receives click events. Each corner snaps 12px inward from the axis lines. Clicking calls
  `event.stopPropagation()` to prevent the brush from also firing.
- Publishes `timeX` + `tempY` on brush; subscribes to both
- 215pcast_off overlay: when `cfg.hl` is present and `showHighlight` is true, draws charcoal
  (#374151) vertical line segments connecting obs to pred at each hl=1 point, plus 3px charcoal
  dots at obs and pred positions. Normal lines suppressed when `showNormal` is false.

**`makeScatterChart`**
- Margin: `{ top: 36, right: 30, bottom: 52, left: 85 }`
- Samples to `MAX_SC_PTS = 6000` points
- Color: `d3.scaleSequential(t => d3.interpolateRdYlBu(1 - t))` — blue (old) → yellow → red (new)
- Good/Bad labels placed in SVG coordinates in the top margin (above `g`, at `margin.top - 8` in
  SVG space) to avoid overlapping limit lines inside the plot area
- Pre-computed jitter offsets (stable across redraws): `jitterVals = obs.map(() => getJitter())`
- P1/P50/P99 percentile step-curves (curveStepBefore); filtered to visible Y domain before render
- Publishes `errorX` + `tempY` on brush; subscribes to both
- **Hover**: nearest-point search across all `pts` in pixel space (squared Euclidean distance,
  O(N) where N ≤ 6000). Tooltip reports cursor-interpolated Error and Temp, plus the date
  (YYYY-MM-DD) of the nearest data point. Each point in `pts` carries `t: ts[i]` (CXC seconds)
  for this purpose.
- 215pcast_off overlay: when `cfg.hl` is present and `showHighlight` is true, draws 3px charcoal
  dots on top of the normal scatter for hl=1 points. Normal dots/percentile lines suppressed when
  `showNormal` is false.

**`makeErrorTimeChart`**
- Margin: `{ top: 24, right: 30, bottom: 52, left: 80 }`
- Samples to `MAX_TS_PTS = 8000` points
- Zero-error reference line (dashed `#9ca3af`)
- Brush publishes `timeX` only (1D horizontal zoom linked with time series). **Both X and Y** are
  zoom axes: Y zoom updates the local `errExt` and is **not** published to any channel.
- Subscribes to `timeX` only
- 215pcast_off overlay: when `cfg.hl` is present and `showHighlight` is true, draws 3px charcoal
  dots at hl=1 residual values. Normal error line suppressed when `showNormal` is false.

**`makeHistogramChart`**
- Margin: `{ top: 24, right: 30, bottom: 52, left: 85 }`
- Bin count: `clamp(10, 80, ceil(log2(N)) + 1)` (Sturges' rule)
- `histBinSize` override in config: pre-computes fixed threshold array from the full extent so
  bin widths don't change when the user zooms — without this fix, zooming recomputes bins from
  the zoomed domain and produces wildly different bin sizes
- Cumulative percentile shown in hover tooltip
- Bin size annotation in top-right of plot area (inside the inner `g`, not clipped)
- Subscribes to `errorX` only; publishes `errorX` on brush
- **215pcast_off overlay**: charcoal (#374151) bars using the same `binGen` as normal bars so bin
  edges align exactly. `hlRes` and `sortedHlRes` are computed outside `draw()` from
  `data.residuals` filtered to indices where `cfg.hl[i] === 1`.
- **Dynamic Y ceiling**: `maxCount = Math.max(1, showNormal ? normalMax : 0, showHighlight && hlBins.length ? hlMax : 0)`.
  When only one dataset is visible, the Y axis rescales to fit it. This ensures the 215pcast_off
  bars fill the plot when normal data is hidden, instead of appearing as a thin strip at the bottom.
- **Stat reference lines**: five dashed vertical lines drawn inside the clip group after the bars:
  - Min (red `#dc2626`), p5 (gray `#9ca3af`), Mean (charcoal `#374151`), p95 (gray), Max (red)
  - Labels use `transform="translate(sx+3, 4) rotate(90)"` with `text-anchor:start` so text reads
    top-to-bottom just to the right of the line, starting near the top of the plot area
  - Format: `"Label: value"` e.g. `"Mean: 0.012"`
  - `sortedRes` and `sortedHlRes` are computed once outside `draw()` (sorted for `d3.quantile`)
  - When `showHighlight && !showNormal && sortedHlRes.length > 0`, stats are computed from
    `sortedHlRes`/`hlRes`; otherwise from `sortedRes`/`validRes`

### 215pcast_off highlight feature

This feature is **exclusive to the `2ceahvpt` model family**. The guard in `renderQuadPlot`:

```js
const hlArr = (data.msid ?? '').startsWith('2ceahvpt')
  ? (data.inputs?.['215pcast_off'] ?? null)
  : null;
```

`hlArr` is `null` for every other model, so all four chart factories receive `cfg.hl = null`
and the highlight code paths never execute for other models.

All four charts receive `cfg.hl = hlArr`. Each factory has two closure-level boolean state
variables: `showNormal` (default `true`) and `showHighlight` (default `true`). These are exposed
via `setShowNormal(v)` and `setShowHighlight(v)` on the return object. `renderQuadPlot` proxies
both setters to all four charts simultaneously.

`hasHighlight()` on the `renderQuadPlot` return value returns `!!hlArr`. `index.html` uses this
to show/hide the `#hl-controls` checkbox group.

### Highlight controls in `index.html`

The two checkboxes are wrapped in `<div id="hl-controls" class="d-flex ... d-none">`. The
`d-none` class (Bootstrap: `display: none !important`) is used for initial and hidden state.
**Do not use `style.display = 'none'` to hide this element.** Bootstrap's `.d-flex` applies
`display: flex !important`, which overrides a plain inline `display: none`. The correct
show/hide pattern is:

```js
// Show:
hlControls.classList.remove('d-none');

// Hide:
hlControls.classList.add('d-none');
```

On model selection, `selectModel` resets both checkboxes to `checked = true` before showing or
hiding the controls. This ensures a clean state when switching back to the `2ceahvpt` model.

### `renderQuadPlot` public API (full)

```js
{
  setJitter(v)        // toggles scatter jitter
  setShowNormal(v)    // toggles normal data in all four charts
  setShowHighlight(v) // toggles 215pcast_off overlay in all four charts
  hasHighlight()      // true only for 2ceahvpt (hlArr !== null)
  destroy()           // disconnects ResizeObserver (container cleared by qc.innerHTML = '')
}
```

---

## 8. Jitter and Percentile Lines

### `computeJitterSetup(observed)`

Computes a jitter band from the mean of absolute differences between consecutive observed values:

```js
diffs = [|obs[i] - obs[i-1]| for consecutive non-null pairs if |diff| > 0]
band  = mean(diffs) / 2
getJitter = () => Math.random() * 2 * band - band
binStep   = band * 2
```

Fallback: if no nonzero diffs exist, `band = 0.5`.

This runs on already-converted display-unit data (°F for °F models, °C otherwise), so the jitter
band is in display units.

### `computePercentiles(observed, residuals, step)`

Bins observed values into buckets of width `step` (rounded to nearest `step`), collects residuals
per bucket, sorts, and returns P1/P50/P99 per bucket. These drive the scatter plot step-curves.

---

## 9. Error Segments by Pitch Bin Card

### Overview

`renderPitchErrorCard(container, rawData)` creates a Bootstrap card below the quad plot. It
renders a vertical stack of error-vs-dwell-duration plots, one per pitch bin, with linked X axes,
a stats table to the right of each plot, and a shared horizontal colorbar below the plot column.

Early-exit cases (returns `{ destroy: () => {} }`):
- `rawData.pitch_analysis` is absent
- `pitch_analysis.plist` is absent or fewer than 2 entries
- `pitch_analysis.err_segments` is absent

### Data access path

```js
const pa = rawData.pitch_analysis;
pa.plist            // [float] — N+1 pitch boundaries → N bins
pa.telem_bounds     // [min_degC, max_degC] — colorbar temperature range (2-element array)
pa.err_segments     // {"0": [[seg], …], "1": …} — error traces per bin
pa.segment_norm     // {"0": [norm0, norm1, …], "1": …} — viridis color value per dwell
pa.metadata         // {"0": [{tstart, tstop, pitch, …}, …], "1": …} — dwell metadata
pa.pitch_bin_statistics  // {"0": {telem: {…}, error: {…}}, …} — per-bin stats for tables
```

### Object-to-array normalization

All pitch_analysis dicts are plain objects keyed by string bin index ("0", "1", …). The helper:

```js
const toArr = (obj, n) => Array.isArray(obj)
  ? obj
  : Array.from({ length: n }, (_, i) => obj?.[i] ?? obj?.[String(i)] ?? []);
```

converts them to JS arrays indexed 0..nBins-1.

### Segment unpacking

Each `err_segments["N"][si]` is an **array of `[rel_seconds, error_degC]` pairs**:

```js
[[0, -0.357], [328, -0.363], [656, -0.368], …]
```

Unpacked into segment objects used by `makePitchBinChart`:
```js
{
  times:        seg.map(d => d[0]),                         // dwell-relative seconds
  errors:       isF ? seg.map(d => errToF(d[1])) : seg.map(d => d[1]),
  segment_norm: binNorm[si],                                // 0–1 viridis color value
  date:         cxcToDate(binMeta[si].tstart).toISOString().slice(0, 10),
}
```

### Layout constants

All constants live in `renderPitchErrorCard` (not exported):

```js
const SUB_H      = 65;    // subplot height in px (non-last bins)
const GAP        = 4;     // vertical gap between rows in px
const LAST_EXTRA = 52;    // extra px on the last row for X axis ticks + label
const MARGIN     = { top: 3, right: 6, left: 150 };  // shared SVG margin (no bottom — varies)
```

Bottom margin per row:
- Non-last bins: `bottom = 4` (just enough for tick marks to clear)
- Last bin: `bottom = LAST_EXTRA = 52` (provides room for X axis ticks and the "Dwell Duration"
  label)

### Row structure

Each bin row is a full-width flex row `[subEl 66.67%] [tableEl flex:1]`:

```
rowEl (position:relative; height:divH)
  ├── subEl  (width:66.67%; height:100%)  ← makePitchBinChart renders SVG here
  ├── tableEl (flex:1; height:100%)       ← buildStatTable renders stats here
  └── rowRule (position:absolute; bottom:ruleBottom; left:0; right:0; height:1px)
```

The `rowRule` spans the full row width (plot + table) so the separator line underlines both.
For non-last bins, `ruleBottom = 0` (very bottom of the 65px row). For the last bin,
`ruleBottom = LAST_EXTRA - GAP = 48` (just below the x-axis, above the label area).

### `buildStatTable(el, bi, ruleBottom)`

Reads `pitch_bin_statistics[String(bi)].error` and renders three column-groups:

```
Group 1        Group 2    Group 3
Mean           5%         Mean (segment_mean_mean)
Std            50%        Mean Std (segment_mean_std)
RMS            95%        Drift Mean (segment_drift_mean)
Max Abs                   Drift Std (segment_drift_std)
```

All values use `relV()` (multiply by 1.8 for °F, no offset) because they are all residuals
(deltas), not absolute temperatures.

The `outer` div uses `align-items:flex-end` + `padding-bottom = ruleBottom + 9` so table content
sits 9px above the rule line in both last and non-last rows.

### `makePitchBinChart(el, opts, links)`

Factory for a single pitch-bin subplot. Margin is the per-row margin (computed above).

**Axes:**
- X: `d3.scaleLinear`, domain `[0, timeCap]` (default 80000 s). Only shown on last subplot.
  Ticks formatted as `d => `${d / 1000}k``. Tick font 16px, axis label 18px.
- Y: 3 ticks. Tick font 14px.

**Pitch label:** Horizontal text right-aligned at `x=-48, y=h/2` inside the left margin,
font 15px. Shows `"45°–60°"` format.

**Brush/zoom:**
- X → clamped to `[0, timeCap]`, published to `pitchTimeX` channel (all plots update)
- Y → updates local `errExt` only (not shared — each plot has its own independent Y domain)
- Double-click resets both X and Y to full extents, publishes reset X

**Hover:** Finds nearest `[time, error]` point across all segments at the cursor X position
(nearest in the time axis, not 2D distance). Tooltip shows pitch range, error value, and dwell
start date from `metadata[bi][si].tstart`.

**Zero-error line:** Horizontal `#d1d5db` line at y=0 when `errExt` spans zero.

**Color:** `d3.interpolateViridis` — viridis scale, using `segment_norm` values. Note: this is
different from the quad plot and dwell exploration card which use RdYlBu.

### `renderPitchColorbar(container, colorSc, tempRange, units, margin)`

Draws a **horizontal** viridis gradient bar with a D3 bottom axis. Placed in a `66.67%`-wide div
below the row stack (aligned with the plot column, not the stats column).

Parameters:
- `margin` — the shared `MARGIN` object; `left` and `right` are used for bar insets so the bar
  aligns with the plot left edge
- `tempRange` — `[tMin, tMax]` in display units (converted from `telem_bounds`), or `null`
  (shows 0–1 on axis if conversion fails)
- Bar height: 14px, SVG total height: ~70px
- Gradient: 21 equally-spaced stops from `viridis(0)` to `viridis(1)` (left → right)
- Title: "Dwell Start Temperature (°C)" or "°F" centered above the bar

---

## 10. Limits Handling

`parseLimits(data)` extracts six values from `data.all_limits`. Priority order:

| Field     | Keys tried                                         |
|-----------|----------------------------------------------------|
| `planHigh`| `planning.warning.high`, `planning.caution.high`   |
| `planLow` | `planning.warning.low`, `planning.caution.low`     |
| `cautHigh`| `odb.caution.high`                                 |
| `cautLow` | `odb.caution.low`                                  |
| `warnHigh`| `odb.warning.high`                                 |
| `warnLow` | `odb.warning.low`                                  |

`getLimitLines(lims, limitType)` builds `{value, color, dash, label, expand}` objects:

| Type    | Color          | Dash  | `expand` (included in Y domain) |
|---------|----------------|-------|---------------------------------|
| Plan    | `#f97316` orange | `8,4` | yes                           |
| Caution | `#eab308` yellow | `6,3` | yes                           |
| Warning | `#ef4444` red    | `4,4` | no                            |

Limit lines are drawn inside the clip group (`pg`) so they are clipped to the plot area.
Labels are right-aligned, 14px font.

---

## 11. Dwell Exploration Card

`renderDwellExplorationCard(container, rawData)` creates the bottom card. Returns early if
`rawData.dwell_table` is absent or has an empty `tstart` array.

### Field registry and auto-detection

```js
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
].filter(f => Array.isArray(tbl[f.key]));  // ← only includes fields actually present in the data
```

After this list is built, **any additional numeric array keys** present in `dwell_table` are
auto-detected and appended with a title-cased label (`some_field` → `Some Field`) and
`utype: null`. `datestart` (a string array) is explicitly excluded. This means new columns added
to `dwell_table` in the data pipeline automatically become plottable — no code change needed,
unless the column needs unit conversion (in which case add it explicitly to `ALL_FIELDS`).

Fields absent from the data file are silently dropped. The selects only show present fields.

### Zoom state

Four variables live **outside** `draw()`:
```js
let fullXDomain = null, fullYDomain = null;  // extents after field change
let viewXDomain = null, viewYDomain = null;  // current view (may be zoomed in)
```

`resetDomains(xk, yk)` computes extents and sets both `full` and `view` to the same value.
`draw()` uses `view` for scales. Brush zoom updates `view` only. Double-click resets `view` to
`full`. This is the same pattern as the quad plot charts.

### Time axis special case

When `xk === 'tstart'`, the X scale is `d3.scaleTime` and values are converted with
`cxcToDate(d.tstart)`. The domain is also in `Date` objects. This is handled in `resetDomains`
(converts extent to Dates with 4% padding) and in `draw()` (checks `isTime` to choose scale and
convert per-point values for plotting and hover).

### Color scale

Same scale as the scatter chart: `d3.scaleSequential(t => d3.interpolateRdYlBu(1 - t))`.
Each dot's `_tNorm = (tstart - tMin) / (tMax - tMin)` normalized time value.

The footer gradient bar is built by sampling this same scale at 11 points and joining as a CSS
`linear-gradient` — this ensures the bar exactly matches the dot colors.

### Hover

Finds the nearest dot within 24px (Euclidean screen distance). Shows dwell date, Y value, and X
value (if not already the time axis). Only searches dots in the current view.

---

## 12. Navigation and Page Shell (`index.html`)

### Model switching: `selectModel(navId)`

```
1.  Guard: if same model as current, return immediately
2.  Update URL: history.replaceState(null, '', `?model=${encodeURIComponent(navId)}`)
3.  Destroy all five current plots:
      currentPlot, currentPitchPlot, currentDwellPlot, currentSolarheatPlot, currentDpaPowerPlot
4.  Hide #provenance-card
5.  Show model panel, hide welcome panel
6.  Show loading spinner in #quad-container
7.  await App.loadModelData(navId)
8.  Guard: if user switched away during load, return (race condition check)
9.  Clear spinner
10. renderProvenance(data) → show #provenance-card
11. App.renderQuadPlot → currentPlot
12. currentPlot.setJitter(document.getElementById('ctrl-jitter').checked)
13. Show or hide #hl-controls based on currentPlot.hasHighlight():
      hasHighlight: classList.remove('d-none'), reset checkboxes to checked
      no highlight:  classList.add('d-none')
14. App.renderPitchErrorCard → currentPitchPlot
15. App.renderDwellExplorationCard → currentDwellPlot
16. App.renderSolarheatCard → currentSolarheatPlot
17. App.renderDpaPowerCard → currentDpaPowerPlot
```

Five tracked plot handles in `index.html`:
```js
let currentPlot          = null;  // { setJitter, setShowNormal, setShowHighlight, hasHighlight, destroy }
let currentPitchPlot     = null;  // { destroy() }
let currentDwellPlot     = null;  // { destroy() }
let currentSolarheatPlot = null;  // { destroy() }
let currentDpaPowerPlot  = null;  // { destroy() }
```

`destroy()` on pitch error, dwell exploration, solarheat, and DPA power cards calls
`card.remove()` + `ro.disconnect()`. Container divs persist; each card appends to and removes
from them.

`renderQuadPlot.destroy()` only disconnects the ResizeObserver — the container is cleared by
`qc.innerHTML = ''` before re-render.

### Container divs (in `#model-panel`)

```html
<div id="quad-container">                  <!-- cleared by innerHTML='', not card.remove() -->
<div id="pitch-error-container">           <!-- card appends/removes itself -->
<div id="dwell-exploration-container">     <!-- card appends/removes itself -->
<div id="solarheat-container">             <!-- card appends/removes itself -->
<div id="dpa-power-container">             <!-- card appends/removes itself -->
```

### Jitter checkbox

`#ctrl-jitter` is checked by default. On change: `currentPlot?.setJitter(this.checked)`. Only
affects the scatter chart in the quad plot. State persists across model switches because the
checkbox element is not destroyed — `currentPlot.setJitter(checked)` is called immediately after
each new quad plot render, propagating the current checkbox state.

### 215pcast_off checkboxes

`#ctrl-normal` and `#ctrl-highlight` inside `#hl-controls`. Both checked by default. Controlled
entirely by `d-none` class toggling (see §7). On change, call
`currentPlot?.setShowNormal(this.checked)` and `currentPlot?.setShowHighlight(this.checked)`.
Checkboxes are reset to `checked = true` each time a new model is loaded.

### URL param

`?model=<nav_id>` auto-selects a model on page load after the manifest is fetched.
`history.replaceState` updates the URL on every model switch without adding browser history
entries (so back-button navigates away from the dashboard, not between model selections).

### Model Provenance card

`renderProvenance(data)` is defined in `index.html` (not `app.js`). It reads:
- `data.msid`, `data.units`, `data.limit`, `data.limit_type`, `data.all_limits`
- `data.spec_md5`, `data.spec_github_url`, `data.spec_github_release`
- `data.datestart`, `data.datestop`

The GitHub URL is displayed as just the filename (`url.split('/').pop()`) linked to the full URL.

### Sidebar

Three collapsible Bootstrap collapse sections:
- Pitch Sensitivity → link to `../protractor/`
- Steady States → populated from `../steady_states/data/manifest.json` (fails silently if absent)
- Model Dashboard → populated from `App.loadManifest()`

The Model Dashboard section is expanded by default (`collapse show`); the others start collapsed.

---

## 13. Solarheat Parameters Card

`renderSolarheatCard(container, rawData)` reads `rawData.solar_heat_components`. Returns early
(no-op destroy) if absent or empty.

### Series building

The card builds an `allSeries` array from all components. Each component contributes one or more
series pairs (P solid line + P+dP dashed line), colored from a 10-color Tableau palette cycling
by color index.

```js
const palette = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
                 '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'];
```

**Simple P (flat list):** One `makeSeries` call → two series objects (P, P+dP). One color index
consumed.

**SimZDep P (dict keyed by instrument):** One `makeSeries` call per instrument key
(`hrcs`, `hrci`, `aciss`, `acisi`) → two series per instrument. Each instrument gets its own color
index. The instrument label is looked up in `INST_LABELS` (`{'hrcs': 'HRC-S', ...}`).

**dP handling:** `dP_pitches` may differ from `P_pitches`. The helper `interpLinear(xKnots,
yKnots, x)` resamples dP onto P_pitches before adding. Components where `dP` is all zeros
(`comp.dP.some(v => v !== 0)` is false) are treated as having no dP — only the P line is shown.

**Tooltip data:** Each point carries `tipP`, `tipDp`, and `tipPdP` (the same values for both P
and P+dP series points at the same pitch), so hovering either line at the same pitch shows
identical, complete information.

### Card layout

- Card body: `display:flex; flex-direction:column; height:380px`
- `plotEl`: `flex:1; min-height:0` — gets remaining space after legend
- `legendEl`: `flex-shrink:0; border-top:1px solid #e5e7eb` — HTML legend with SVG line swatches
  (28×10 SVG for lines, solid or dashed) for each series plus a rectangle swatch for the
  histogram bars

### Plot structure

- X axis: pitch 45–180°, `d3.scaleLinear`, 9 ticks formatted as `d => d°`
- Left Y axis: solarheat value (auto-extent from all series values with 10% padding)
- Right Y axis: dwell count (integer labels), domain `[0, maxCount * 1.15]`
- Histogram bars rendered first (behind lines): `fill:#94a3b8; opacity:0.30`; bin width 3°
- Lines drawn with clip path; data points drawn as 3.5px circles on top of lines
- Margin: `{ top: 24, right: 72, bottom: 52, left: 85 }` — right:72 to accommodate the count axis
- No brush/zoom — this is a reference parameter plot, not an interactive exploration tool

### Histogram source

Pitch values come from `rawData.dwell_table.pitch` (not from `pitch_analysis`). Bins span 45–180°
at 3° width. The histogram is pre-computed once at card creation time (not inside `draw()`), so
it does not change on resize.

---

## 14. ACIS DPA State Power Card

`renderDpaPowerCard(container, rawData)` reads `rawData.dpa_power`. Returns early (no-op destroy)
if the field is absent, if `dp.lookup` is not an object, or if the lookup dict is empty.

### Data format

```js
dpa_power: {
  lookup: {           // state pattern → pre-computed power in watts
    "0xxx": 16.38,    // 0 FEPs, clocking wildcard
    "1xx0": 28.15,    // 1 FEP, not clocking
    "1xx1": 29.99,    // 1 FEP, clocking
    // ... up to "6xx1"
  },
  mult: 1.9,          // stored for reference; lookup values already incorporate this
  bias: 0.01,         // stored for reference
}
```

State key parsing (`parseStateKey(key)`): first character = FEP count digit; last character =
`'1'` (clocking), `'0'` (not clocking), `'x'` (wildcard — rendered gray, "Mixed" legend entry).
The two middle characters are always `xx` wildcards.

### Card design

- Card body: `display:flex; flex-direction:column; height:320px`
- `plotEl`: `flex:1; min-height:0`
- `legendEl`: `flex-shrink:0; border-top:1px solid #e5e7eb` — circular SVG swatches:
  orange `#f28e2b` (Clocking), blue `#4e79a7` (Not Clocking), and gray `#6b7280` (Mixed) only
  if at least one wildcard-clocking row is present

### Jitter

`JITTER = 0.18` (half-width in FEP count units). Offsets are computed once per row at card
creation time (outside `draw()`), stored as `r.jx`, and are stable across window resize redraws.
This prevents points from jumping to new positions on every resize.

### Plot structure

- X axis: `d3.scaleLinear`, domain `[fepMin - 0.5, fepMax + 0.5]`, ticks only at integer FEP
  count values (`tickValues([...new Set(fepVals)].sort(...))`), formatted as integers
- Y axis: power in watts, domain `[0, pMax * 1.1].nice()`
- Points: 5px circles, white stroke `stroke-width:0.8`, `opacity:0.80`, colored by `rowColor(r)`
- Hover: attached directly to circle elements (`mouseenter`/`mouseleave`), not via brush overlay.
  Tooltip shows: state key (bold), FEP Count, Clocking (Yes/No/—), Power (W to 2 decimal places)

---

## 15. Config System (`config.js`)

`window.ModelDashConfig.models[msid]` provides per-model overrides. The key must match
`data.msid` **exactly** (case-sensitive).

```js
window.ModelDashConfig = {
  models: {
    '1dpamzt': {
      performanceOverview: {
        tempRange:      [10, 45],    // [min, max] in display units — Y for telem charts
        errorRange:     [-1.5, 1.5], // [min, max] in display units — X for error charts
        scatterBinSize: 0.5,         // bin width for percentile step-curves
        jitterBinSize:  0.1,         // half-width of jitter offsets
        histBinSize:    0.05,        // histogram bin width
      },
      pitchErrorCard: {
        errorRange: [-1.5, 1.5],     // [min, max] Y domain for ALL pitch-bin subplots
        timeRange:  [0, 80000],      // [0, max] X domain (dwell duration cap in seconds)
      },
    },
  },
};
```

All values default to `null` (auto). `renderQuadPlot` reads `performanceOverview` via
`window.ModelDashConfig?.models?.[data.msid]?.performanceOverview ?? {}`.
`renderPitchErrorCard` reads `pitchErrorCard` similarly.
`renderDwellExplorationCard`, `renderSolarheatCard`, and `renderDpaPowerCard` do not currently
read from config — add sections to config.js if overrides become needed.

---

## 16. Data Loading

`loadGzip(url)` fetches → pipes through `DecompressionStream('gzip')` → collects chunks →
`TextDecoder` → returns string. Caller does `JSON.parse(text)`.

**Cache:** `_cache.modelData[navId]` stores the parsed raw object after first load. No LRU
eviction. With ~14 models and ~2–10 MB decompressed each, memory usage may reach ~100 MB if all
models are visited in a session.

**All render functions receive the same raw cached object.** Passing pre-converted data would
cause double conversion for °F models.

**`DecompressionStream` browser support:** Available in all modern browsers (Chrome 80+, Firefox
113+, Safari 16.4+). This API is not polyfilled. If support for older browsers is needed, the
decompression step must be replaced with a JS gzip library.

---

## 17. Common Helpers in `app.js`

| Helper | Description |
|--------|-------------|
| `cxcToDate(t)` | CXC seconds → JS `Date`. Epoch: `Date.UTC(1998,0,1)`. |
| `uniformIdx(len, maxN)` | Evenly-spaced index array of length `maxN` across `len` items. |
| `pick(arr, idx)` | Returns `arr` values at `idx` positions. |
| `pct(sorted, p)` | Linear-interpolation percentile on a sorted array. |
| `initSvg(el, margin)` | Creates/clears SVG, returns `{svg, defs, g, w, h}`. |
| `addGridlines(g, xSc, ySc, w, h)` | Faint `#e5e7eb` gridlines, no domain line. |
| `addLimitLines(g, lines, ySc, w, fs)` | Draws named dashed limit lines inside clip group. |
| `addBrushZoom(g, defs, w, h, onZoom, onReset)` | D3 2D brush with dbl-click reset. Returns `brushG`. |
| `addHoverLine(g, w, h)` | Vertical dashed `#6b7280` cursor line, initially hidden. |
| `axLabel(g, text, x, y, rotate)` | Appends axis label text, optionally rotated. |
| `makeLinks()` | Returns `{sub, pub}` pub/sub bus for axis linking. |
| `showTip(html, cx, cy)` | Shows the singleton tooltip div. |
| `hideTip()` | Hides the tooltip. |
| `fmtUnits(u)` | `'degF'` or `'F'` → `'°F'`; else `'°C'`. |
| `parseLimits(data)` | Extracts six named limits from `data.all_limits`. |
| `getLimitLines(lims, limitType)` | Builds limit line spec objects. |
| `prepareDisplayData(data)` | Converts °C arrays to °F for °F-unit models. |
| `computeJitterSetup(observed)` | Computes jitter band from mean absolute diffs. |
| `computePercentiles(obs, res, step)` | Bins obs by `step`, returns P1/P50/P99 per bin. |

---

## 18. Known Issues and Items Needing Attention

### All-null telemetry arrays

If `observed`, `predicted`, or `residuals` are entirely null (model inactive), `d3.extent`
returns `[undefined, undefined]` → NaN domain → blank SVG with no error message. Should detect
this and show a "No data" message.

### Pitch error card: empty bins

If a pitch bin has zero qualifying dwells, the subplot renders as an empty 65px row with no
indication it's empty. Consider adding a "No data" overlay or collapsing empty bins.

### `MSID_DISPLAY_UNITS` must match `data.msid` exactly

The unit lookup uses `data.msid` from the JSON file, not the `nav_id` from the manifest. If the
file generator uses a different MSID string (e.g. `"fptemp_11"` vs `"fptemp"`), the lookup
silently defaults to Celsius. Verify new models by inspecting `msid` in the JSON before adding to
`manifest.json`.

### `2ceahvpt` nav_id (HRC CEA)

In the Protractor and Steady States apps, HRC is split into `2ceahvpt_s` and `2ceahvpt_i`. In
model_dash it is a single combined model file `2ceahvpt.json.gz`. This is intentional.

### Scatter hover reports cursor position, not snapped values

The scatter tooltip reports Error and Temp from `xSc.invert(mx)` and `ySc.invert(my)` — these
are the cursor coordinates, not the values of the nearest data point. The date shown IS from the
nearest data point (nearest in pixel space). This inconsistency could be confusing: the error and
temp values don't correspond to the date shown. To fix, derive all three values from the nearest
point rather than mixing cursor and point values.

### Error panel has no retry button

A load failure shows `#error-panel` but offers no retry. The user must click a different model
and click back, or reload the page.

### Pitch error card: no `pitch_analysis` → silent no-op

If a data file predates the `pitch_analysis` field, `renderPitchErrorCard` returns a no-op
destroy and renders nothing. No user-visible indication. A notice in `#pitch-error-container`
would help.

### Dwell exploration card / solarheat card: missing data → silent no-op

Same pattern: if `dwell_table` is absent/empty or `solar_heat_components` is absent, the
respective card does not render with no indication to the user.

### Histogram bin size on zoom

When `histBinSize` config override is active, the histogram uses pre-computed fixed thresholds
spanning the full extent — meaning zooming shows fewer bars but doesn't re-bin. This is
intentional to prevent confusing bin-width changes on zoom, but users may be surprised by sparse
histograms when zoomed in far.

### Legend position reset on model switch

The time series legend corner (`tsLegCorner`) is a closure variable in `makeTimeSeriesChart`. It
is reset to 0 (bottom-right) every time a new model is loaded, since a new chart instance is
created. This is expected behavior but means the user's corner preference is not preserved across
model switches.

### No ResizeObserver on pitch error stats tables

The stat tables are built with fixed pixel heights at render time. If the browser window is
resized, the SVG plots redraw (via ResizeObserver on `wrap`) but the table layout does not change.
This is generally fine since the tables use relative sizing (`flex:1`, `height:100%`), but if
`divH` pixel values become wrong after a resize, a full re-render would be needed.

### Source map 404s in browser console

Bootstrap's minified files reference `.map` files not present in the vendor directory. These
errors appear on every page load and can be ignored.

### Auto-detected dwell_table fields lack unit conversion

Fields auto-detected at runtime (not in the hardcoded `ALL_FIELDS` list) are assigned `utype:
null` and displayed without conversion. If a new temperature or error column is added to
`dwell_table`, it must be added explicitly to `ALL_FIELDS` with the correct `utype` to show
correct values for °F models.

### Histogram stat lines: min/max can coincide with p5/p95 labels for small datasets

When the dataset is small, extreme percentile values may land very close to the actual min/max,
causing two labels to overlap at the same X position. No deconfliction is currently implemented.

---

## 19. Data Format Pitfalls (Lessons from Development)

These were non-obvious during initial development and caused debugging sessions.

1. **`datestart`/`datestop` at the top level are Chandra date strings** like
   `"2023:090:00:01:58.816"`, not temperatures. The colorbar temperature range comes from
   `pitch_analysis.telem_bounds`, which is a `[min, max]` **array** — not an object with `.min`
   or `.temp_min`. Access as `tb[0]` and `tb[1]`.

2. **`err_segments` is a plain object, not an array.** `pa.err_segments.length` is `undefined`.
   Keys are string integers `"0"`, `"1"`, …. Use the `toArr()` helper to normalize.

3. **Each segment is an array of `[time, error]` pairs**, not an object with `.errors` and
   `.times`. `seg.errors` is `undefined`. Unpack with `seg.map(d => d[0])` for times and
   `seg.map(d => d[1])` for errors.

4. **The norm key is `segment_norm`**, not `norm_segments`. Its value for each bin is a plain
   array of scalars (one per dwell), not an array of arrays.

5. **`pitch_bin_statistics` is keyed by string bin index**, same as `err_segments`. Access as
   `pbs[String(bi)]?.error`, not `pbs[bi]?.error`.

6. **Error statistics are all deltas (relV), not absolute temperatures (absV).** Using `absV`
   (which adds 32 for °F) on error stats would produce wrong values.

7. **`dwell_table` temperatures are in °C** in the file. The `obs_*` fields and `err_*` fields
   all need the same `toDisp()` conversion as the main time series arrays. The `utype` field
   in the field registry tells you which conversion to apply.

8. **`segment_norm` values for the pitch error card use a viridis scale**, while the quad plot
   scatter and dwell exploration card use RdYlBu. Do not mix the two color scales.

9. **The brush overlay sits on top of all SVG elements added before it.** If you need an SVG
   element to receive click or mouse events, append it **after** `addBrushZoom` returns.
   The time series legend demonstrates this pattern.

10. **`solar_heat_components` supersedes old fields.** Old data files may contain `solar_params`,
    `p_names`, and `dp_names` — these are an obsolete format and should be ignored. The current
    code reads only `solar_heat_components`.

11. **For SimZDep solarheat components, `P` is a dict, not an array.** `Array.isArray(comp.P)`
    returns false; `typeof comp.P === 'object'` returns true. The card branches on this to handle
    per-instrument curves.

12. **`dP_pitches` may differ from `P_pitches`.** Do not index into dP with P's pitch index
    directly. Use `interpLinear` to resample dP onto the P pitch grid before adding.

13. **DPA power data key is `dpa_power`, not `dpa_power_params`.** The value under `dpa_power`
    is a dict with a `lookup` sub-key (not parallel arrays `power`, `fep_count`, `clocking`).
    State patterns are 4-character strings, not structured objects.

14. **Bootstrap `.d-flex` applies `display:flex !important`.** Setting `element.style.display =
    'none'` does NOT hide a `.d-flex` element after the initial inline `!important` style has been
    removed. Use `classList.add('d-none')` / `classList.remove('d-none')` instead — `d-none`
    also uses `!important` and wins the specificity battle correctly.

15. **`215pcast_off` is only meaningful for `2ceahvpt` models.** The guard in `renderQuadPlot`
    checks `data.msid.startsWith('2ceahvpt')` before reading `inputs['215pcast_off']`. If other
    models get an `inputs` field in the future, this gate prevents accidentally activating the
    highlight feature on them.

---

## 20. Build / Deployment

`model_dash/` is included in `build.py`:

```bash
python build.py [--output-dir dist] [--force]   # from meridian/
```

Copies: `index.html`, `app.js`, `config.js`, `vendor/`, `data/` (including all `.json.gz` files
and `manifest.json`). Does **not** copy `handoff.md`, `data_file_structure.md`, or `reference.md`.

---

## 21. Analytics Fields (Not Yet Rendered)

The following fields exist in every data file but are not currently displayed by any card. They
are pre-computed by the data pipeline and are ready to use:

**`analytics.monthly`** — Monthly weighted-mean bias for all dwells and near-limit dwells. A line
chart of `all.mean` vs `months` makes time-evolving drift visible in a way the current
error-time chart does not. A trend in `near_limit.mean` but not `all.mean` is the highest-priority
signal for a model update.

**`analytics.error_by_temperature`** — Mean error in 20 equal temperature bins. A cleaner,
pre-aggregated version of the scatter plot's percentile lines. Reveals whether model error varies
with temperature.

**`analytics.period_comparison`** — Early 2/3 vs recent 1/3 of the evaluation window. Useful for
detecting model degradation over time with a single glance (no time series navigation required).

**`stats`** — Global residual statistics (mean, std, rms, P05/P95, violation count/fraction). A
summary card showing these values plus `analytics.period_comparison` would give model owners a
quick health check without scrolling through all the charts.

---

## 22. Potential Development Directions

### Summary statistics card

A card showing `stats.*` and `analytics.period_comparison` values (early vs recent mean/std/P95).
Most impactful because it distils the question "is this model OK?" to a few numbers without
requiring the user to interpret any chart.

### Monthly bias trend plot

`analytics.monthly` contains pre-computed monthly weighted-mean error for all dwells and
near-limit dwells. A line chart would make time-evolving drift visible.

### Error-by-temperature plot

`analytics.error_by_temperature` has 20 equal-width temperature bins with mean/std/P95 error
per bin. This is a cleaner version of the scatter plot's percentile lines and would show whether
bias is concentrated at high or low temperatures.

### Per-pitch-bin Y axis lock option

A "lock Y axes" toggle in the pitch error card header could enforce a shared Y domain across all
bins for visual comparison of error magnitudes across pitch angles.

### Date range selector

A date range slider or two date inputs in the quad plot card header would allow focus on a
specific mission epoch or before/after a model update.

### Dwell exploration: color-by field

Currently the dwell exploration card colors by time. A third dropdown to select the color variable
(e.g. color by `obs_start_temp` or `pitch`) would add analytical flexibility.

### Export

SVG or PNG download of any card for use in reports or presentations.

### Multi-model comparison

Overlay residual error statistics (P50 line, monthly mean bias) across multiple models — either
as a multi-select or a dedicated "Compare" view.

### Scatter hover: snap all values to nearest point

Currently Error and Temp in the scatter tooltip are cursor-interpolated while Date is from the
nearest point. All three should come from the nearest point for consistency.

---

## 23. Code Conventions

- **IIFE module:** All private state and helpers are inside the closure. No globals except `App`.
- **Functional factories:** Each chart factory closes over its data and returns a `draw()`
  function. No DOM IDs inside factories — all elements are created programmatically.
- **Full redraw on state change:** `draw()` calls `initSvg()` which clears the SVG and rebuilds.
  State (zoom domains, jitter offsets, legend corner) lives in closure variables, not the DOM.
- **Sampling:** `uniformIdx` + `pick` reduce arrays to `MAX_TS_PTS=8000` or `MAX_SC_PTS=6000`
  before any D3 work.
- **No hardcoded MSID list in chart code:** Charts receive a `data` object and render what is
  in it. `MSID_DISPLAY_UNITS` and `manifest.json` are the only places that enumerate model names.
  The 215pcast_off feature is an exception — it is gated on `data.msid.startsWith('2ceahvpt')`
  because the visual encoding (charcoal segments, dual-dataset histogram) is specific to that
  model's operating condition, not a generic pattern.
- **Two independent link buses:** The quad plot uses one `makeLinks()` instance; the pitch error
  card uses a separate one. They do not share channels.
- **Destroy contract:** Every render function returns a `{ destroy() }` object. Destroy must be
  called before replacing the render — it disconnects ResizeObservers and removes DOM nodes.
  `renderQuadPlot.destroy()` only disconnects the observer (the container is cleared by
  `qc.innerHTML = ''`). All other cards' `destroy()` calls `card.remove()`.
- **Tooltip is a singleton:** One `_tip` div is created lazily and reused. `showTip` / `hideTip`
  operate on this shared element. Do not create per-card tooltip elements.
- **Stable jitter:** Jitter offsets in the scatter chart and DPA power card are computed once at
  card creation time, stored in an array, and indexed at draw time. This prevents points from
  moving on every resize redraw.
- **D3 v7 event signature:** All D3 event handlers use `(event, d)` — not `(d, i)` as in D3 v5.
  Getting this wrong silently passes the datum as the event object.
- **`d-none` not inline style for Bootstrap flex elements:** Any element that uses Bootstrap flex
  utility classes (`d-flex`, etc.) must be hidden with `classList.add('d-none')`, not
  `style.display = 'none'`, because Bootstrap utilities use `!important`.
