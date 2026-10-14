# Theme Guide

Single source of truth: `src/styles/theme.css` — all color tokens in Tailwind v4 `@theme`.

## Token naming convention

Semantic names only. Never literal color names.
- `--color-primary` not `--color-blue-500`
- `--color-error` not `--color-red`
- `--color-border` not `--color-zinc-700`

---

## Critical: class name vs. token name

Tailwind v4 generates utility classes from `--color-*` variables by stripping the `--color-` prefix.
So `--color-text-primary` → class `text-text-primary`. This matters:

| Intent | Correct class | Wrong class | Why wrong |
|---|---|---|---|
| Body/heading text | `text-text-primary` | `text-primary` | `text-primary` = `--color-primary` = **blue #3b82f6** |
| Supporting labels | `text-text-secondary` | `text-secondary` | Same issue — maps to unrelated token |
| Text on blue button | `text-on-primary` | `text-white` | `text-white` hardcodes white, breaks semantics |
| Input text | `text-text-primary` | `text-white` | White invisible in light mode |

---

## Using tokens in components

### Tailwind utilities (preferred)

```tsx
// Body text — use text-text-primary, NOT text-primary
<p className="text-text-primary">Name</p>
<h1 className="text-text-primary font-bold">Dashboard</h1>

// Text on filled action button — use text-on-primary, NOT text-white
<button className="bg-primary hover:bg-primary-hover text-on-primary">Save</button>
<button className="bg-error hover:bg-error-strong text-on-primary">Delete</button>

// Input field pattern
<input className="bg-surface-inset border border-input text-text-primary placeholder:text-faint
                  focus:outline-none focus:ring-1 focus:ring-primary-border rounded" />

// Select pattern
<select className="bg-surface-inset border border-input text-text-primary
                   focus:outline-none focus:ring-1 focus:ring-primary-border rounded" />
```

Opacity modifiers work on **solid hex** tokens:
```tsx
<div className="bg-primary/20 border border-primary/30">...</div>
```
⚠️ Do NOT use opacity modifiers on `rgba()` tokens (alpha already baked in):
- `bg-primary-bg` ✅
- `bg-primary-bg/50` ❌ (double-alpha, broken)

⚠️ Do NOT use `bg-surface/40` — surface is `#ffffff` in light mode, 40% white over white = invisible.
Use the next solid surface tier instead (`bg-surface-raised`).

### Inline styles (SVG, absolutely-positioned elements)
```tsx
style={{ color: "var(--color-sched-text-primary)", background: "var(--color-card-bg)" }}
```

### SVG / Recharts
```tsx
<Area stroke="var(--color-chart-primary)" fill="var(--color-chart-primary)" />
<XAxis stroke="var(--color-chart-axis)" tick={{ fill: "var(--color-chart-axis)" }} />
```

### Placeholder text (Tailwind v4 syntax)
```tsx
// ✅ Correct — Tailwind v4 arbitrary variant syntax
<input className="placeholder:text-faint" />

// ❌ Wrong — Tailwind v2/v3 legacy syntax, does not work in v4
<input className="placeholder-text-faint" />
```

### Injected CSS strings (DatePicker, DateRangeFilter)
```typescript
const css = `--rdp-accent-color: var(--color-primary);`
// var() resolves against document :root — works correctly
```

---

## Layout shell hierarchy

Every layout area has a mandated surface token. Deviate and layers lose contrast.

| Area | Token | Light | Dark |
|---|---|---|---|
| App root / outermost | `bg-canvas` | `#edf0f5` | `#09090b` |
| Top nav / side nav | `bg-base` | `#dce2ed` | `#18181b` |
| Main content area | `bg-canvas` | `#edf0f5` | `#09090b` |
| Cards / panels / modals | `bg-surface` | `#ffffff` | `#27272a` |
| Dropdown menus | `bg-surface-raised` | `#e2e8f2` | `#3f3f46` |
| Hover on white card | `bg-surface-raised` | `#e2e8f2` | `#3f3f46` |
| Input / textarea / select | `bg-surface-inset` | `#cdd5e3` | `#09090b` |
| Table alternate rows | `bg-surface-inset` | `#cdd5e3` | `#09090b` |

Modal border: `border border-card`. Dropdown border: `border border-border-subtle`.

---

## Complete token reference

Values shown as **light / dark**. Where only one value is listed, it's the same in both modes.

