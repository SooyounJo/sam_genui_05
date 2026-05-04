# DESIGN SPEC — Samsung One UI 8.5 (Ambient Design)

**Layer**: DESIGN SPEC
**Lives here**: Component-level definitions — colors, typography, shape, padding, radius, token mappings — describing WHAT each component IS.
**Does NOT live here**: Raw Figma measurements (see `figma-refs/extracted.md`), screen-level composition rules (see `ORCHESTRATION.md`), runtime selection logic (see `GENUI-PRINCIPLES.md`), refinement memory (see `evolve.md`).

---

## 1. Visual Theme & Atmosphere

Samsung's One UI 8.5 introduces **Ambient Design** — a philosophy where the interface becomes invisible until needed. UI chrome (status bars, navigation bars, system controls) fades from view during content consumption and returns only on demand.

**Glass UI** is the signature visual treatment: system surfaces use frosted semi-transparency with thin outline borders that dynamically react to the wallpaper underneath.

**Four design pillars**: Natural, Clean, Consistent, Sensorial — operating under the Ambient Design umbrella with a fifth emergent principle, **Contextual Awareness**.

**Key Characteristics**
- Ambient Design: chrome fades during scroll, returns on interaction
- Glass UI: frosted semi-transparent surfaces with thin outline borders, wallpaper-reactive tinting
- Floating Pill Tab Bar: bottom navigation as hovering pill-shaped element
- 3D App Icons: subtle drop shadows
- AI-Adaptive Lock Screen: clock and widgets auto-position around wallpaper subjects
- Drag-and-Drop Quick Panel: customizable widget-style tiles
- Samsung Sharp Sans for display, SamsungOne for body
- 6 customizable unlock animations: Slide, Expand, Spread, Wave, Warp, Ripple
- Now Bar: pill-shaped live activity indicator on lock screen
- Illustration palette (Sky Blue, Ocean Blue, Teal, Lavender, Clover, Saffron, Coral)

---

## 2. Color Palette & Roles

### Primary Brand
| Token | Hex | Role |
|---|---|---|
| Samsung Blue | `#1428A0` | Brand mark, key interactive accents (since 1993) |
| Pure Black | `#000000` | Hero backgrounds, immersive showcases, navigation |
| Pure White | `#FFFFFF` | Alternate section backgrounds, editorial panels |

### Surface & Background
| Token | Hex | Role |
|---|---|---|
| Near White | `#F7F7F7` | Alternate light surface |
| Light Gray | `#F5F5F5` | Secondary surface |
| Dark Surface | `#1A1A1A` | Elevated dark cards, footer |
| Container Dark | `#17171A` | App scaffold containers |
| Container Light | `#FCFCFF` | Light-mode containers |

### Text
| Token | Hex | Role |
|---|---|---|
| Near Black | `#1D1D1F` | Primary heading on light bg |
| Dark Gray | `#313131` | Primary body on light bg |
| Mid Gray | `#575757` | Secondary text, descriptions |
| Light Text Gray | `#6E6E73` | Tertiary, metadata, captions |
| Muted Gray | `#DADADA` | Placeholder, disabled, dividers |
| Secondary Text | `#848487` | URLs, muted labels |
| Inactive Title | `#EFEEF2` | Tile title (dark glass) |
| Inactive Subtitle | `#CFCCCF` | Tile subtitle (dark glass) |
| White | `#FFFFFF` | Text on dark bg |

### Interactive & Accent
| Token | Hex | Role |
|---|---|---|
| Action Blue | `#3388E9` | Active interactive (web product pages) |
| Bright Blue | `#3581FF` | Links on dark bg |
| Cyan Blue | `#0E9FF9` | Feature highlights |
| Galaxy Yellow | `#FFF01F` | Galaxy AI features |
| Switch On | `#0381FE` | App switch active state |
| Slider Fill | `#387AFF` | App slider fill |
| Live Activity | `#0FCF6E` | Status pill (call/timer in status bar) |
| Toggle On | `#D5D5D5` | QS toggle active fill |
| Toggle Off | `rgba(180,180,180,0.2)` | QS toggle inactive |

