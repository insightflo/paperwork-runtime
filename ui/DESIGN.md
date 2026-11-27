# Paperwork UI Design System

## 1. Atmosphere & Identity

Paperwork reads like a well-set document: warm paper surfaces, deep ink text, and hairline rules that separate evidence without shouting. Pages should make status, ownership, and next action scannable the way a marked-up draft does, with restrained borders and no neon glow, gradients, or marketing composition.

## 2. Color

The token grammar is **paper + ink + oxblood + sage**. `--pw-lime` / `--pw-cobalt` keep their legacy names as aliases so existing components keep working, but they now resolve to sage (live) and oxblood (accent).

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Paper canvas | `--background`, `--pw-canvas` | `#f3eee4` | `#171412` | Page and shell background |
| Sheet surface | `--card`, `--popover`, `--pw-card` | `#fbf8f1` | `#1f1b18` | Panels, dialogs, repeated items |
| Ink | `--foreground`, `--pw-ink` | `#1f1b16` | `#efe9dd` | Primary text |
| Muted ink | `--muted-foreground`, `--pw-muted` | `#6b6358` | `#a39b8f` | Captions and metadata |
| Muted surface | `--muted`, `--accent`, `--secondary` | `#ebe5d8` | `#262019` | Hover and selected nav states |
| Hairline | `--border`, `--pw-hairline` | `rgba(31, 27, 22, 0.12)` | `rgba(239, 233, 221, 0.10)` | Dividers and panels |
| Strong hairline | `--pw-hairline-strong` | `rgba(31, 27, 22, 0.24)` | `rgba(239, 233, 221, 0.20)` | Hovered and active borders |
| Oxblood accent | `--primary`, `--ring`, `--pw-cobalt` | `#9a3b2e` | `#d9705f` | Primary actions, focus rings, selected chips |
| Sage live indicator | `--pw-lime`, `--pw-emerald` | `#4f7d5a` | `#8fbf9a` | Running / live status dots and lines |
| Ochre warning | `--pw-amber` | `#a16207` | `#d2a648` | Attention and warning states |
| Brick danger | `--destructive`, `--pw-crimson` | `#b91c1c` | `#e2574a` | Failed or blocked states |

Soft variants (`--pw-cobalt-soft`, `--pw-lime-soft`, `--pw-amber-soft`, `--pw-crimson-soft`) are low-alpha tints of the same hue for selected rows and badges. `--pw-lime-glow` and `--pw-cobalt-glow` remain defined for callers but are muted tints, not neon.

Use existing semantic Tailwind tokens (`bg-background`, `text-muted-foreground`, `border-border`, `bg-primary`) instead of raw colors.

## 3. Typography

Primary font is a warm humanist sans stack defined by `--font-sans`: `"Pretendard Variable", "Pretendard", "Apple SD Gothic Neo", "Inter", system-ui, sans-serif`. Use `text-sm` for body rows, `text-xs` for metadata and overlines, `text-xl` for compact page headings, and `font-semibold` only for key labels. Letter spacing stays default except existing uppercase overlines. Numeric readouts use `.pw-tabular` for tabular figures.

## 4. Spacing & Layout

Spacing follows a 4px base through Tailwind tokens. Operational pages use `space-y-4` or `space-y-6`, compact rows use `gap-2` or `gap-3`, and content should remain full-width inside the app shell. Prefer grids and tables that collapse to stacked rows on mobile.

## 5. Components

### Paper Sheet (`.tactile-card`, `.pw-sheet`)
- Structure: `--pw-card` surface, single 1px `--pw-hairline` border, `--radius-lg` corners, and a barely-there flat shadow.
- States: default hairline, hover `--pw-hairline-strong` via `.tactile-card-interactive`.
- Rule: no inset specular highlight, no neon glow, no gradient fill.

### Live Indicator (`.pw-live-dot`)
- Structure: 6px sage dot (`--pw-lime`) with a slow 2.4s pulse.
- Rule: no `box-shadow` glow; the color alone signals "live".

### Sidebar Item
- Structure: icon, one-line label, optional badge.
- States: default muted text, hover `bg-accent/50`, active `bg-accent` with a strong hairline border.
- Accessibility: real links/buttons with readable labels.

### Evidence Row
- Structure: title, summary, metadata, optional action link.
- States: default border row, hover only when clickable, empty state through `EmptyState`.
- Accessibility: preserve text wrapping and provide explicit links for navigation.

### Status Badge
- Structure: compact text token using the sage / ochre / brick status tokens.
- States: informational, attention, blocked, failed, completed.
- Accessibility: do not rely on color alone; include visible status text.

## 6. Motion & Interaction

Use existing button/link transitions only. Do not add decorative motion. Loading uses existing skeletons or muted text.

## 7. Depth & Surface

Depth strategy is borders-first. Use `border border-border` and occasional `bg-muted/30`; avoid colored glows, nested cards, and decorative gradients. The app canvas (`--pw-canvas`) is a flat warm paper tone in both modes with no radial color washes.