### Surfaces

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-canvas` | `#edf0f5` | `#09090b` | App background / outermost layer |
| `--color-base` | `#dce2ed` | `#18181b` | Sidebar / nav background |
| `--color-surface` | `#ffffff` | `#27272a` | Card, panel, modal surfaces |
| `--color-surface-raised` | `#e2e8f2` | `#3f3f46` | Elevated surfaces, hover states on surface |
| `--color-surface-inset` | `#cdd5e3` | `#09090b` | Inset wells, input fields, recessed areas |

### Text

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-text-primary` | `#0f172a` | `#ffffff` | Body text, headings — **use `text-text-primary`** |
| `--color-text-secondary` | `#334155` | `#d4d4d8` | Supporting / secondary labels |
| `--color-text-tertiary` | `#475569` | `#a1a1aa` | Tertiary labels, form hints |
| `--color-text-muted` | `#64748b` | `#71717a` | Muted / de-emphasized text |
| `--color-text-faint` | `#7c8ea6` | `#52525b` | Faint / placeholder / disabled text |
| `--color-text-inverse` | `#ffffff` | `#18181b` | Text on inverted backgrounds |
| `--color-text-link` | `#2563eb` | `#3b82f6` | Hyperlink text |
| `--color-text-on-surface` | `#475569` | `#e4e4e7` | Text on tinted schedule surfaces |
| `--color-success-bright-text` | `#15803d` | `#4ade80` | "Completed" / "Clocked In" emphasis text |

### Primary (blue)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-primary` | `#3b82f6` | same | Primary actions, focus rings, links |
| `--color-primary-hover` | `#2563eb` | same | Hover state for primary elements |
| `--color-primary-active` | `#1d4ed8` | same | Pressed/active state |
| `--color-primary-bg` | `rgba(59,130,246,0.10)` | `rgba(59,130,246,0.20)` | Primary background tint |
| `--color-primary-bg-subtle` | `rgba(59,130,246,0.06)` | `rgba(59,130,246,0.10)` | Subtle primary tint |
| `--color-primary-bg-dim` | `rgba(59,130,246,0.03)` | `rgba(59,130,246,0.06)` | Very faint primary tint |
| `--color-primary-border` | `rgba(59,130,246,0.20)` | `rgba(59,130,246,0.30)` | Primary-tinted border |
| `--color-primary-text` | `#1d4ed8` | `#93c5fd` | Badge/label text on primary tints |
| `--color-on-primary` | `#ffffff` | same | **Text/icon on any filled button** (primary, confirm, error, drive, pause, reviewing) |
| `--color-primary-disabled` | `#1e40af` | same | Disabled primary button background |

### Borders

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-border-subtle` | `#c5d1e5` | `#3f3f46` | Faint dividers, table row separators |
| `--color-border` | `#8fa6bf` | `#52525b` | Default component edge |
| `--color-border-strong` | `#6080a0` | `#71717a` | Emphasized headers, section boundaries |
| `--color-border-input` | `#5e7a98` | `#717179` | Input field boundary (strongest) |
| `--color-border-card` | `#b5c4db` | `#48484f` | Card inset edge |

Note: `bg-border` and `text-border` utilities are generated from `--color-border`. Avoid — use text semantics instead.

### Overlay

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-overlay` | `rgba(9,9,11,0.60)` | `rgba(9,9,11,0.75)` | Modal/sheet/drawer backdrops |

### Confirm CTA

| Token | Value | Usage |
|---|---|---|
| `--color-confirm` | `#16a34a` | Confirm/save CTA button fill |
| `--color-confirm-hover` | `#15803d` | Hover state |

Text on confirm buttons: `text-on-primary`.

### Status: Success

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-success` | `#059669` | same | Success indicators, dot colors |
| `--color-success-text` | `#15803d` | `#34d399` | Success badge/label text |
| `--color-success-bg` | `rgba(5,150,105,0.10)` | same | Success background tint |
| `--color-success-border` | `rgba(5,150,105,0.22)` | same | Success border |

Badge: `bg-success-bg text-success-text border border-success-border`

### Status: Error

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-error` | `#ef4444` | same | Error / destructive elements |
| `--color-error-strong` | `#dc2626` | same | Stronger error emphasis |
| `--color-error-text` | `#b91c1c` | `#f87171` | Error badge/label text |
| `--color-error-bg` | `rgba(239,68,68,0.10)` | same | Error background tint |
| `--color-error-border` | `rgba(239,68,68,0.22)` | same | Error border |

Badge: `bg-error-bg text-error-text border border-error-border`

### Status: Warning

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-warning` | `#d97706` | same | Warning indicators |
| `--color-warning-text` | `#92400e` | `#fbbf24` | Warning badge/label text |
| `--color-warning-bg` | `rgba(217,119,6,0.10)` | same | Warning background tint |
| `--color-warning-border` | `rgba(217,119,6,0.22)` | same | Warning border |