### Gradient & Special
- **Cyan-to-Green** (`#64E9E3` → `#9FFAC7`): Galaxy AI premium highlights
- **Accent Blue Glow** (`#9BD6FF`): Soft promotional/hover highlight
- **AI Notification gradient**: `linear-gradient(to right, rgba(102,161,243,0.4) 0%, rgba(34,201,166,0.4) 100%)`

### Illustration Palette
Sky Blue · Ocean Blue · Teal · Lavender · Clover · Saffron · Coral

### Border & Divider
| Token | Value |
|---|---|
| Border Light | `#DDDDDD` |
| Border Subtle | `#EAEAEA` |
| Divider Dark | `#5F5F61` |
| Tile Border | `1px rgba(255,255,255,0.2)` |
| Shortcut Border | `0.5px rgba(255,255,255,0.2)` |

### Overlay
| Token | Value |
|---|---|
| Dark Overlay | `rgba(0,0,0,0.7)` |
| Dark Mask | `rgba(0,0,0,0.8)` |

### Shadows
| Token | Value |
|---|---|
| Card Shadow | `0px 4px 17px 0px rgba(224,224,224,0.32)` |
| Chip Shadow Dark | `0 4 4 rgba(0,0,0,0.25)` (raw 4.7) |
| Chip Shadow Light | `0 4 8 -1 rgba(0,0,0,0.25)` (raw 7.7) |
| Icon Shadow | `0 2dp 8dp rgba(0,0,0,0.15)` (3D floating) |

---

## 3. Typography

### Font Families
- **Display**: `SamsungSharpSans` — proprietary geometric sans-serif (headlines)
- **Body / UI**: `SamsungOne` / `One UI Sans APP VF` — proprietary sans-serif (body, UI)
- **Clock**: `SamsungNrDefault-V6` — clock-only display face
- **Korean**: `SamsungOneKorean, sans-serif`
- **Fallback**: `sans-serif`

### Web Hierarchy

| Role | Font | Mobile | Desktop | Weight | Line-Height |
|---|---|---|---|---|---|
| Display Hero | SamsungSharpSans | 36 | 64 | 700 | 1.125–1.18 |
| Section Heading | SamsungSharpSans | 28 | 56 | 700 | 1.07 |
| Sub-heading | SamsungSharpSans | 28 | 48 | 700 | 1.16–1.20 |
| Feature Title | SamsungSharpSans | 24 | 32 | 700 | 1.25 |
| Card Title | SamsungSharpSans | 20 | 24 | 700 | 1.33 |
| Nav Heading | SamsungOne | 18 | 18 | 600 | 1.44 |
| Body Large | SamsungOne | 16 | 18 | 400 | 1.50–1.55 |
| Body | SamsungOne | 14 | 16 | 400 | 1.50 |
| Button Text | SamsungOne | 14 | 14 | 700 | 1.43 |
| Caption | SamsungOne | 12 | 14 | 400 | 1.43 |
| Disclaimer | SamsungOne | 10 | 12 | 400 | 1.30–1.33 |

### App Typography Scale (One UI 8.5 system surfaces)

| Role | Size | Weight | Line | Usage |
|---|---|---|---|---|
| Display | 34 | 300 | 40 | Lock screen clock (web/web equivalent) |
| Lock Clock | 112 | 400 | 82 | Lock screen clock (Figma canonical) |
| Headline | 22 | 500 | 28 | Card titles, dialog titles |
| Title | 18 | 500 | 24 | App bar title, section headers |
| Subhead | 20 | 600 | normal | Notification title, dialog title |
| Body | 16 | 400 | 22 | Notification content |
| Tile Title | 16 | 600 | — | QS tile title `#EFEEF2` |
| Tile Subtitle | 14 | 400 | — | QS tile subtitle `#CFCCCF` |
| Status Label | 15 | 700 | 12 | Status bar carrier `rgba(255,255,255,0.8)` tracking 0.15 |
| Section Label | 14 | 400 | — | "Live notifications" headers |
| Label | 14 | 500 | 18 | Button labels, tab labels |
| NowBar Title | 19 | 500 | — | Now Bar header text |
| NowBar Subtitle | 15 | 500 | — | Now Bar metadata |
| Caption | 12 | 400 | 16 | Timestamps, secondary metadata |
| Activity Pill | 10 | 600 | — | LiveActivity status pill text (tracking 0.1) |

