# Trailhead design system

Files: `css/tokens.css` (variables) · `css/base.css` (reset, typography, utilities) · `css/components.css` (components) · `design-system.html` (living style guide: open it through any static server, e.g. `python3 -m http.server`, then `/design-system.html`).

Load order in every page: `tokens.css`, `base.css`, `components.css`, then view CSS (`views-*.css`). Fonts: Bricolage Grotesque (display) and Inter (UI) from Google Fonts, as in `index.html`.

## 1. Principles

1. **Derived from the current look.** Burgundy surfaces, cream text, gold and olive for the two people, soft shadows, gradient gold primary buttons, Bricolage for numbers and headings.
2. **Strava-like, mobile first.** Cards in a feed, big stats, a bottom tab bar with a central record button, bottom sheets for forms. From 640px the sheet becomes a centred dialog and the content is capped at 780px.
3. **Two layers of tokens.** Primitives (`--gold-400`) are raw ramps. Semantic tokens (`--color-accent`) are what components use. Re-theming means editing the semantic layer only.
4. **Colour is never the only signal.** Status uses a glyph or text next to the colour. Person colours always come with the name, initial or a dot with a label.
5. **Accessible by default.** WCAG 2.1 AA contrast (verified, section 6), 44px touch targets, visible focus ring, `prefers-reduced-motion` respected.

## 2. Rules for UI authors

- **Tokens only.** No raw hex or rgba, no pixel spacing. Use `var(--color-*)`, `var(--space-*)`, `var(--text-*)`, `var(--radius-*)`, `var(--shadow-*)`, `var(--duration-*)`. Component-internal sizes (an icon, an avatar) may be local `rem` values. View CSS files follow the same rule.
- **Use semantic tokens, never primitives** (`--color-accent`, not `--gold-400`; `--color-person-a`, not `--gold-400`).
- **Person colours are `a` and `b`, not names.** Classes and variables are `--a` / `--b` / `--color-person-a` / `--color-person-b`. Who is `a` is data (`store.names`). Person A is gold, person B is olive, and they are close in hue (contrast 1.25:1 between them): always label them.
- **Spacing** comes from the 4px scale. Between siblings use `.stack` / `.row` / `.grid` instead of margins. Card padding is built in.
- **Do not restyle components in view CSS.** Add a modifier here if something is missing. View CSS may arrange components (grid, spacing) and style view-specific parts.
- **Breakpoints are `min-width` only:** base (phone) < 640px < `@media (min-width: 640px)` < `@media (min-width: 960px)`. Values are written literally because custom properties do not work in media queries.
- **A11y:**
  - Every interactive element is a real `<button>`, `<a>` or form control. Icon-only buttons need `aria-label`.
  - Selected state: set both `.is-active` and the right ARIA (`aria-pressed` for toggles, `aria-selected` for tabs, `aria-current="page"` for navigation).
  - Sheets: `role="dialog" aria-modal="true" aria-labelledby`, focus the first control on open, close on Esc, restore focus, add `.is-scroll-locked` to `<body>` while open.
  - Toasts: `role="status"` (or `alert` for errors). Progress: `role="progressbar"` with `aria-valuenow`.
  - Never remove the focus outline. Do not hide text with `display:none` if screen readers need it: use `.sr-only`.
  - Do not shrink touch targets below 44px; `.btn--sm`, `.chip`, `.kudos-btn` already pad their hit area.
- **Motion:** use the duration/easing tokens. Transform and opacity only. Reduced motion collapses durations to 0.01ms automatically.
- **Icons:** inline SVG, 24px viewBox, stroke style, class `.icon` (colour follows text). A ready sprite (`i-plus`, `i-feed`, `i-plan`, `i-stats`, `i-notes`, `i-bell`, `i-x`, `i-check`, `i-camera`, `i-trash`, `i-chevron`, `i-flag`, `i-info`, `i-alert`, `i-settings`) is at the top of `design-system.html`: copy it into `index.html` and use `<svg class="icon"><use href="#i-plus"/></svg>`. Emoji are fine for sports and kudos.

