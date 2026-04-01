
  ---
  Theme Prompt

  Create a multi-page data dashboard website using the following design system.
  Replicate it exactly — colors, spacing, typography, and layout — just replace
  the content with [YOUR CONTENT HERE] placeholders.

  ─────────────────────────────────────────────────────────────────────────────
  STACK
  ─────────────────────────────────────────────────────────────────────────────
  - Bootstrap 5 (loaded from a local vendor/ directory, not a CDN)
  - Vanilla JS only — no React/Vue/etc.
  - D3 v7 (only if charts are needed)

  ─────────────────────────────────────────────────────────────────────────────
  LAYOUT
  ─────────────────────────────────────────────────────────────────────────────
  Full-viewport flex row: fixed-width left sidebar (260px) + flex-grow main area.
  On mobile (<768px) the sidebar collapses to a Bootstrap offcanvas drawer,
  revealed by a hamburger button in a top navbar.

  ─────────────────────────────────────────────────────────────────────────────
  SIDEBAR STYLES
  ─────────────────────────────────────────────────────────────────────────────
  background:      #1e2937
  border-right:    none (items use border-bottom: 1px solid #374151)
  brand text:      #f9fafb, font-size .9rem, font-weight 600, bottom border #374151
  section label:   #6b7280, font-size .68rem, uppercase, letter-spacing .08em
  nav links:       color #9ca3af, font-size .82rem, padding .35rem 1rem,
                   border-left: 3px solid transparent
  nav link hover:  color #f3f4f6, background #273345
  nav link active: color #60a5fa, background #1e3a56, border-left-color #3b82f6

  ─────────────────────────────────────────────────────────────────────────────
  PAGE BACKGROUND & CONTENT AREA
  ─────────────────────────────────────────────────────────────────────────────
  body background: #f3f4f6
  main padding:    p-3 (mobile) / p-4 (desktop)

  Cards / panels:
    background: #fff
    border-radius: .375rem
    box-shadow: 0 1px 3px rgba(0,0,0,.08)
    padding: .5rem

  ─────────────────────────────────────────────────────────────────────────────
  WELCOME / EMPTY STATE
  ─────────────────────────────────────────────────────────────────────────────
  Centered div, py-5, text-muted. An <h5> title and a <p class="small"> subtitle.
  Hidden once the user makes a selection. The selected content panel takes its place.

  ─────────────────────────────────────────────────────────────────────────────
  LOADING SPINNER
  ─────────────────────────────────────────────────────────────────────────────
  .loading-state: flex, align-items center, justify-content center, min-height 200px,
                  color #6b7280, gap .5rem
  Uses Bootstrap's spinner-border spinner-border-sm text-primary.

  ─────────────────────────────────────────────────────────────────────────────
  TABLES
  ─────────────────────────────────────────────────────────────────────────────
  Bootstrap: table table-sm table-striped table-hover small, wrapped in table-responsive.
  Header: table-dark.

  ─────────────────────────────────────────────────────────────────────────────
  BUTTONS / DOWNLOAD LINKS
  ─────────────────────────────────────────────────────────────────────────────
  btn btn-outline-secondary btn-sm

  ─────────────────────────────────────────────────────────────────────────────
  JS ARCHITECTURE
  ─────────────────────────────────────────────────────────────────────────────
  All application logic lives in a single IIFE (vendor/app.js) that exposes a
  global App object. index.html contains only a boot <script> block that calls
  App methods. The App object has:
    - Pure/testable helper functions (no DOM access)
    - Cached async loaders (fetch JSON/text, cache in _cache object)
    - DOM renderer functions

  The page is a single-page application: nav clicks swap content in-place
  (show/hide divs), no page reloads. Data is loaded lazily on first selection
  and cached for the session.

  ─────────────────────────────────────────────────────────────────────────────
  ERROR DISPLAY
  ─────────────────────────────────────────────────────────────────────────────
  A hidden <div id="error-panel" class="alert alert-danger"> at the bottom of
  main. Shown via JS with an error message, cleared on the next successful load.

  ---
  File Structure Advice

  No, do not use separate repos per page. The right model is a monorepo with one deployable output, where each "app" is a Python module that generates its
  slice of the site, all sharing the same theme assets:

  xija_tools/                        ← monorepo root
  │
  ├── theme/                         ← shared design system (extracted once)
  │   ├── base.html                  ← Jinja2 base template with sidebar shell
  │   └── vendor/                    ← bootstrap.min.css, bootstrap.bundle.min.js, d3.min.js
  │
  ├── steady_states/                 ← existing app (what you have now)
  │   ├── steady_states.py           ← Python build logic
  │   ├── templates/
  │   │   ├── index.html             ← extends base.html, injects its own sidebar + content
  │   │   └── app.js
  │   └── tests/
  │
  ├── new_app/                       ← next app
  │   ├── new_app.py
  │   ├── templates/
  │   │   ├── index.html
  │   │   └── app.js
  │   └── tests/
  │
  └── build.py                       ← assembles all apps into dist/
      # dist/
      #   vendor/         ← copied once from theme/vendor/
      #   steady-states/  ← output from steady_states app
      #   new-app/        ← output from new_app
      #   index.html      ← top-level landing/nav page

  Key decisions:

  - Shared base.html — the sidebar shell, Bootstrap imports, and CSS variables live here. Each app template extends it and only overrides the content block.
  This is how you avoid duplicating the theme.
  - One vendor/ copy — shared by all apps in the final dist/, not duplicated per-app.
  - build.py as the assembler — runs each app's build script, collects outputs, writes dist/. Each app stays independently testable.
  - Same repo — the apps are closely related, share a data pipeline, and share a design system. Splitting repos adds coordination overhead with no real
  benefit unless the apps have totally independent release cycles and teams.