### Typography Principles
- **Dual-font clarity**: SamsungSharpSans owns headlines; SamsungOne owns body/UI. Never mix roles.
- **Weight discipline**: headlines at 700 only; body 400 with 600 emphasis. No weights below 400.
- **Responsive scaling**: headlines compress 64→36, 56→28; body 18→16.
- **No decorative tracking**: default letter-spacing for SamsungSharpSans.

---

## 4. Shape System

### Border Radius Scale

| Shape | Radius | Application |
|---|---|---|
| Micro | 4 | Tags, small utility |
| Standard Modal | 11 | Web dialogs |
| Rounded Rectangle | 18 | Contained buttons, text fields, snackbar action |
| Card / Squircle | 20–28 (web 20, app 26, dialog 28) | Cards, widgets, dialogs, image containers |
| Inner Stack | 40 | Hero content stacks within scaffold |
| Frame / Panel | 40 | QS panel, notification panel, frame outer |
| Pop-out Menu | 32 (browser) / 28 (gallery) | Pop-out / share menus |
| Scaffold Outer | 16 | Phone container |
| Pill | 50 / 999 | CTAs, tab bars, Now Bar, chips, single-row interactive |
| Circle | 50% | Icon buttons, FAB, toggle icons, page-indicator dots |

### Morphology Vocabulary
- **Pill**: Now Bar, notification cards, chips, suggestion chips, single-row interactive
- **Squircle (26dp)**: cards, widgets, media player, dialogs, image containers
- **Circle**: QS toggle icons, browser top-bar icons, FAB, avatar
- **Rounded Rectangle (18dp)**: contained buttons, inputs, snackbar action

### Glass Tier Definitions

| Tier | Bg Opacity | Blur | Border | Usage |
|---|---|---|---|---|
| G0 — Background | 5–15% | 40 | 1px @ 8% white | Wallpaper overlay, surface scrim |
| G1 — Container | 15–30% | 24 | 1px @ 10% white | Notification cards, inactive toggles, nowbar weak |
| G2 — Interactive | 30–50% | 16 | 1px @ 12% white | Active toggles, Now Bar, media player |
| G3 — Elevated | 50–70% | 12 | 1px @ 15% white | Dialogs, bottom sheets, focused inputs |

Concrete glass tokens (post-normalization, see `extracted.md`):
- `glass.strong`: `rgba(23,23,26,0.3)` + blur 24
- `glass.medium`: `rgba(23,23,26,0.6)` + blur 24
- `glass.weak`: `rgba(55,55,55,0.3)` + blur 8
- `glass.nowbar`: `rgba(23,23,26,0.3)` + blur 12
- `glass.liveActivity`: `rgba(55,55,55,0.30)` + blur 25 + 0.5px border `rgba(150,150,150,0.6)`

### Three-layer Depth System (Samsung official)
- **Blur**: even bg blur + dim, used for foreground emphasis
- **Dim**: hierarchical clarity (`rgba(0,0,0,0.65)` typical)
- **Shadow**: soft connection between layers
- **Rule**: never combine Dim + Shadow on the same element.

---

## 5. Spacing System

- **Base unit**: 8dp web · 4dp app
- **Spacing scale**: 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64
- **Size grid**: 24, 32, 40, 48, 56, 64, 72, 88, 96, 128
- **Min touch target**: 48 × 48
- Component-internal padding: ≥ 16dp

| Token | Value | Usage |
|---|---|---|
| `space-xs` | 4 | Icon-to-label gap inside a toggle |
| `space-sm` | 8 | Items in a dense row |
| `space-md` | 16 | Card internal padding, between notification cards |
| `space-lg` | 24 | Section spacing |
| `space-xl` | 32 | Between major surface regions |

---

## 6. Component Definitions

### Buttons

**Primary Filled (CTA, web)**
- bg `#000000`, text `#FFFFFF` SamsungOne 14/700
- height 48, padding 6×24, radius 36 (pill), no border
- hover: opacity shift

**Secondary Outlined (web)**
- bg `#FFFFFF`, text `#6E6E73`
- height 48, padding 6×24, radius 36, border `1px #DDDDDD`
- hover: border darkens, text → `#000000`