## 3. Token reference

### Colour (semantic)

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#4a1420` | page background |
| `--color-surface` | `#5a1c29` | cards, list groups |
| `--color-surface-raised` | `#642130` | sheets, toasts, raised panels |
| `--color-surface-inset` | `rgba(0,0,0,.18)` | input wells, recessed blocks (over a surface) |
| `--color-surface-glass` | `rgba(74,20,32,.92)` | app bar, tab bar |
| `--color-overlay` | `rgba(20,4,8,.62)` | sheet backdrop |
| `--color-hover` / `--color-pressed` | cream at 6% / 12% | hover and press wash |
| `--color-border` | `#7a3244` | decorative dividers and card edges |
| `--color-border-strong` | `#b27a8a` | input outlines, chip outlines (3:1) |
| `--color-text` / `--color-text-strong` | `#f5ead9` / `#fff8ec` | body / headings and key numbers |
| `--color-text-muted` | `#d9b3ba` | secondary text |
| `--color-text-faint` | `#c99ba6` | captions, labels (AA on bg, surface and raised) |
| `--color-accent` / `--color-accent-strong` | `#eeb81c` / `#dba233` | primary actions, highlights |
| `--color-accent-soft` | gold at 12% | tinted backgrounds |
| `--color-on-accent` | `#3a0f18` | ink on gold |
| `--color-secondary` / `--color-secondary-soft` | `#d8c08a` / `#6b3644` | sage text and tracks |
| `--color-person-a` (+ `-strong`, `-soft`) | `#eeb81c`, `#dba233`, gold 12% | person A |
| `--color-person-b` (+ `-strong`, `-soft`) | `#bcae32`, `#c7e0a4`, olive 8% | person B |
| `--color-on-person` | `#3a0f18` | ink on either person colour |
| `--color-success` `--color-warning` `--color-danger` `--color-info` | `#a3d9a0` `#ffb86b` `#ff9d9d` `#a6cdec` | status text/icons (each has `-soft` tint) |
| `--color-success-solid` `--color-danger-solid` | `#2f6b3a` `#a8322f` | solid fills; text on them is `--color-on-solid` |
| `--color-focus` | `#fff8ec` | focus ring (`--focus-ring-width` 2px, `--focus-ring-offset` 2px) |
| `--gradient-accent` | gold 400 to 500 | primary buttons, record button, default progress |
| `--gradient-card` | surface to dark gold | `.card--hero` |
| `--gradient-person-a` / `-b` | | progress fills |

Primitives: `--burgundy-950/900/800/700/600/500`, `--cream-50/100`, `--rose-300/400`, `--gold-300/400/500/800/900`, `--olive-300/400/900`, `--sage-300/800`, `--green-300/700`, `--orange-300`, `--red-300/700`, `--blue-300`.

### Spacing, type, radius, elevation, motion, layers, layout

