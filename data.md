This dataset is a collection of spacecraft thermal dwell envelopes. Its purpose is to describe, for each thermal model/MSID, the maximum allowed dwell time under coupled thermal constraints, and to support plotting those limits primarily as a function of pitch.

Core meaning:
- Each output MSID represents the maximum allowed dwell time for that location/model.
- The dwell time is not determined independently per model. The thermal models are coupled: some locations heat while others cool, and one model’s limit can reduce the dwell time another model could otherwise support.
- Because of that coupling, the final allowed dwell is a composite constraint. The limit columns are inputs to the final dwell-time outputs.

Scenario dimensions:
- date: scenario date / season-like context
- dwell_type: either `limit` or `offset`
- chips: categorical scenario parameter with values 1..6
- pitch: primary independent variable for plotting; angle of the spacecraft to the Sun
- roll: additional attitude input
- datesecs: numeric time-like input

File organization:
- The dataset currently contains 60 files:
  - 5 dates
  - 2 dwell types (`limit`, `offset`)
  - 6 chips settings
- Filename pattern: `YYYY-DDD-00-00-00_<dwell_type>_chipsN.json`
- Example: `2026-182-00-00-00_limit_chips4.json`

File schema:
- Each file is one top-level object with:
  - `date` (string, format `YYYY:DDD:HH:MM:SS`)
  - `dwell_type` (`limit` or `offset`)
  - `chips` (integer)
  - `columns` (object of aligned arrays)
- `columns` is a columnar table: every array has the same length, and index `i` across all arrays is one row.

Important parsing note:
- These files are not strict JSON for browser parsers because they contain literal `NaN` values.
- `JSON.parse()` will fail unless `NaN` is converted first.
- Treat `NaN` as missing / inactive / not-applicable data.

Semantically, the dataset has:
- Base inputs:
  - `pitch`
  - `date`
  - `datesecs`
  - `dwell_type`
  - `roll`
  - `chips`
- Constraint inputs (limit columns):
  - `fptemp_11_limit`
  - `1dpamzt_limit`
  - `1deamzt_limit`
  - `1pdeaat_limit`
  - `aacccdpt_limit`
  - `4rt700t_limit`
  - `tpc_fsse_limit`
  - `pftank2t_limit`
  - `pm1thv2t_limit`
  - `pm2thv1t_limit`
  - `pline03t_limit`
  - `pline04t_limit`
  - `2ceahvpt_limit_s`
  - `2ceahvpt_limit_i`
- Outputs (maximum allowed dwell times):
  - `1dpamzt`
  - `1deamzt`
  - `fptemp_11`
  - `1pdeaat`
  - `aacccdpt`
  - `pm1thv2t`
  - `pm2thv1t`
  - `4rt700t`
  - `pftank2t`
  - `pline03t`
  - `pline04t`
  - `2ceahvpt`
  - `tpc_fsse`
  - `2ceahvpt_s`
  - `2ceahvpt_i`

This is the msid/common name mapping:
- 'pline03t': 'Propulsion Line #3',
- 'pline04t': 'Propulsion Line #4',
- '1dpamzt': 'ACIS Electronics (DPA)',
- '1deamzt': 'ACIS Electronics (DEA)',
- 'fptemp_11': 'ACIS Focal Plane',
- 'fptemp': 'ACIS Focal Plane',
- '4rt700t': 'OBA Forward Bulkhead',
- 'aacccdpt': 'Aspect Camera CCD',
- 'pftank2t': 'IPS Fuel Tank',
- 'pm1thv2t': 'Thruster 2A',
- 'pm2thv1t': 'Thruster 1B',
- '1pdeaat': 'ACIS Elec. (PSMC)',
- '2ceahvpt_s': 'HRC-S CEA',
- '2ceahvpt_i': 'HRC-I CEA',

Structural note:
- In the files, `date`, `dwell_type`, and `chips` are top-level metadata fields, not arrays inside `columns`.
- `pitch`, `datesecs`, and `roll` are array columns inside `columns`.

How to interpret `limit` vs `offset`:
- `limit` files represent dwells that heat toward a thermal limit.
- `offset` files represent dwells that cool enough to offset limited dwells.
- Both file types use the same schema and the same MSID output columns.
- A finite value means that model/location has a dwell-time value for that regime at that row.
- `NaN` means that model is inactive or not applicable for that regime at that row.

Pitch-centric interpretation:
- Pitch is almost always the main x-axis.
- Most plots should show behavior across all pitch values.
- In the current files, `pitch` spans 45 through 180 degrees and repeats many times within a file.
- `roll` is constant within each file in the current dataset.
- `datesecs` is also constant within each file in the current dataset.
- Therefore, these files are not simple one-row-per-pitch tables. They contain repeated samples at the same pitch.
- For plotting by pitch, group or reduce rows by pitch using a rule appropriate to the plot:
  - minimum dwell time for “most limiting” views
  - maximum dwell time for “best available” views
  - mean/median only if a smoothed summary is intended
  - categorical state logic for classification plots

Important plotting semantics:
- A magnitude plot shows dwell-time values versus pitch for one or more output MSIDs.
- A limiting-region plot focuses on where each model is active as a limiting model across pitch.
- In the limiting-region view:
  - light red means limited dwell: the model heats to a limit there
  - light blue means offset dwell: the model cools enough there to offset a limited dwell
  - dark red means that, at that pitch, this model has the lowest predicted limited dwell time of all models and is therefore the active limiting model
  - gray means the model is neither limiting nor offsetting there; this corresponds to `NaN` in both the limited and offset dwell datasets for that model/pitch
- Dark red requires comparing limited-dwell magnitudes across models at the same pitch. Presence alone is not enough.

Recommended mental model for plotting:
- A file is one scenario.
- Within a scenario, pitch is the primary axis.
- MSID outputs are the main plotted quantities.
- Limit columns are contextual inputs / constraints, not targets.
- `limit` and `offset` are complementary regimes that can be compared, overlaid, or combined into categorical pitch-state plots.

Useful plot families:
- dwell time vs pitch for one MSID
- multi-MSID comparison vs pitch
- active limiting model by pitch
- limit vs offset envelope comparison
- faceted comparisons by date
- faceted comparisons by chips
- categorical state bars by pitch (`limit`, `offset`, inactive)
- heatmaps with pitch on one axis and MSID on the other

Current dataset quirks:
- Some output columns are sparse and contain many `NaN` values.
- `2ceahvpt` is present but appears entirely `NaN` in the current file set.
- Do not connect line segments across `NaN` gaps unless explicitly interpolating.