**Text Link (Underline)**
- transparent bg, text `#000000` / `#FFFFFF`, underline
- SamsungOne 14/400, hover opacity 0.7

**Icon Button (Circular)**
- bg transparent or `rgba(0,0,0,0.5)`, size 40 mobile / 36 desktop, radius 50%

**Pill Button (in-app)**
- pill radius, label 14/Regular or 15/500
- variants: contained (`#17171A` bg), flat, outlined

**SnackbarButton**
- pill radius (20), pad 20×4, inverse bg, label 14/SemiBold

**Mini Button (in-card)**
- pill radius (28), used in card headers

### Cards & Containers (web)
- bg `#FFFFFF` (light) / `#1A1A1A` (dark)
- border `1px #EAEAEA` (light) / none (dark)
- radius 20
- shadow Card Shadow on elevated
- left-aligned content, consistent padding

### Card (in-app squircle)
- radius 26–28
- internal padding 16–20
- header row: Icon/Avatar 40 + gap 12 + Title 15/600 + Subtitle 13/400 (`text-2`)
- supports Switch (`40×22 r-pill bg #0381FE`) or Chevron trailing

### Popup / Modal (web)
- max-width 680 desktop / 90% mobile, radius 11
- padding 32t / 33l / 35r / 48b
- shadow Card Shadow, border `1px #EAEAEA`, backdrop `rgba(0,0,0,0.7)`

### DialogBlurred (in-app)
- 328 × auto, radius 28, padding 20, gap 20
- fill `rgba(23,23,26,0.6)` dark / `rgba(252,252,255,0.5)` light + blur 24
- composition: Icon? (40) + ExtraContent? + TextGroup{Title 20/SemiBold + Description 14/Regular} + Buttons{Cancel · 2×32 divider · Apply (20/Bold)}
- title 18/700 → desc 14/400 → buttons row h:48 (top divider 1px, vertical divider between)

### Navigation (Web GNB)
- bg `#000000` solid, height ~56, fixed
- text `#FFFFFF` SamsungOne 14/400
- logo: white wordmark left-aligned
- mobile: hamburger → full-screen overlay `rgba(0,0,0,0.8)`
- z-index 199–299 standard, 899+ overlays

### Floating Pill Tab Bar (One UI 8.5)
- shape: pill (radius pill)
- bg: glass G2 wallpaper-reactive, border `1px rgba(255,255,255,0.2)`
- height ~46–64dp, padding 24h
- 4–5 tab items evenly distributed; active = filled icon + circular highlight
- icon 24×24, label 10dp below, gap 4

### Now Bar
- pill (radius pill / 999)
- bg tinted glass (G2, blur 12–25), tint varies by active state (teal media, green timer/charging, brand accent for delivery)
- internal: AppIcon/IconBadge (32–56) + Text block (Title 14–19/500–600 + Subtitle 12–15/400–500) + Action icon 24
- min height 48 single-line / 64 two-line
- variants: MediaPlayer · Timer · Delivery · Charging · Navigation · Activity
- IconBadge inside is 56dp accent pill (identity); accent colors include `#0C8FAE` (navigation), `#4ED877` (health)
- ProgressTrack (when present): Base 1dp white + Fill + ThumbChip 28dp pill with 3dp ring `#D9E7FC` + glyph 18

### Quick Panel (One UI 8.5)
- frosted glass background, drag-and-drop customizable
- tile sizes: small / medium / large
- widget-style tiles embed live data
- slider orientations: horizontal / vertical
- search bar with improved animation; landscape supported

### QS Toggle (single)
- circular icon container 64×64 (web equivalent) / 56 (Figma inner)
- active: filled with semantic color, icon white
- inactive: surface fill `rgba(180,180,180,0.2)`, icon `text-2`
- label below: 10dp, max 2 lines, center
- tile shell pill radius 50, 88×88 square or 199×88 half

### QS Tile Card
- pill or rounded shell, padding 16
- composition: [Icon 24] + Title + Subtitle + [trailing Action 24]
- gap icon→text 12, gap title→subtitle 2

