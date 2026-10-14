# Color Audit

Pre-refactor → semantic token mapping for the HVAC frontend color tokenization.

## Standardizations

Intentional shade collapses: cases where two similar values were unified under one token.

| Original Value | Original Context | Unified Token | Note |
|---|---|---|---|
| `#6b7280` (gray-500) | default fallback in several util files | `--color-text-muted` (#71717a zinc-500) | 1-step hue shift from gray to zinc, imperceptible |
| `#e4e4e7` (zinc-200) | schedule-x `on-surface`, date-picker text | `--color-text-on-surface` | distinct from `text-primary` (#fff) — slightly off-white for tinted surfaces |
| `text-blue-300` + `text-blue-400` | various badge text | `text-primary-text` | collapsed to `--color-primary-text` (#93c5fd blue-300) |
| `text-emerald-400` + `text-green-400` | success text variants | `text-success-text` | collapsed to `--color-success-text` (#34d399 emerald-400) |
| `text-amber-400` + `text-yellow-400` | warning text variants | `text-warning-text` | collapsed to `--color-warning-text` (#fbbf24 amber-400) |

---

## Full Mapping Table

### Surfaces

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `index.css`, various components | `#09090b` (zinc-950) | `--color-canvas` | Page/app background |
| various components | `#18181b` (zinc-900) | `--color-base` | Primary surface background |
| various components | `#27272a` (zinc-800) | `--color-surface` | Card/panel surfaces |
| various components | `#3f3f46` (zinc-700) | `--color-surface-raised` | Elevated surfaces, hover states |
| various components | `#09090b` (zinc-950) | `--color-surface-inset` | Inset/recessed surfaces |
| `scheduleTokens.ts`, `ScheduleBoardCard.tsx` | `#2a2d38` | `--color-card-bg` | Schedule board visit card background (blue-tinted zinc) |
| `scheduleTokens.ts`, month view | `#2d2f45` | `--color-occurrence-bg` | Recurring occurrence card background (purple-tinted zinc) |
| `scheduleTokens.ts`, popups | `#18181b` | `--color-popup-bg` | Floating popup background (zinc-900) |

### Text

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| various components | `#ffffff` / `text-white` | `--color-text-primary` | Primary text |
| various components | `#d4d4d8` (zinc-300) | `--color-text-secondary` | Secondary / supporting text |
| various components | `#a1a1aa` (zinc-400) | `--color-text-tertiary` | Tertiary / label text |
| various components | `#71717a` (zinc-500) | `--color-text-muted` | Muted / placeholder text |
| various util/badge files | `#6b7280` (gray-500) | `--color-text-muted` | Unassigned/fallback — standardized to zinc-500 (see Standardizations) |
| various components | `#52525b` (zinc-600) | `--color-text-faint` | Faint / disabled text |
| various components | `#18181b` (zinc-900) | `--color-text-inverse` | Text on light/inverted surfaces |
| various components | `#3b82f6` (blue-500) | `--color-text-link` | Anchor/link text |
| `DatePicker.tsx`, `DateRangeFilter.tsx` | `#e4e4e7` (zinc-200) | `--color-text-on-surface` | Schedule-x and date-picker text on tinted surfaces (see Standardizations) |
| `TechVisitCard.tsx`, green completion states | `#4ade80` (green-400) | `--color-success-bright-text` | "Clocked In" / "Completed" text on dark gradient strips — brighter than emerald-400 for legibility |

### Primary (blue)

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| various components | `#3b82f6` (blue-500) | `--color-primary` | Primary action color |
| various components | `#2563eb` (blue-600) | `--color-primary-hover` | Hover state for primary elements |
| various components | `#1d4ed8` (blue-700) | `--color-primary-active` | Active/pressed state |
| various components | `rgba(59,130,246,0.20)` | `--color-primary-bg` | Primary color background tint |
| various components | `rgba(59,130,246,0.10)` | `--color-primary-bg-subtle` | Subtle primary background |
| various components | `rgba(59,130,246,0.06)` | `--color-primary-bg-dim` | Very faint primary background |
| various components | `rgba(59,130,246,0.30)` | `--color-primary-border` | Primary-tinted border |
| badge components | `#93c5fd` (blue-300) | `--color-primary-text` | Primary badge/label text (collapsed from blue-300/blue-400) |
| button components | `#ffffff` | `--color-on-primary` | Text/icon on primary button fill |

### Borders

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| various components | `#27272a` (zinc-800) | `--color-border-subtle` | Subtle dividers |
| various components | `#3f3f46` (zinc-700) | `--color-border` | Default border |
| various components | `#52525b` (zinc-600) | `--color-border-strong` | Emphasized border |
| form inputs | `#505058` | `--color-border-input` | Input field border |
| `ClientCard.tsx`, `DispatcherCard.tsx`, `InventoryItemView.tsx` | `#3a3a3f` | `--color-border-card` | Card inset border — sits between `border-subtle` and `border` |

### Confirm (green CTA)

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| confirm/save buttons | `#16a34a` (green-600) | `--color-confirm` | Confirm/save CTA button fill |
| confirm/save buttons | `#22c55e` (green-500) | `--color-confirm-hover` | Hover state for confirm button |

### Status: Success

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| status badges, charts | `#10b981` (emerald-500) | `--color-success` | Success indicator |
| success text | `#34d399` (emerald-400) | `--color-success-text` | Success badge/label text (collapsed from emerald-400/green-400) |
| status backgrounds | `rgba(16,185,129,0.15)` | `--color-success-bg` | Success background tint |
| status borders | `rgba(16,185,129,0.30)` | `--color-success-border` | Success border |

### Status: Error

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| error/destructive elements | `#ef4444` (red-500) | `--color-error` | Error/destructive color |
| error elements | `#dc2626` (red-600) | `--color-error-strong` | Stronger error emphasis |
| error text | `#f87171` (red-400) | `--color-error-text` | Error badge/label text |
| error backgrounds | `rgba(239,68,68,0.15)` | `--color-error-bg` | Error background tint |
| error borders | `rgba(239,68,68,0.30)` | `--color-error-border` | Error border |

### Status: Warning

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| warning badges | `#f59e0b` (amber-500) | `--color-warning` | Warning indicator |
| warning text | `#fbbf24` (amber-400) | `--color-warning-text` | Warning badge/label text (collapsed from amber-400/yellow-400) |
| warning backgrounds | `rgba(245,158,11,0.15)` | `--color-warning-bg` | Warning background tint |
| warning borders | `rgba(245,158,11,0.30)` | `--color-warning-border` | Warning border |

### Status: Info

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| info badges | `#06b6d4` (cyan-500) | `--color-info` | Info indicator |
| info text | `#67e8f9` (cyan-300) | `--color-info-text` | Info badge/label text |
| info backgrounds | `rgba(6,182,212,0.15)` | `--color-info-bg` | Info background tint |
| info borders | `rgba(6,182,212,0.30)` | `--color-info-border` | Info border |

### Status: Reviewing (purple)

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| reviewing badges | `#8b5cf6` (violet-500) | `--color-reviewing` | Quote reviewing state |
| reviewing text | `#a78bfa` (violet-400) | `--color-reviewing-text` | Reviewing badge/label text |
| reviewing backgrounds | `rgba(139,92,246,0.20)` | `--color-reviewing-bg` | Reviewing background tint |
| reviewing borders | `rgba(139,92,246,0.30)` | `--color-reviewing-border` | Reviewing border |

### Status: Rejected (rose)

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| rejected badges | `#f43f5e` (rose-500) | `--color-rejected` | Rejected state |
| rejected text | `#fb7185` (rose-400) | `--color-rejected-text` | Rejected badge/label text |
| rejected backgrounds | `rgba(244,63,94,0.20)` | `--color-rejected-bg` | Rejected background tint |
| rejected borders | `rgba(244,63,94,0.30)` | `--color-rejected-border` | Rejected border |

### Priority

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `scheduleBoardUtils.ts`, priority strips | `#dc2626` (red-600) | `--color-priority-emergency` | Emergency priority |
| `scheduleBoardUtils.ts`, priority strips | `#ea580c` (orange-600) | `--color-priority-urgent` | Urgent priority |
| `scheduleBoardUtils.ts`, priority strips | `#ef4444` (red-500) | `--color-priority-high` | High priority |
| `scheduleBoardUtils.ts`, priority strips | `#f59e0b` (amber-500) | `--color-priority-medium` | Medium priority |
| `scheduleBoardUtils.ts`, priority strips | `#10b981` (emerald-500) | `--color-priority-low` | Low priority |
| `scheduleBoardUtils.ts`, priority strips | `#3b82f6` (blue-500) | `--color-priority-default` | Default/none priority |

### Visit Status

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `visitFeedUtils.ts`, status badges | `#71717a` (zinc-500) | `--color-visit-scheduled` | Scheduled status dot/badge |
| `visitFeedUtils.ts`, status badges | `#3b82f6` (blue-500) | `--color-visit-driving` | Driving/en-route status |
| `visitFeedUtils.ts`, status badges | `#f59e0b` (amber-500) | `--color-visit-onsite` | On-site status |
| `visitFeedUtils.ts`, status badges | `#06b6d4` (cyan-500) | `--color-visit-inprogress` | In-progress status |
| `visitFeedUtils.ts`, status badges | `#f97316` (orange-500) | `--color-visit-paused` | Paused status |
| `visitFeedUtils.ts`, status badges | `#eab308` (yellow-500) | `--color-visit-delayed` | Delayed status |
| `visitFeedUtils.ts`, status badges | `#22c55e` (green-500) | `--color-visit-completed` | Completed status |
| `visitFeedUtils.ts`, status badges | `#ef4444` (red-500) | `--color-visit-cancelled` | Cancelled status |

### Visit Card Text Variants

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `TechVisitCard.tsx` | `#60a5fa` (blue-400) | `--color-visit-driving-text` | Driving state label text |
| `TechVisitCard.tsx` | `#166534` (green-800) | `--color-visit-completed-dark` | Completed gradient strip (dark green) |
| `TechVisitCard.tsx` | `#fb923c` (orange-400) | `--color-visit-delayed-text` | Delayed state label text |
| `TechVisitCard.tsx` | `#facc15` (yellow-400) | `--color-visit-paused-text` | Paused state label text |

### Schedule Card Surfaces

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `scheduleTokens.ts` | `#2a2d38` | `--color-card-bg` | Board card background |
| `scheduleTokens.ts` | `#2d2f45` | `--color-occurrence-bg` | Occurrence card background |
| `scheduleTokens.ts` | `#18181b` | `--color-popup-bg` | Popup/overlay background |

### Schedule Text Variants

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `scheduleTokens.ts`, `ScheduleBoardCard.tsx` | `#f4f4f5` (zinc-100) | `--color-sched-text-primary` | Card/popup primary text |
| `scheduleTokens.ts`, various schedule components | `#d4d4d8` (zinc-300) | `--color-sched-text-secondary` | Popup time/date labels |
| `scheduleTokens.ts` | `rgba(255,255,255,0.38)` | `--color-sched-text-muted` | Month mini-card time labels |
| `scheduleTokens.ts` | `rgba(255,255,255,0.42)` | `--color-sched-text-client` | Client name in board cards |
| `scheduleTokens.ts` | `rgba(255,255,255,0.58)` | `--color-sched-text-time` | Time range label in board cards |
| `scheduleTokens.ts` | `#52525b` (zinc-600) | `--color-sched-text-faint` | Close buttons, placeholder labels |
| `dashboardCalendarUtils.ts`, month view | `#e2e8f0` (slate-200) | `--color-sched-visit-title` | Visit card title in month view |
| `dashboardCalendarUtils.ts`, month view | `#c4b5fd` (violet-300) | `--color-sched-occurrence-title` | Occurrence card title in month view |
| `ScheduleBoard.tsx`, occurrence badges | `#7c3aed` (violet-600) | `--color-sched-occurrence-badge` | Occurrence count badge fill |
| `ScheduleBoard.tsx`, today column | `#1e3a5f` | `--color-sched-today-bg` | Today column highlight background |
| `scheduleTokens.ts`, visit popup | `rgba(59,130,246,0.15)` | `--color-sched-status-badge-bg` | Visit status badge background |
| `scheduleTokens.ts`, visit popup | `#93c5fd` (blue-300) | `--color-sched-status-badge-text` | Visit status badge text |
| `scheduleTokens.ts` | `rgba(255,255,255,0.38)` | `--color-sched-open-ended-dash` | Dashed bottom border on open-ended cards |

### Charts

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `RevenueYTDChart.tsx`, `RevenueByJobTypeChart.tsx`, `ArrivalPerformanceChart.tsx` | `#3b82f6` (blue-500) | `--color-chart-primary` | Primary data series |
| `RevenueByJobTypeChart.tsx`, `ArrivalPerformanceChart.tsx` | `#10b981` (emerald-500) | `--color-chart-success` | Success/green data series |
| chart components | `#f59e0b` (amber-500) | `--color-chart-warning` | Warning/amber data series |
| `ArrivalPerformanceChart.tsx` | `#06b6d4` (cyan-500) | `--color-chart-info` | Info/cyan data series |
| `ArrivalPerformanceChart.tsx` | `#ef4444` (red-500) | `--color-chart-error` | Error/red data series |
| `RevenueByJobTypeChart.tsx`, pie charts | `#3f3f46` (zinc-700) | `--color-chart-fallback` | Unknown/empty segment fill |
| chart axes | `#a1a1aa` (zinc-400) | `--color-chart-axis` | Axis tick labels |
| `RevenueByJobTypeChart.tsx` | `#121212` | `--color-chart-hole-bg` | Donut chart center hole background |

### Tech Palette (map/feed — Paul Tol "light")

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `techColors.ts` | `#77AADD` | `--color-tech-1` | Technician color slot 1 |
| `techColors.ts` | `#EE8866` | `--color-tech-2` | Technician color slot 2 |
| `techColors.ts` | `#EEDD88` | `--color-tech-3` | Technician color slot 3 |
| `techColors.ts` | `#FFAABB` | `--color-tech-4` | Technician color slot 4 |
| `techColors.ts` | `#99DDFF` | `--color-tech-5` | Technician color slot 5 |
| `techColors.ts` | `#44BB99` | `--color-tech-6` | Technician color slot 6 |
| `techColors.ts` | `#BBCC33` | `--color-tech-7` | Technician color slot 7 |
| `techColors.ts` | `#AAAA00` | `--color-tech-8` | Technician color slot 8 |
| `techColors.ts` | `#DDDDDD` | `--color-tech-9` | Technician color slot 9 |

### Schedule Board Tech Palette (12 colors)

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `scheduleBoardUtils.ts` | `#3b82f6` | `--color-sched-tech-1` | Board tech color slot 1 |
| `scheduleBoardUtils.ts` | `#10b981` | `--color-sched-tech-2` | Board tech color slot 2 |
| `scheduleBoardUtils.ts` | `#f59e0b` | `--color-sched-tech-3` | Board tech color slot 3 |
| `scheduleBoardUtils.ts` | `#8b5cf6` | `--color-sched-tech-4` | Board tech color slot 4 |
| `scheduleBoardUtils.ts` | `#ef4444` | `--color-sched-tech-5` | Board tech color slot 5 |
| `scheduleBoardUtils.ts` | `#06b6d4` | `--color-sched-tech-6` | Board tech color slot 6 |
| `scheduleBoardUtils.ts` | `#f97316` | `--color-sched-tech-7` | Board tech color slot 7 |
| `scheduleBoardUtils.ts` | `#ec4899` | `--color-sched-tech-8` | Board tech color slot 8 |
| `scheduleBoardUtils.ts` | `#84cc16` | `--color-sched-tech-9` | Board tech color slot 9 |
| `scheduleBoardUtils.ts` | `#14b8a6` | `--color-sched-tech-10` | Board tech color slot 10 |
| `scheduleBoardUtils.ts` | `#a855f7` | `--color-sched-tech-11` | Board tech color slot 11 |
| `scheduleBoardUtils.ts` | `#eab308` | `--color-sched-tech-12` | Board tech color slot 12 |

### Mapbox Geocoder

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| Mapbox geocoder theme injection | `#17171a` | `--color-mapbox-bg` | Geocoder input background |
| Mapbox geocoder theme injection | `#3f3f46` (zinc-700) | `--color-mapbox-bg-hover` | Geocoder result hover background |
| Mapbox geocoder theme injection | `#505058` | `--color-mapbox-border` | Geocoder input border |

### Gradient / Special

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| `TechnicianDetailPage.tsx`, gradient | `#2dd4bf` (teal-400) | `--color-gradient-tech-teal` | Technician stats gradient end color (teal) |
| `DispatchLayout.tsx`, avatar gradient | `#8b5cf6` (violet-500) | `--color-dispatcher-avatar-to` | Dispatcher avatar gradient end color |

### Unassigned Tech Fallback

| File(s) | Original Value | Semantic Token | Context |
|---|---|---|---|
| various util files | `#6b7280` (gray-500) | `--color-tech-unassigned` | Fallback color for unassigned/unknown technician slot (see Standardizations) |