Badge: `bg-warning-bg text-warning-text border border-warning-border`

### Status: Info

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-info` | `#0891b2` | same | Info indicators |
| `--color-info-text` | `#0e7490` | `#67e8f9` | Info badge/label text |
| `--color-info-bg` | `rgba(8,145,178,0.10)` | same | Info background tint |
| `--color-info-border` | `rgba(8,145,178,0.22)` | same | Info border |

### Status: Reviewing (purple)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-reviewing` | `#7c3aed` | same | Quote "Reviewing" state |
| `--color-reviewing-text` | `#6d28d9` | `#a78bfa` | Reviewing badge/label text |
| `--color-reviewing-bg` | `rgba(124,58,237,0.10)` | same | Reviewing background tint |
| `--color-reviewing-border` | `rgba(124,58,237,0.22)` | same | Reviewing border |

### Status: Rejected (rose)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-rejected` | `#e11d48` | same | Rejected state |
| `--color-rejected-text` | `#be123c` | `#fb7185` | Rejected badge/label text |
| `--color-rejected-bg` | `rgba(225,29,72,0.10)` | same | Rejected background tint |
| `--color-rejected-border` | `rgba(225,29,72,0.22)` | same | Rejected border |

### Status: Neutral (draft, inactive)

No `-bg`/`-text`/`-border` companions. Use opacity modifier on the base token or direct text tokens.

Badge pattern: `bg-surface-raised text-text-tertiary border border-border-strong`

### Status: Orange (expired, disputed)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-orange` | `#ea580c` | same | Base for orange state |
| `--color-orange-text` | `#9a3412` | `#fb923c` | Orange badge/label text |
| `--color-orange-bg` | `rgba(234,88,12,0.10)` | same | Orange background tint |
| `--color-orange-border` | `rgba(234,88,12,0.22)` | same | Orange border |

### Recurring Plan action

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-plan` | `#9333ea` | same | "New Recurring Plan" button fill |
| `--color-plan-hover` | `#7e22ce` | same | Hover state |
| `--color-plan-text` | `#7e22ce` | `#c084fc` | Badge/chip text on plan-tinted backgrounds |

### Lifecycle action buttons (technician)

| Token | Value | Usage |
|---|---|---|
| `--color-action-drive` | `#1d4ed8` | "I'm Driving" button fill |
| `--color-action-drive-hover` | `#2563eb` | Hover state |
| `--color-action-pause` | `#d97706` | "Pause" button fill |
| `--color-action-pause-hover` | `#b45309` | Hover state |

### Priority strips

| Token | Value | Usage |
|---|---|---|
| `--color-priority-emergency` | `#dc2626` | Emergency |
| `--color-priority-urgent` | `#ea580c` | Urgent |
| `--color-priority-high` | `#ef4444` | High |
| `--color-priority-medium` | `#d97706` | Medium |
| `--color-priority-low` | `#059669` | Low |
| `--color-priority-default` | `#3b82f6` | Default/none |

### Visit Status

| Token | Value | Usage |
|---|---|---|
| `--color-visit-scheduled` | `#64748b` | Scheduled |
| `--color-visit-driving` | `#2563eb` | Driving/en-route |
| `--color-visit-onsite` | `#d97706` | On-site |
| `--color-visit-inprogress` | `#0891b2` | In-progress |
| `--color-visit-paused` | `#ea580c` | Paused |
| `--color-visit-delayed` | `#ca8a04` | Delayed |
| `--color-visit-completed` | `#16a34a` | Completed |
| `--color-visit-cancelled` | `#dc2626` | Cancelled |

### Visit Card Text (light/dark adaptive)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-visit-driving-text` | `#1d4ed8` | `#60a5fa` | Driving label |
| `--color-visit-completed-dark` | `#166534` | same | Completed strip (dark green) |
| `--color-visit-delayed-text` | `#92400e` | `#fb923c` | Delayed label |
| `--color-visit-paused-text` | `#9a3412` | `#facc15` | Paused label |

### Schedule Card Surfaces (light/dark adaptive)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-card-bg` | `#ffffff` | `#2a2d38` | Board visit card background |
| `--color-occurrence-bg` | `#faf7ff` | `#2d2f45` | Occurrence card background |
| `--color-popup-bg` | `#ffffff` | `#18181b` | Floating popup background |
| `--color-occurrence-border` | `rgba(109,40,217,0.15)` | `rgba(124,58,237,0.33)` | Violet border on occurrence cards |