### Notification Card
- pill (radius 50–999)
- material: G1 glass + 1px border + low-opacity fill
- structure: Icon + AppName + Content + Timestamp + Action*
- variants: Live (G2, accent indicators, inline buttons) · Other (G1, neutral) · Silent (G0, reduced opacity)
- Live notification: 415×86, padding 16h, gradient `rgba(23,23,26,0.3)→#000` + blur 12, title 20/600 `#EFEEF2`, subtitle 14/400 `#CFCCCF`, 3 action chips 16
- AI Regular notification: AI gradient bg, 56 leading shape

### Media Player Card
- large squircle (radius 26–36)
- composition: AlbumArt + Title + Artist + ProgressBar + Controls
- material: extracted palette from album art applied to background
- 408×180 (Figma reference), padding px:29 py:14, radius 36

### Lock Screen Widget
- squircle 26 or circular gauge
- material: dark-on-dark, low contrast for ambient
- 2-col grid, ~2×1 grid units
- types: Weather · Health · Clock
- Battery widget: 138×62 r:20, glass weak + blur 6
- Daily activity: 138×62, padding pl:10 pr:14, 3-row stat list

### Home Screen Widget
- squircle (radius 26)
- size classes: 2×1 (176×80), 2×2 (176×176), 4×1 (368×80), 4×2 (368×160 / 368×176), 4×4 (368×368)
- opaque fill with light/dark variants
- internal layouts (per type) — see ORCHESTRATION for grid placement; each widget body uses tokens from this spec

### App Icon
- container 60×60, visual 56×56, radius 18 (squircle)
- subtle drop shadow `0 2dp 8dp rgba(0,0,0,0.15)` (3D floating)
- label 11/400 center, single line ellipsis, gap icon→label 6
- touch target 72×72

### Folder Icon
- container 60×60 r:18, bg `rgba(255,255,255,0.15)` dark / `rgba(0,0,0,0.06)` light
- internal 2×2 mini-icons 20×20 r:6, gap 4, padding 8

### Page Indicator
- dots 6dp diameter, gap 6
- active opacity 1, inactive opacity 0.35 (or `rgba(255,255,255,0.6)`)

### Switch
- track 40×22, radius pill, active bg `#0381FE`
- knob ellipse

### Slider
- track height 19, radius 40, bg `#848487`
- fill radius 10, bg `#387AFF`
- thumb 24, radius 12, bg `#000` + 2px outline `#387AFF`
- compact app slider thumb 24×24 circle

### Snackbar / Toast
- 328 outer, pill radius
- bg `#010102` dark / `#F1F1F3` light, no blur
- composition: Icon? (24) + Text 14/Regular flex-1 + SnackbarButton

### LiveActivity Pill (status bar inline)
- bg `#0FCF6E`, radius 10
- padding pl:4 pr:8 py:4, gap 4
- Icon 12 + Text 10/600 white tracking 0.1

### IconBadge vs IconChip (atom distinction)
- **IconBadge** — 56dp pill, accent fill, identity/context use (Now Bar, profile)
- **IconChip** — 48dp pill, neutral bg `#17171A`, shadow, action use (top bar, menu grid)

### WebsiteShareHeader
- 419w, vertical gap 20, padding pt:8 px:8
- Thumbnail 50×50 r:10 + TextBlock{Title 18/600 + URL 14/400 `#848487` ellipsis} + ShareChip 42×42 r:14 bg `#17171A` + Separator 1px `#5F5F61`

### Contained Icon+Label (BrowserTopBar)
- 54w vertical, items center, gap 8
- chip 54×54 (visual 48), radius 48, bg `#17171A` dark / `#FCFCFF` light, padding 15
- chip shadow `0 4 4 rgba(0,0,0,0.25)` dark / `0 4 8 -1 rgba(0,0,0,0.25)` light
- icon 24×24, label 14/400 width 83 center

### Status Bar
- height 24 (system) / 44 (Figma frame)
- composition: Time/Carrier (left) + NotificationPill/LiveActivity (center) + WiFi+Cell+Battery (right)
- Carrier label 15/700 `rgba(255,255,255,0.8)`

