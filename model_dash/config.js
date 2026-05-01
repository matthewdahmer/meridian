// model_dash/config.js
//
// Per-model override configuration for the Model Dashboard.
// Keys must match data.msid exactly (case-sensitive) — check the manifest if unsure.
//
// All values default to null (auto). To activate an override, uncomment its model
// section and set a value. To deactivate a single field, set it back to null or
// comment it out; the auto behavior will be restored.
//
// ── performanceOverview fields ──────────────────────────────────────────────
//   tempRange       [min, max]  Temperature axis range, in the model's display
//                               unit. Applied to the telemetry-vs-time chart
//                               (Y) and the telemetry-vs-error scatter (Y).
//   errorRange      [min, max]  Error axis range, in the model's display unit.
//                               Applied to the scatter (X), error-vs-time (Y),
//                               and residual histogram (X).
//   scatterBinSize  number      Bin width (display units) used to group telem
//                               values when computing the 1%/50%/99% percentile
//                               step-lines in the scatter plot. Larger values
//                               produce coarser, smoother lines.
//   jitterBinSize   number      Jitter half-width (display units). Each scatter
//                               point is offset by a uniform random value in
//                               [-jitterBinSize, +jitterBinSize]. Overrides the
//                               auto-computed mean(|Δtelem|)/2.
//   histBinSize     number      Residual histogram bin width (display units).
//                               Overrides the auto bin count from Sturges' rule.
//
// ── pitchErrorCard fields ────────────────────────────────────────────────────
//   errorRange  [min, max]  Error axis range (display units). Applied to every
//                           pitch-bin subplot as the initial Y domain.
//   timeRange   [min, max]  Dwell-duration axis range in seconds. Applied as
//                           the initial X domain for every subplot (default is
//                           [0, 80000]).
// ─────────────────────────────────────────────────────────────────────────────

window.ModelDashConfig = {
  models: {

    // ── 1dpamzt — ACIS Electronics (DPA)  [display: °C] ─────────────────
    // '1dpamzt': {
    //   performanceOverview: {
    //     tempRange:      null,   // e.g. [10, 45]
    //     errorRange:     null,   // e.g. [-1.5, 1.5]
    //     scatterBinSize: null,   // e.g. 0.5
    //     jitterBinSize:  null,   // e.g. 0.1
    //     histBinSize:    null,   // e.g. 0.05
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,       // e.g. [-1.5, 1.5]
    //     timeRange:  null,       // e.g. [0, 80000]
    //   },
    // },

    // ── 1deamzt — ACIS Electronics (DEA)  [display: °C] ─────────────────
    // '1deamzt': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── fptemp_11 — ACIS Focal Plane  [display: °C] ──────────────────────
    // Note: key must match data.msid in the .json.gz file; may be 'fptemp'
    // or 'fptemp_11' depending on how the file was generated.
    // '1pdeaat': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── 1pdeaat — ACIS Electronics (PSMC)  [display: °C] ────────────────
    // '1pdeaat': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── aacccdpt — Aspect Camera CCD  [display: °C] ──────────────────────
    // 'aacccdpt': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── 2ceahvpt — HRC CEA (combined)  [display: °C] ─────────────────────
    // '2ceahvpt': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── 4rt700t — OBA Forward Bulkhead  [display: °F] ────────────────────
    // '4rt700t': {
    //   performanceOverview: {
    //     tempRange:      null,   // e.g. [50, 120]
    //     errorRange:     null,   // e.g. [-3, 3]
    //     scatterBinSize: null,   // e.g. 1.0
    //     jitterBinSize:  null,   // e.g. 0.2
    //     histBinSize:    null,   // e.g. 0.1
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,       // e.g. [-3, 3]
    //     timeRange:  null,
    //   },
    // },

    // ── pftank2t — IPS Fuel Tank  [display: °F] ──────────────────────────
    // 'pftank2t': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── pm1thv2t — Thruster 2A  [display: °F] ────────────────────────────
    // 'pm1thv2t': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── pm2thv1t — Thruster 1B  [display: °F] ────────────────────────────
    // 'pm2thv1t': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── tpc_fsse — TPC FSSE  [display: °F] ───────────────────────────────
    // 'tpc_fsse': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── pline03t — Propulsion Line #3  [display: °F] ─────────────────────
    // 'pline03t': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

    // ── pline04t — Propulsion Line #4  [display: °F] ─────────────────────
    // 'pline04t': {
    //   performanceOverview: {
    //     tempRange:      null,
    //     errorRange:     null,
    //     scatterBinSize: null,
    //     jitterBinSize:  null,
    //     histBinSize:    null,
    //   },
    //   pitchErrorCard: {
    //     errorRange: null,
    //     timeRange:  null,
    //   },
    // },

  },
};