| Group | Tokens |
|---|---|
| Spacing (4px) | `--space-half` 2 · `-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40 · `-12` 48 · `-16` 64 |
| Font | `--font-display` Bricolage Grotesque · `--font-ui` Inter |
| Size | `--text-xs` 12 · `-sm` 14 · `-md` 16 · `-lg` 18 · `-xl` 22 · `-2xl` 28 · `-3xl` 32 to 40 (fluid) · `-4xl` 40 to 56 (fluid) |
| Weight | `--weight-regular/medium/semibold/bold/extrabold` 400 to 800 |
| Leading | `--leading-none` 1 · `-tight` 1.1 · `-snug` 1.3 · `-normal` 1.5 · `-relaxed` 1.65 |
| Tracking | `--tracking-tight` -0.02em · `-normal` 0 · `-wide` 0.04em · `-wider` 0.1em |
| Radius | `--radius-xs` 4 · `-sm` 8 · `-md` 12 · `-lg` 16 · `-xl` 24 · `-full` pill. Borders: `--border-width` 1px, `--border-width-strong` 2px |
| Shadow | `--shadow-1` hairline · `-2` card (0 8px 24px / .25) · `-3` dialog/toast · `-up` sheet and tab bar · `--shadow-glow-accent` record button |
| Motion | `--duration-instant/fast/base/slow` 80/140/220/320ms · `--ease-standard/out/in/spring` |
| Z-index | `--z-base` 0 · `-raised` 10 · `-sticky` 100 (app bar) · `-tabbar` 300 · `-fab` 350 · `-sheet` 410 · `-toast` 500 · `-gate` 1000 |
| Layout | `--content-max` 780px · `--gutter` 16px (24 from 640) · `--appbar-height` 56 · `--tabbar-height` 64 · `--safe-top/right/bottom/left` · `--touch-min` 44 · `--control-h-sm/md/lg` 36/44/52 · `--icon-sm` 16 · `--icon-md` 24 |

## 4. Base and utilities (`base.css`)

Reset, `body` (burgundy background, Inter 16px, left/right safe-area padding), `h1`-`h4` (Bricolage, tight tracking), links (gold), global `:focus-visible` ring, selection, thin scrollbars, reduced motion.

| Class | Effect |
|---|---|
| `.container` | max 780px, centred, `--gutter` side padding |
| `.has-tabbar` | on `<body>`/root: bottom padding for the fixed tab bar + safe area |
| `.safe-top` | top padding = `env(safe-area-inset-top)` for pages without `.appbar` |
| `.is-scroll-locked` | on `<body>` while a sheet is open |
| `.sr-only` | visually hidden, screen-reader visible |
| `.stack` (`--sm` 8, `--md` 12, default 16, `--lg` 24, `--xl` 32) | vertical flex with gap |
| `.row` (`--sm`, `--lg`, `--wrap`, `--between`, `--end`, `--center`, `--start`), `.grow`, `.shrink-0` | horizontal flex, vertically centred |
| `.grid` + `--1/2/3/4` (columns), `--auto` (min 14rem), `--gap-sm`, `--gap-lg`, `--stack-mobile` | equal-width grid; `--stack-mobile` = one column below 640px |
| `.gap-1/2/3/4/6` | gap override |
| `.mt-auto` | push to the end of a flex column |
| `.hide-mobile` / `.show-mobile` | hidden / shown below 640px |
| `.text-display`, `.text-ui` | font family |
| `.text-strong/muted/faint/accent/a/b/success/warning/danger/info` | colour |
| `.text-xs … .text-4xl`, `.text-medium/semibold/bold`, `.text-left/center/right` | size, weight, align |
| `.text-eyebrow` | small uppercase tracking label |
| `.num` | tabular numbers |
| `.truncate`, `.pre-wrap` | text overflow, preserve line breaks |
| `.icon` (`--sm`, `--lg`) | stroke SVG icon, 24px, follows text colour |

## 5. Component catalogue (`components.css`)

State conventions: `:hover`, `:active`, `:focus-visible` and `:disabled` are built in. Selected = `.is-active` or the ARIA attribute. Busy = `.is-loading`. Soft-disabled = `.is-disabled` / `aria-disabled="true"`.

### Buttons
`.btn` + variant `.btn--primary` (gold gradient) · `.btn--secondary` (outline) · `.btn--ghost` · `.btn--danger` (solid) · `.btn--danger-ghost`. Sizes `.btn--sm` (36px visual, 44px hit area), `.btn--lg`. Layout `.btn--block` (full width), `.btn--icon` (square, no padding), `.btn--round`. States `.is-loading` (spinner, keep the label in the DOM), `.is-disabled`.
```html
<button class="btn btn--primary btn--block">Save activity</button>
<button class="btn btn--ghost btn--icon btn--round" aria-label="Close"><svg class="icon"><use href="#i-x"/></svg></button>
```
**Record button:** `.btn-record` (56px round gold, inline) · `.btn-record--sm` · `.fab` (same, `position: fixed` bottom-right above the tab bar; `.fab--no-tabbar` without a tab bar).

### Forms
`.field` > `.field__label`, control, `.field__hint`, `.field__error`. Controls: `.input`, `.select`, `.textarea`, all 16px, 44px high, border `--color-border-strong`. Invalid: `.field--error` on the field or `aria-invalid="true"` on the control. Extras: `.input--compact` (+ `.input--a` / `.input--b` person border) for inline numbers; `.input-group` > `.input` + `.input-group__addon` (unit suffix); `.switch` > `.switch__input` + `.switch__track` + `.switch__label`; `.upload` (dashed photo picker label, hide the real input with `.sr-only`), `.upload__preview` > `img` + `.upload__remove`.
```html
<div class="field field--error">
  <label class="field__label" for="km">Distance</label>
  <div class="input-group"><input class="input" id="km" inputmode="decimal" aria-invalid="true"><span class="input-group__addon">km</span></div>
  <p class="field__error">Enter a number.</p>