### Navigation Bar (system)
- gesture: 134×5 pill indicator, radius 999, bottom 8 (or 144×4 r2 `rgba(255,255,255,0.6)`)
- 3-button: [|||] [○] [<], height 48

### App Bar
- height 56, padding 0 16
- back icon 24, title 16 left or center, overflow icons right gap 24

### Bottom Navigation
- height 64, glass pill, radius 999, padding 24h
- 4–5 items evenly distributed, icon 24, label 10, gap 4

### Edge Panel
- vertical panel, glass tint, Large or Small variant
- slide-in from screen edge

### Keyboard
- key grid + number row + suggestion chips row
- dark keys on `#1E1E1E` / light keys on `#F0F0F0`
- chips are Gen components (see GENUI-PRINCIPLES)

### FAB
- circular, coral/red fill, primary creation action

### Connected Tab
- outlined pill with "+" text — adds/connects new item

### Slide Nav Button
- icon + label, 4 variants (light/dark × outlined/filled)

### Image Treatment
- Products on solid-color fields (black/white) — floating presentation
- Full-bleed section images
- Lifestyle images in rounded containers (radius 20)
- Video with play overlay + progressive loading

### Carousel / Slider (web)
- arrow buttons 40 circular semi-transparent
- dot indicators small circles, active filled
- transition `cubic-bezier(0.2, 0.6, 0.4, 1)`

---

## 7. Mode-Specific Material (Dual-Mode)

| Property | Dark | Light |
|---|---|---|
| Surface base | `#171717` | `#FCFCFC` |
| Card material | Glass (blur + tinted fill + 1px border) | Opaque `#FFFFFF` + 1dp shadow |
| Text primary | `#FFFFFF` @ 87% | `#000000` @ 87% |
| Text secondary | `#FFFFFF` @ 60% | `#000000` @ 60% |
| Text disabled | `#FFFFFF` @ 38% | `#000000` @ 38% |
| Toggle active | semantic @100% on dark fill | semantic @100% on light fill |
| Toggle inactive | `#FFFFFF` @ 15% | `#000000` @ 8% |
| Now Bar | tinted glass | tinted opaque (category @15% on white) |
| Keyboard surface | `#1E1E1E` | `#F0F0F0` |

---

## 8. Visual Constants Reference

| Constant | Value |
|---|---|
| Base grid (web) | 8dp |
| Base grid (app) | 4dp |
| Card radius (squircle) | 26 |
| Pill radius | 999 |
| Button radius (rounded) | 18 |
| Icon container radius | 50% |
| Glass blur range | 12–40 |
| Glass border | `1px solid rgba(255,255,255,0.08–0.15)` |
| Dark surface | `#171717` |
| Light surface | `#FCFCFC` |
| Min touch target | 48dp |
| Status bar height | 24dp |
| Nav bar (buttons) | 48dp |
| Nav bar (gesture) | 20dp |
| Now Bar height | 64dp |
| Image container radius | 26 |
| Dashed placeholder border | `1px dashed rgba(255,255,255,0.3)` |

---

## 9. Do's and Don'ts (component-level)

### Do
- Use SamsungSharpSans for headlines, SamsungOne for body
- Use Samsung Blue (`#1428A0`) only for brand accents
- Apply Glass UI on floating system surfaces (frosted blur + thin outline + wallpaper-reactive tint)
- Use pill radius for floating bars, CTAs, navigation
- Use 26dp squircle on cards, dialogs, containers
- Place product imagery on solid color fields
- Apply 700 weight to all SamsungSharpSans headlines
- Use the three-layer depth system: Blur (emphasis) · Dim (hierarchy) · Shadow (connection)
- Use Galaxy AI gradient (`#64E9E3`→`#9FFAC7`) and Galaxy Yellow (`#FFF01F`) only for AI moments

### Don't
- Don't mix SamsungSharpSans into body or SamsungOne into display headlines
- Don't use weights below 400
- Don't combine Dim and Shadow on the same element
- Don't use Samsung Blue as a background fill
- Don't introduce 0px-radius corners on Gen components
- Don't apply decorative letter-spacing to SamsungSharpSans
- Don't use opaque backgrounds on floating system elements (require glass)
- Don't center-align body text (left-align only)
- Don't install third-party fonts (signature verification only)
