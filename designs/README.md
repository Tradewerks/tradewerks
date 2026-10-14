# Design direction comparison

Screenshots of four dispatch pages under the current app style and each of the
three candidate design systems from the *Field Ops Design Systems v2* Claude
Design project.

All shots: Chromium, 1600×1000 CSS px, light mode, same seeded data.

| Folder | System | Character |
|---|---|---|
| `./` (root) | **Current** | Inter, blue primary, zinc/slate cool neutrals |
| `01-dispatch-board/` | **01 · Dispatch — "The board"** | Graphite console. Archivo + IBM Plex Mono. Ink CTAs, one ochre signal, hairline rules instead of shadows, tight 3–6px radii |
| `02-field-glove-first/` | **02 · Field — "Glove first"** | Technician-out. Instrument Sans + JetBrains Mono. Warm neutrals, pine-green primary, hi-vis lime for the single next action, 8–16px radii, type scale one step up |
| `03-ledger-book-of-record/` | **03 · Ledger — "The book of record"** | Back office. Newsreader serif + Public Sans. Paper stock, copper for "awaiting a human", blue only for links, tabular figures, near-square 2–4px corners |

Pages captured in each folder: `dispatch.png`, `map.png`, `quote-funnel.png`, `requests.png`.

## How each was implemented

The app is already ~4,000 design-token class usages deep (`bg-base`,
`text-text-primary`, `border-card`, …) against only ~110 hardcoded palette
classes, so a system swap is almost entirely a token swap. Each system replaced:

- `frontend/src/styles/theme.css` — all 147 `--color-*` tokens (light + dark +
  palette variants), plus `--radius-*` and, for System 02, `--text-*`
- `frontend/src/index.css` — the Google Fonts import and the global font stack

Each folder keeps the exact `theme.css` it was shot with.

## Re-applying a system

```bash
./designs/apply.sh 01     # or 02, 03
git checkout -- frontend/src/styles/theme.css frontend/src/index.css   # revert
```

`apply.sh` reads `<NN>-theme.css` from the folder it lives in, so move the
archived stylesheets next to it (or edit the path) before running.

Nothing was committed — the working tree was returned to baseline after each
system.