</div>
```

### Segmented control and chips
`.segmented` > `.segmented__item` (+ `--a` / `--b` for person-coloured selected state). `.chip-row` (horizontal scroll; `--wrap` wraps) > `.chip` (`--a`, `--b`, `--info` for a non-interactive info pill). Interactive chips should be `<button>`.
```html
<div class="chip-row" role="group" aria-label="Sport">
  <button class="chip is-active" aria-pressed="true">🏃 Run</button>
  <button class="chip" aria-pressed="false">🥾 Hike</button>
</div>
<span class="chip chip--info">Counts for Week 12</span>
```

### Card
`.card` (padding 16, 24 from 640; radius 16, 24 from 640; shadow-2) with parts `.card__header`, `.card__title`, `.card__subtitle`, `.card__body`, `.card__footer`. Modifiers: `.card--hero` (gold gradient), `.card--inset`, `.card--flat` (no shadow), `.card--flush` (no padding), `.card--a` / `.card--b` (person edge), `.card--interactive` (clickable: hover lift, press, focus).

### Stat
`.stat` > `.stat__value` (+ `.stat__unit`) + `.stat__label`. Sizes `.stat--sm` 22, default 28, `--lg` 32-40, `--xl` 40-56. `.stat--a` / `.stat--b` colour the value, `.stat--center`. `.stat-row` (equal columns; `.stat-row--divided` adds separators).
```html
<div class="stat-row stat-row--divided">
  <div class="stat"><span class="stat__value">8.2<span class="stat__unit">km</span></span><span class="stat__label">Distance</span></div>
  <div class="stat stat--a"><span class="stat__value">13.1</span><span class="stat__label">Pts</span></div>
</div>
```

### Badge, tag, dot, avatar
`.badge` (pill) + `--accent|--a|--b|--success|--warning|--danger|--info`; `.badge--count` (unread number), `.badge--dot`, `.badge--floating` (absolute top-right of a `position:relative` parent such as an icon button). `.tag` (squared uppercase label; `--a|--b|--accent|--solid`). `.dot` (`--a`, `--b`, `--sm`). `.avatar` (coloured initial) `--a|--b`, sizes `--sm` 28, default 40, `--lg` 56, `--xl` 80; may contain an `<img>`.

### Progress
`.progress` (+ `--a|--b|--success`, `--sm|--lg`): `<div class="progress progress--a" role="progressbar" aria-valuenow="62" style="--value:62"><div class="progress__bar"></div></div>`. `--value` is a **unitless number 0-100**.
`.ring` (conic-gradient ring, animates when `--value` changes): `<div class="ring ring--b" style="--value:40" role="progressbar"><span class="ring__label">40%</span></div>`. Sizes `--xs` (24, no label), `--sm` 44, default 64, `--lg` 96, `--xl` 128; colours `--a|--b|--success`.

### App bar and tab bar
```html
<header class="appbar"><div class="appbar__inner">
  <div class="appbar__brand"><span class="appbar__kicker">Trailhead</span><span class="appbar__title">Feed</span></div>
  <div class="appbar__actions">
    <button class="btn btn--ghost btn--icon btn--round" style="position:relative" aria-label="Notifications, 2 unread">
      <svg class="icon"><use href="#i-bell"/></svg><span class="badge badge--count badge--floating">2</span></button>
    <button class="btn btn--ghost btn--icon btn--round" aria-label="Settings"><span class="avatar avatar--a avatar--sm">B</span></button>
  </div>
