# Meridian

Spacecraft thermal dwell envelope visualization tool for Chandra X-ray Observatory. Shows maximum allowed dwell time per thermal model/location as a function of pitch, under coupled thermal constraints.

## Target Project Layout

```
meridian/
├── CLAUDE.md
├── data/                          ← raw JSON scenario files (do not read into context)
├── theme/
│   ├── base.html                  ← Jinja2 base template with sidebar shell
│   └── vendor/                    ← bootstrap.min.css, bootstrap.bundle.min.js, d3.min.js
├── protractor/                    ← protractor plot app
│   ├── protractor.py
│   ├── templates/
│   │   ├── index.html
│   │   └── app.js
│   └── tests/
└── build.py                       ← assembles all apps into dist/
```

## Web Stack

- Bootstrap 5 — loaded from local `vendor/` directory, never CDN
- Vanilla JS only — no React, Vue, or other frameworks
- D3 v7 — for charts only

Full theme spec: see `web_theme.md`.

## MSID Common Names

| MSID | Common Name |
|---|---|
| `1dpamzt` | ACIS Electronics (DPA) |
| `1deamzt` | ACIS Electronics (DEA) |
| `fptemp_11` | ACIS Focal Plane |
| `4rt700t` | OBA Forward Bulkhead |
| `aacccdpt` | Aspect Camera CCD |
| `pftank2t` | IPS Fuel Tank |
| `pm1thv2t` | Thruster 2A |
| `pm2thv1t` | Thruster 1B |
| `1pdeaat` | ACIS Elec. (PSMC) |
| `tpc_fsse` | TPC FSSE |
| `pline03t` | Propulsion Line #3 |
| `pline04t` | Propulsion Line #4 |
| `2ceahvpt_s` | HRC-S CEA |
| `2ceahvpt_i` | HRC-I CEA |

New models may be added at any time. Code must auto-detect MSID output columns and adapt without hardcoding the model list.

## Data Formats

### Simple results files (`limited_results.json`, `offset_results.json`)

Pandas `orient='columns'` format: `{ column_name: { "row_index": value, ... }, ... }`

- Row indices are string integers (`"0"`, `"1"`, ...)
- One row per pitch degree; pitch spans 45–180
- Values may be `null` (JSON null) representing missing/inactive data

**Output columns** (dwell times, the main plotted quantities):
`1dpamzt`, `1deamzt`, `fptemp_11`, `1pdeaat`, `aacccdpt`, `pm1thv2t`, `pm2thv1t`,
`4rt700t`, `pftank2t`, `pline03t`, `pline04t`, `tpc_fsse`, `2ceahvpt_s`, `2ceahvpt_i`
(legacy `2ceahvpt` is present but likely all null)

**Constraint input columns** (limits): same names with `_limit` suffix

**Metadata columns**: `pitch`, `date`, `datesecs`, `dwell_type`, `chips`, `roll`

### Full scenario files (`data/YYYY-DDD-00-00-00_<dwell_type>_chipsN.json`)

Schema: `{ date, dwell_type, chips, columns: { col_name: [values...] } }` — arrays, not indexed objects.

Top-level metadata fields: `date`, `dwell_type`, `chips`
Array columns live under `columns`: `pitch`, `datesecs`, `roll`, plus all output and limit columns

**WARNING**: These files contain literal `NaN` (not valid JSON). Pre-parse with string replacement before `JSON.parse()`. Example:
```js
const text = rawText.replace(/\bNaN\b/g, 'null');
const data = JSON.parse(text);
```

### Pitch aggregation

The full scenario files contain multiple rows per pitch value. When reducing to one value per pitch:
- Use `min` for "most limiting" views (protractor plot uses this)
- Use `max` for "best available" views
- Use presence logic (any finite value?) for categorical state plots

## Plot Semantics: Constraint Pitch Sensitivity (Protractor)

A semicircular polar plot. Pitch (45–180°) runs along the arc; each MSID occupies a radial band.

| Color | Meaning |
|---|---|
| Light red | Model has a limited dwell at that pitch |
| **Dark red** | Model is the active limiting factor (lowest limited dwell of all models at that pitch) |
| Light blue | Model can offset a limited dwell at that pitch |
| Gray | Neutral — NaN in both limited and offset data |

Dark red requires comparing limited-dwell magnitudes across all models at the same pitch — presence of a limited value alone is not sufficient.

### HRC special case

`2ceahvpt_s` (HRC-S CEA) and `2ceahvpt_i` (HRC-I CEA) share a single radial band using **half-width overlapping bars**: their limited and offset bars overlap rather than occupying separate radial sections, unlike all other models.