### Schedule Text Variants (light/dark adaptive)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-sched-text-primary` | `#0f172a` | `#f4f4f5` | Card/popup primary text |
| `--color-sched-text-secondary` | `#475569` | `#d4d4d8` | Popup time/date labels |
| `--color-sched-text-muted` | `rgba(0,0,0,0.54)` | `rgba(255,255,255,0.38)` | Mini-card time labels |
| `--color-sched-text-client` | `rgba(0,0,0,0.60)` | `rgba(255,255,255,0.42)` | Client name in board cards |
| `--color-sched-text-time` | `rgba(0,0,0,0.70)` | `rgba(255,255,255,0.58)` | Time range label in board cards |
| `--color-sched-text-faint` | `#64748b` | `#52525b` | Close buttons, placeholder labels |
| `--color-sched-visit-title` | `#0f172a` | `#e2e8f0` | Visit card title (month view) |
| `--color-sched-occurrence-title` | `#6d28d9` | `#c4b5fd` | Occurrence card title (month view) |
| `--color-sched-occurrence-badge` | `#7c3aed` | same | Occurrence count badge fill |
| `--color-sched-today-bg` | `#dbeafe` | `#1e3a5f` | Today column highlight |
| `--color-sched-status-badge-bg` | `rgba(59,130,246,0.10)` | `rgba(59,130,246,0.15)` | Visit popup status badge bg |
| `--color-sched-status-badge-text` | `#1d4ed8` | `#93c5fd` | Visit popup status badge text |
| `--color-sched-open-ended-dash` | `rgba(0,0,0,0.22)` | `rgba(255,255,255,0.38)` | Dashed border on open-ended cards |

### Schedule Grid — calendar chrome (light/dark adaptive)

Own family, **not** `--color-border*`. The schedule board floor is `--color-canvas`; in every
light palette `--color-border` / `--color-border-subtle` land within ~1.2:1 of it, so grid lines
disappeared (month view worst — subtle `#e2e6ec` on canvas `#e6eaf0` is ~1.03:1). These carry
light values tuned against canvas. Dark values reproduce exactly what each site resolved to
before the family existed, so dark mode is unchanged.

| Token | Light | Warm | Neutral | Dark | Usage |
|---|---|---|---|---|---|
| `--color-grid-line` | `#c3ccd9` | `#cdc0ad` | `#c9c9c9` | `#3f3f46` | Month cell edges, weekday header rule |
| `--color-grid-line-strong` | `#b0bac9` | `#bcab94` | `#b6b6b6` | `#52525b` | Week column edges, hour lines, header/gutter rules |
| `--color-grid-line-minor` | `#dbe1e9` | `#e3dacb` | `#dedede` | `#111115` | Week half-hour lines |
| `--color-grid-cell-muted` | `#dde2ea` | `#ebe4d7` | `#e3e3e3` | `#18181b` | Other-month month cells |
| `--color-grid-today-tint` | `rgba(59,130,246,0.10)` | same | same | `rgba(59,130,246,0.04)` | Today cell/column wash |
| `--color-grid-float-bg` | `#ffffff` | `#fefdfa` | `#ffffff` | `#09090b` | Expanded-day overlay, scroll-affordance chips |

Two rules when touching these:
- A line token must always be **darker** than the surface it draws on in light mode. Half-hour
  lines previously used `--color-surface` (`#fafcfe`), which rendered as white scratches on the
  light canvas.
- `--color-grid-cell-muted` must never be brighter than an in-month cell. It was `--color-base`
  (`#ffffff`), which made out-of-month days the most prominent thing on the grid.

### Charts

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-chart-primary` | `#2563eb` | same | Primary data series |
| `--color-chart-success` | `#059669` | same | Success/green series |
| `--color-chart-warning` | `#d97706` | same | Warning/amber series |
| `--color-chart-info` | `#0891b2` | same | Info/cyan series |
| `--color-chart-error` | `#dc2626` | same | Error/red series |
| `--color-chart-fallback` | `#e3e8f0` | `#3f3f46` | Unknown/empty segment |
| `--color-chart-axis` | `#64748b` | `#a1a1aa` | Axis tick labels |
| `--color-chart-hole-bg` | `#edf0f5` | `#121212` | Donut center hole background |

Tooltip pattern:
```tsx
contentStyle={{
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text-primary)"
}}
```

### Tech Palette (map/feed — Paul Tol "light", colorblind-safe)

Tokens `--color-tech-1` through `--color-tech-9` plus `--color-tech-unassigned`. Same in both modes. Applied via `style={{ backgroundColor: techColor }}` — not Tailwind classes.

### Schedule Board Tech Palette (12 colors)