</div></header>

<nav class="tabbar" aria-label="Main"><div class="tabbar__inner">
  <button class="tabbar__item is-active" aria-current="page"><svg class="icon tabbar__icon"><use href="#i-feed"/></svg><span class="tabbar__label">Feed</span></button>
  <button class="tabbar__item">Plan</button>
  <button class="tabbar__record" aria-label="Log activity"><svg class="icon"><use href="#i-plus"/></svg></button>
  <button class="tabbar__item">Stats</button>
  <button class="tabbar__item">Notes<span class="badge badge--count tabbar__badge">1</span></button>
</div></nav>
```
Exactly five children in `.tabbar__inner`; the third is `.tabbar__record`. Put `.has-tabbar` on `<body>`. `.appbar` is sticky and adds the top safe-area inset itself. `.tabbar--contained` exists only for phone mock-ups.

### Sheet (bottom sheet / dialog)
```html
<div class="sheet">                       <!-- render only while open -->
  <div class="sheet__backdrop"></div>
  <div class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="t">
    <div class="sheet__handle"></div>
    <header class="sheet__header"><h2 class="sheet__title" id="t">Log activity</h2><button class="btn btn--ghost btn--icon btn--round" aria-label="Close">…</button></header>
    <div class="sheet__body stack">…</div>
    <footer class="sheet__footer"><button class="btn btn--secondary">Cancel</button><button class="btn btn--primary">Save</button></footer>
  </div>
</div>
```
Phone: slides up from the bottom, max height 92dvh, body scrolls. From 640px: centred 32rem dialog (`.sheet__panel--wide` 40rem). Vue: wrap in `<Transition name="sheet">` (classes `sheet-enter-from/active`, `sheet-leave-to/active` are provided). `.sheet--contained` is for previews only.

### Toast
```html
<div class="toast-host">            <!-- fixed top, one per app; Vue <TransitionGroup name="toast" tag="div" class="toast-host"> -->
  <div class="toast toast--b" role="status">
    <span class="toast__icon">🏃</span>
    <div class="toast__body"><div class="toast__title">Julian</div><div class="toast__text">logged an 8.2 km run</div></div>
    <button class="toast__action btn btn--ghost btn--sm">View</button>
  </div>
</div>
```
Kinds `toast--success|warning|danger|a|b` (default info). Optional `toast__close` (`btn btn--ghost btn--icon btn--sm`). Enter animates automatically.

### List
`.list` (+ `.list--card`) > `.list-item` (+ `--interactive` for clickable rows, `.is-unread`) with parts `.list-item__leading`, `.list-item__body`, `.list-item__title`, `.list-item__subtitle`, `.list-item__trailing`.

### Feedback and structure
- `.empty-state` > `__icon`, `__title`, `__text`, `__actions`.
- `.banner` (`--warning|--success|--danger`, default info) > `__icon`, `__body` (`__title`, `__text`), `__action`.
- `.skeleton` (`--text|--title|--avatar|--block|--media`), `.divider` (`--vertical`, `--text` with a label), `.disclosure` (`<details>` > `.disclosure__summary` + `.disclosure__body`), `.section-header` > `.section-title` (+ action link).

### Domain components
- **Kudos:** `<button class="kudos-btn is-active" aria-pressed="true"><span class="kudos-btn__icon">👏</span><span class="kudos-btn__count">2</span></button>`.
- **Week tile:** `.week-grid` (3 columns, 4 from 640px; `.week-grid__detail` spans the full row for an expanded detail panel) > `.week-tile` + one status `--fulfilled|--current|--missed|--upcoming`, optional `--race`, `.is-open`. Parts: `__head` (`__label`, `__status` glyph), `__num`, `__people` > `__person` (dot + percent), `__flag`. Status glyphs used in the guide: `✓` fulfilled, `●` current, `!` missed, `·` upcoming, flag icon for race.
```html
<div class="week-grid">
  <button class="week-tile week-tile--current" aria-label="Week 12, current, Beatrix 60 percent, Julian 40 percent">
    <span class="week-tile__head"><span class="week-tile__label">Week</span><span class="week-tile__status" aria-hidden="true">●</span></span>
    <span class="week-tile__num">12</span>
    <span class="week-tile__people">
      <span class="week-tile__person"><span class="dot dot--a dot--sm"></span>60%</span>
      <span class="week-tile__person"><span class="dot dot--b dot--sm"></span>40%</span>
    </span>
  </button>
</div>
```
- **Activity card:** compose with `.card`: `.card.activity-card` (+ `--a|--b` person edge, `--compact` for imported entries) > `__header` (`.avatar`, `__who` > `__name` + `__time`, `__sport`), `__body` (`__title`, `__note`, `__tags`), `__stats` (a `.stat-row.stat-row--divided`), `__media` (a `<figure>` with `<img>`, 4:3 cover), `__actions` (`.kudos-btn`, `__kudos-who`, `__actions-end`).
```html
<article class="card activity-card activity-card--a">
  <header class="activity-card__header"><span class="avatar avatar--a">B</span>
    <div class="activity-card__who"><span class="activity-card__name">Beatrix</span><span class="activity-card__time">Today, 07:12</span></div>
    <span class="activity-card__sport" aria-label="Run">🏃</span></header>
  <div class="activity-card__body"><h3 class="activity-card__title">Morning tempo</h3><div class="activity-card__tags"><span class="tag tag--accent">Tempo x1.6</span></div></div>
  <div class="activity-card__stats stat-row stat-row--divided">…stats…</div>
  <figure class="activity-card__media"><img src="…" alt=""></figure>
  <footer class="activity-card__actions"><button class="kudos-btn">…</button></footer>
</article>
```
- **Scoreboard:** `.compare` > `.compare__col` + `--a|--b` > `__name`, `__value`, `__label`, `.progress`, `__sub`. Put it in `.card.card--hero`.
- **Bar chart (inline SVG):** `svg.bar-chart` (viewBox about 320 wide, max-width 30rem), `.bar-chart__grid`, `.bar-chart__axis` (lines), `rect.bar.bar--a|bar--b` (`.bar--empty`), `text.bar-chart__label` (`--current`), `text.bar-chart__value`; legend `.legend` > `.legend__item` > `.dot`. Always add `role="img"` and `aria-label`.
- **Note:** `.message` (`--a|--b`) > `__head` (`__name`, `__time`), `__text`, `__img`.
- **Gate:** `.gate` (fixed full screen) > `.gate__box` > `.gate__title`, `.gate__text`, form.

## 6. Verified contrast (WCAG 2.1 AA)

Computed from `tokens.css` by script (alpha tints composited over the surface they sit on). All 51 checked pairs pass; the full table is rendered in `design-system.html`.

| Pair | Ratio | Need |
|---|---|---|
| text on bg / surface / raised | 12.5 / 10.8 / 9.8 | 4.5 |
| text-muted on bg / surface / raised | 7.9 / 6.8 / 6.2 | 4.5 |
| **text-faint** on bg / surface / raised / inset | 6.2 / 5.3 / 4.8 / 6.1 | 4.5 (old `#a9727e` failed: 3.3 on surface, so it was lightened to `#c99ba6`) |
| accent and person-a on bg / surface / raised | 8.2 / 7.1 / 6.4 | 4.5 |
| person-b on bg / surface / raised / raised + soft tint | 6.5 / 5.7 / 5.1 / 4.5 | 4.5 |
| on-accent on gold-400 / gold-500 | 9.1 / 7.3 | 4.5 |
| on-person on person-b | 7.3 | 4.5 |
| success, warning, danger, info on surface | 8.0 / 7.6 / 6.5 / 7.7 | 4.5 |
| on-solid on danger-solid / success-solid | 6.3 / 6.1 | 4.5 |
| border-strong on bg / surface / raised | 4.3 / 3.7 / 3.4 | 3 (UI) |
| focus ring on bg / surface / raised | 14.1 / 12.2 / 11.0 | 3 (UI) |