Tokens `--color-sched-tech-1` through `--color-sched-tech-12`. Same in both modes.

### Mapbox Geocoder

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-mapbox-bg` | `#ffffff` | `#17171a` | Geocoder input background |
| `--color-mapbox-bg-hover` | `#e2e8f2` | `#3f3f46` | Result hover background |
| `--color-mapbox-border` | `#bec9de` | `#505058` | Input border |

### Gradient / Special

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-gradient-tech-teal` | `#2dd4bf` | same | Technician stats gradient / stat accent |
| `--color-gradient-tech-teal-text` | `#0f766e` | `#5eead4` | Text on teal gradient |
| `--color-dispatcher-avatar-to` | `#8b5cf6` | same | Dispatcher avatar gradient end (violet) |

---

## Adding a new token

1. Add to `@theme` in `theme.css`:
   ```css
   --color-my-new-token: #hexvalue;
   ```
2. Add dark override in `[data-theme="dark"]` if it differs:
   ```css
   [data-theme="dark"] {
     --color-my-new-token: #darkvalue;
   }
   ```
3. Tailwind auto-generates `bg-my-new-token`, `text-my-new-token`, `border-my-new-token`
4. Use: `className="bg-my-new-token"` or `style={{ color: "var(--color-my-new-token)" }}`

No config file changes needed.

---

## Dark/light mode architecture

`@theme` block holds **light mode** defaults ("Zinc Daylight v3": cool blue-gray canvas, white surfaces, slate text).  
`[data-theme="dark"]` in `theme.css` overrides the ~60 tokens that differ in dark mode (zinc-950/900/800 surfaces, near-white text).

- Toggle: `document.documentElement.dataset.theme = "dark" | "light"`
- State: `src/stores/themeStore.ts` (Zustand + localStorage, key `"theme-preference"`)
- Applied: `useApplyTheme()` hook in `App.tsx`
- Default: `"dark"` — applied before first render from localStorage
- No component files reference theme directly — only `theme.css` needs changing if palette adjusts

Chrome Windows injection fix: `index.css` has explicit `background-color`/`color` overrides for `input.bg-surface-inset`, `input.bg-surface`, `input.bg-base` (and textarea/select variants). If you add a new surface token to inputs, add an override block there too.

---

## Organization theming (future)

Per-org accent: inject `<style>` on a wrapper `<div>` overriding `--color-primary` and related tokens. No component changes.

```tsx
<div style={{ "--color-primary": org.accentColor } as React.CSSProperties}>
  {/* app subtree */}
</div>
```

---

## Known exceptions

- `CARD_SHADOW` / `CARD_SHADOW_HOVERED` in `scheduleTokens.ts` — box-shadow rgba blacks/whites; intentionally universal
- `OPEN_ENDED_GRADIENT` in `scheduleTokens.ts` — fade-to-black gradient; intentionally universal
- `--anim-primary-80`, `--anim-primary-30`, `--anim-surface-flash` in `index.css` — animation intermediates; outside `@theme` intentionally
- `bg-error/30` in `PartsUsedSection.tsx` — error quantity highlight; opacity modifier on hex is correct here
- `bg-success/25`, `border-warning/25` in `VisitActionButtons.tsx` — same rationale
- Schedule board rgba() inline styles (MonthGrid, ScheduleBoardDayColumn, WeekStrip, etc.) — dynamic opacity values that encode drag/today/animation states; cannot be static tokens

## Undefined / dangerous tokens (do not use)

- `bg-surface-strong` — **undefined**; generates no style. Use `bg-surface-inset` (darker inset) or `bg-border` (medium)
- `bg-surface/40`, `bg-surface/50`, `bg-base/40` — opacity on surface = near-invisible in light mode (white at 40% ≈ nothing). Use solid tiers instead
- `--color-surface` (or any surface token) **as a line/border color** — surfaces sit *above* canvas in light mode, so the "line" draws brighter than its background. Use the `--color-grid-line*` family on calendar chrome, `--color-border*` elsewhere
- `--color-border` / `--color-border-subtle` **on the schedule board** — both collapse into `--color-canvas` in light palettes (~1.03–1.19:1). Use `--color-grid-line` / `--color-grid-line-strong`
- `text-primary` for body text — **wrong**; this is `--color-primary` = blue #3b82f6. Use `text-text-primary`
- `text-white` on surface-level elements — invisible in light mode. Use `text-text-primary`
- `hover:text-white` on icon buttons — invisible in light mode. Use `hover:text-text-primary`
- `placeholder-text-faint` / `placeholder-zinc-500` — Tailwind v2/v3 syntax; broken in v4. Use `placeholder:text-faint`