Notes: `--color-text-faint` must not be used on tinted soft backgrounds (it drops to about 4.2:1 on `--color-accent-soft`); use `--color-text-muted` there. Person A and B are nearly the same hue family (1.25:1 between them): never rely on colour alone to tell them apart. Placeholders use `--color-text-faint`.

## 7. Migration map (old to new)

| Old variable | New |
|---|---|
| `--bg` | `--color-bg` |
| `--bg-card` | `--color-surface` |
| `--bg-raised` | `--color-surface-raised` (now `#642130`, was `#5c1a28`, to be distinguishable from cards) |
| `--line` | `--color-border` (`--color-border-strong` for input outlines) |
| `--text` | `--color-text` |
| `--text-dim` | `--color-text-muted` |
| `--text-faint` | `--color-text-faint` (lightened for AA) |
| `--rust` (it was gold) | `--color-person-a` for person colour, `--color-accent` for generic accent |
| `--rust-dim` | `--gold-800` (gradient), `--color-person-a-soft` (tint) |
| `--teal` (it was olive) | `--color-person-b` |
| `--teal-dim` | `--olive-900`, `--color-person-b-soft` |
| `--sage` | `--color-secondary` |
| `--sage-dim` | `--color-secondary-soft` |
| `--gold` | `--color-accent-strong` |
| `--gold-dim` | `--gold-900` |
| `--ink` | `--color-on-accent` / `--color-on-person` |
| `#ff9d9d` (auth error) | `--color-danger` |

| Old class | New |
|---|---|
| `.wrap` | `.container` |
| `.progress-card`, `.activities-card`, `.board-card` | `.card` (`.card--hero` for the scoreboard) |
| `.compare-row/.compare-col/.pts-big/.pts-lbl/.km-sub` | `.compare`, `.compare__col/__value/__label/__sub` |
| `.bar-track` + `.bar-fill.a/.b` | `.progress.progress--a/--b` |
| `.name-dot.dot-a/.dot-b` | `.dot.dot--a/.dot--b` |
| `.activity-sender-btn`, `.board-sender-btn` | removed (identity is global); picker UIs use `.segmented` or `.chip` |
| `.activity-select`, `.activity-input`, `.goal-input`, `.auth-input`, `.board-textarea` | `.select`, `.input`, `.input.input--compact.input--a/--b`, `.input`, `.textarea` |
| `.activity-add-btn`, `.board-send-btn`, `.auth-submit` | `.btn.btn--primary` |
| `.activity-remove`, `.reset-btn`, `.board-msg-del` | `.btn.btn--secondary/--ghost/--danger-ghost` (+ `.btn--sm`) |
| `.board-msg(.sender-a/b)` | `.message.message--a/--b` |
| `.board-img-label` | `.upload` |
| `.auth-gate/.auth-box` | `.gate/.gate__box` |
| `.week` tiles and `.week-num-value` | `.week-tile`, `.week-tile__num` |
| `.run-type-card`, `.rtc-*`, `.run-types-details` | `.card`/`.tag`, `.disclosure` |
| `.phase-title` | `.section-title` / `h2` |
| `.kicker` | `.appbar__kicker` / `.text-eyebrow` |
