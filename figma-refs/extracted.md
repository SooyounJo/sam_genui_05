# RAW EXTRACTION — Figma Geometry & Tokens

**Layer**: RAW EXTRACTION
**Lives here**: Measured Figma values only — geometry, auto-layout, sizing, constraints, raw style values, component-tree structure.
**Does NOT live here**: Component-design intent, screen-assembly rules, runtime selection logic, refinement lessons.
**Cross-refs**: `DESIGN.md` (component design spec) · `ORCHESTRATION.md` (screen assembly) · `GENUI-PRINCIPLES.md` (runtime logic) · `evolve.md` (refinement memory).

---

**Source file**: `kxDvBUif6pV502Si4RPidK` — [Figma](https://www.figma.com/design/kxDvBUif6pV502Si4RPidK/One-UI-Design-Kit--Community-)
**Schema**: Geometry / Auto Layout / Sizing / Constraints / Style / Structure
**Extraction date**: 2026-04-15 (via Figma MCP `get_design_context`)

> Notes on fidelity:
> - `absoluteBoundingBox` values are derived from Tailwind utility classes produced by Figma MCP; mobile frame origin is treated as (0,0).
> - `constraints.horizontal / vertical` in Figma are design-time pinning rules — not emitted by Code Connect. Values below are **inferred** from flex behavior: `FILL` = `flex-[1_0_0]` or `w-full`; `FIXED` = explicit `w-[Npx]` + `shrink-0`; `STRETCH` = `self-stretch`; `SCALE` = aspect-ratio preserved.
> - `textStyleId` is not present in Community file exports. We capture `font-family / weight / size / color / leading / tracking` directly.

---

## FRAME 1 — Quick Settings Panel  (`node-id=3010:2142`)

### Geometry
- `absoluteBoundingBox`: { x: 0, y: 0, **w: 450, h: 978** }

### Auto Layout (outer `989:22463` — Quick Settings)
- `layoutMode`: NONE (absolute container; rounded 40px mask)
- children positioned absolutely

### Style
- `fills`: background image + `rgba(23,23,26,0.3)` overlay with **backdrop-blur 25**
- `cornerRadius`: 40
- overflow: clip

### Structure
```
Quick Settings (989:22463)  [FRAME]
├─ Background (544:2748)    [image fill, radius 40]
└─ QS Grid (989:22465)      [FLEX wrap]
   ├─ Header stack          — fade + status bar + top actions
   ├─ Toggle row (2×)       — WiFi, Mobile data (88×88 square)
   ├─ Bluetooth card        — half-width title+subtitle
   ├─ Icons row             — 1×4 circular icons (415×w)
   ├─ Slider ×2             — Brightness, Sound (88×300 vertical)
   ├─ 2×2 toggle cluster    — SingleToggle half & square mix
   ├─ SmartThings card      — TV icon + 2-line text + 3 actions
   ├─ Single square toggles — 88×88 (×4)
   └─ Bottom SmartThings    — duplicate pattern
```

### Inner spec — QS Grid (`989:22465`)

| property | value |
|---|---|
| `layoutMode` | HORIZONTAL (flex-wrap) |
| `itemSpacing` | 18 |
| `padding` | pt:18, px:22, pb:0 |
| `primaryAxisAlignItems` | START (content-start) |
| `counterAxisAlignItems` | START |
| `layoutSizingHorizontal` | FIXED 451 |
| `layoutSizingVertical` | FIXED 978 |
| `fills` | `rgba(23,23,26,0.3)` + **backdrop-blur 25** |

### Inner spec — Single Toggle (Square) `987:17561`
- w/h: **88 × 88** (max)
- `layoutMode`: VERTICAL, center/center, py:10
- `fills`: `rgba(23,23,26,0.3)`
- `stroke`: `rgba(255,255,255,0.2)` × 1px
- `cornerRadius`: 50
- child: **Toggle Icon** 56×56, radius 63.636, p:13
  - inactive bg: `rgba(180,180,180,0.2)` / active bg: `#d5d5d5`
  - inner shape 30×30 (icon)

### Inner spec — Single Toggle (Half) `544:1012`
- w/h: **199 × 88**
- `layoutMode`: HORIZONTAL, items:center, gap:10
- `padding`: px:17, py:24
- `fills`: `rgba(23,23,26,0.3)` + stroke `rgba(255,255,255,0.2)` 1px
- `cornerRadius`: 50
- children: Toggle icon 56×56 + Text stack (title 16/600 `#efeef2`, subtitle 14/400 `#cfcccf`)

### Inner spec — Shortcut (Half) `544:1044`
- same shell as Single Toggle Half but `pl:20 pr:25 py:24`
- left icon is **"open" 32.5×35** (arrow out square)
- title+subtitle stacked

### Inner spec — Icons row `544:865`
- w: **415**, `layoutMode`: VERTICAL, items:center, gap:20
- `padding`: px:25, py:24, fills/stroke/radius same as toggle card
- 1 or 2 rows × 4 circular ToggleIcons (56)
- bottom handle bar: 50×4, radius 2, `rgba(255,255,255,0.6)` (centered under card)

### Inner spec — Vertical Slider `1109:10261` / `1109:10246`
- w/h: **88 × 300**, max-h 88 → container-clamped; `min-h: 275`
- `layoutMode`: VERTICAL, center/center, gap:10, `padding`:18
- fills/stroke/radius as other tiles
- inner slider track rotated -90° with gradient thumb `#c6c4c3 → #e4e4e4`, thumb height 52, radius 56.818
- bottom round icon (56×56, `#d5d5d5`)

### Inner spec — SmartThings card `1109:10416`
- w: **408**, h: 86 (max 88)
- `layoutMode`: HORIZONTAL, items:center, gap:20
- `padding`: pl:20, pr:17, py:24
- inner left: icon 32.5×35 + 2-line text (title 16/600 `#efeef2` "55" Neo QLED", subtitle 14/400 `#cfcccf` "Living Room")
- inner right: 3 circular action buttons 51.67×51.67, bg `rgba(180,180,180,0.2)` (last one `#d5d5d5` for power-on)

### Inner spec — Status Bar `I989:22470;452:643`
- h: **44**, `padding`: px:10, py:16
- Left label `DGX-TJG` 15/700 `rgba(255,255,255,0.8)`, leading 12
- Right icons row: WiFi(18) + Cellular(18) + Battery(24.2×16.5)

### Inner spec — Top action row `989:22471`
- h: **25**, items: edit / power / settings (25×25 each), gap:28

---

## FRAME 2 — Lock Screen  (`node-id=3010:2143`)

### Geometry
- `absoluteBoundingBox`: { x: 0, y: 0, **w: 451, h: 978** }

### Auto Layout (outer `989:22979`)
- `layoutMode`: NONE (absolute positioning)

### Style
- `fills`: image fill (wallpaper)
- `cornerRadius`: 40

### Structure
```
Lock Screen (989:22979)
├─ Background            — wallpaper image
├─ Status Bar            — top 44, TJG + health/account/google + WiFi/Cell/Battery
├─ Lock icon             — 24×24, centered, top 51
├─ Clock stack (745:7949)
│  ├─ Date row           — "Sat, May 3" + moon icon + "24°" 24/400 white, gap:10
│  └─ Clock 09:41        — Samsung Sans 112, leading 82, gap:12
├─ Health widgets row (746:2420)   — gap:16
│  ├─ Battery widget card 138×62   — 2 arc icons (29, 74)
│  └─ Daily activity card 138×62   — steps/time/exercise 3 rows (4209 / 25 / 650)
├─ "Swipe to unlock"    — 16/400 white, centered at top:843.5
└─ Shortcut row (744:5659) @ top:880, left:31, w:389
   ├─ Phone shortcut      — 47×47 glass chip
   ├─ Now Bar (752:7982)  — 248×64, gap:14, pl:12 pr:18 py:12
   └─ Camera shortcut     — 47×47 glass chip
```

### Inner spec — Clock (`746:3229`)
| property | value |
|---|---|
| `layoutMode` | VERTICAL, items:center, gap:26 |
| `layoutSizingHorizontal` | FIXED 192 |
| children.Date.gap | 10 |
| children.Clock.font | SamsungNrDefault-V6 / 400 / 112 / leading 82 |
| children.Clock.color | #FFFFFF |
| children.Clock.gap | 12 (between "09" and "41") |

### Inner spec — Now Bar (`752:7982`)
| property | value |
|---|---|
| width × height | 248 × 64 |
| `layoutMode` | HORIZONTAL, items:center, gap:14 |
| `padding` | pl:12, pr:18, py:12 |
| `fills` | `rgba(23,23,26,0.3)` + **backdrop-blur 12** |
| `stroke` | `rgba(55,55,55,0.3)` × 0.25px |
| `cornerRadius` | 53 |
| child.Icon | 40×40 rounded 20 (image) |
| child.Text.title | 16/600 white, leading 14 — "8min away" |
| child.Text.subtitle | 12/500 white, leading 14 — "Arrives 9:45 - 9:50" |
| child.ActionIcon | 24×24 (car dim) |

### Inner spec — Lock Screen Shortcut (`769:10183`)
- w/h: **47 × 47**
- `fills`: `rgba(55,55,55,0.3)` + **backdrop-blur 6**
- `stroke`: `rgba(55,55,55,0.3)` × 0.25px
- `cornerRadius`: 61
- child: Phone icon 24×24 centered (aspect 24/24)

### Inner spec — Battery widget card (`746:2266`)
- w/h: **138 × 62**, `layoutMode`: HORIZONTAL, center/center, gap:10
- `fills`: `rgba(23,23,26,0.3)` + **backdrop-blur 6**
- `cornerRadius`: 20
- contains 2 × (arc icon 50×48 with centered icon + label 12/600 `rgba(255,255,255,0.8)`)

### Inner spec — Daily activity card (`746:2278`)
- same shell 138×62
- padding: pl:10 pr:14
- left: 48×48 icon; right: 3 rows (icon badge 10×10 + label 10/600 `rgba(255,255,255,0.86)`)

---

## FRAME 3 — Notifications  (`node-id=989:22754`)

### Geometry
- `absoluteBoundingBox`: { x: 0, y: 0, **w: 451, h: 978** }

### Style
- `fills`: background image + `rgba(23,23,26,0.3)` + **backdrop-blur 25**
- `cornerRadius`: 40

### Structure
```
Notifications (989:22754)
├─ Background (989:22755) — wallpaper
└─ Grid (989:22758)  [FLEX col, gap 10]
   ├─ Header stack (989:22759)
   │  ├─ Status bar        — DGX-TJG + WiFi/Cell/Battery, 44h
   │  └─ Top (989:22761)   — Time 8:21 26/700 + "Thu 28 Aug" 18/500
   ├─ "Live notifications" label — 14/400 white
   ├─ Media card (989:22768)     — 408×180, px:29 py:14, radius 36
   ├─ LiveNotification           — 415×86 Glass card w/ icon
   ├─ "Other notifications" label
   ├─ AI Regular notification    — gradient from rgba(102,161,243,0.4) to rgba(34,201,166,0.4)
   └─ Stack notification         — grouped 91h
```

### Inner spec — Grid (`989:22758`)
| property | value |
|---|---|
| `layoutMode` | VERTICAL |
| `itemSpacing` | 10 |
| `padding` | pt:18, px:18 |
| `fills` | `rgba(23,23,26,0.3)` + **backdrop-blur 25** |
| `cornerRadius` | 40 |
| `layoutSizingHorizontal` | FIXED 451 |

### Inner spec — Media card (`989:22768`)
| property | value |
|---|---|
| width × height | 408 × 180 |
| `padding` | px:29, py:14 |
| `fills` | image (album art) |
| `cornerRadius` | 36 |
| content | vertical flex, h:152, justify-between |
| rows | (app label + output chip) / (title 14/500 + artist 12/400) / (progress bar 347×19.5 + time 02:41 / 03:24) / (5 control icons gap 30) |

### Inner spec — Live notification (`544:1110`)
- w × h: **415 × 86**
- `layoutMode`: HORIZONTAL, items:center, gap:15
- `padding`: px:16
- `fills`: gradient linear -89.72° from `rgba(23,23,26,0.3)@31%` to `#000@118%` + **backdrop-blur 12**
- `cornerRadius`: 50
- Title 20/600 `#efeef2` (leading normal), subtitle 14/400 `#cfcccf`
- right: 3 action icons 16×16 (rounded chip 63.636) gap:22

### Inner spec — AI Regular notification (`1109:9522`)
- w × h: **415 × 86**
- `layoutMode`: HORIZONTAL, items:center, gap:10
- `padding`: pl:16, pr:20, py:15
- `fills`: `linear-gradient(to right, rgba(102,161,243,0.4) 0%, rgba(34,201,166,0.4) 100%)`
- `cornerRadius`: 50
- Shape 56×56 left + Stacked Unit (title+time 15/600 + subtitle 14/400) + right arrow-down 16×16

### Inner spec — Stack notification (`544:1097`)
- w × h: **415 × 91**, `padding`: py:15
- `cornerRadius`: 50 (outer)
- contains inner **Single Toggle** (bg `rgba(23,23,26,0.3)`, radius 50, 86h, pl:16 pr:20 py:15) with icon+title/time/subtitle+amount (`28`)
- separator: 332.963 × 3.659 arc

---

## FRAME 4 — Share Bottom Sheet  (`node-id=3010:2144`)

### Geometry
- `absoluteBoundingBox`: { x: 0, y: 0, **w: 451, h: 978** }

### Structure
```
Add a dialog (989:23707)
├─ Background          — wallpaper (blurred) + rgba(0,0,0,0.2) overlay
├─ Status Bar          — 9:41 + LiveActivity(Call pill) + WiFi/Cell/Battery
├─ Internet Pop-Out Menu (645:3079)
│  ├─ WebsiteShareHeader (645:4384)
│  │  ├─ Thumbnail 50×50 r:10
│  │  ├─ Title "One UI Design Kit" 18/600 white
│  │  ├─ URL 14/400 #848487
│  │  └─ Share icon container 42×42 r:14 (bg #17171a)
│  ├─ Separator 1px #5f5f61
│  ├─ BrowserTopBar (645:3292) — 5 items gap auto
│  │  └─ Contained icon+label × 5 (History/Downloads/Galaxy AI/Add page to/Settings)
│  │     ├─ chip 54×54 r:48, bg #17171a, shadow 0 4 4.7 rgba(0,0,0,0.25)
│  │     └─ label 14/400 white
│  └─ Browser icon box (645:2944) — 202h, radius 24
│     ├─ 2 rows of 4 icon+label cards (gap:48)
│     └─ PageIndicator 2 dots (active white, inactive rgba(255,255,255,0.6))
└─ Navigation bar home indicator — 144×4 rgba(255,255,255,0.6)
```

### Inner spec — Internet Pop-Out Menu (`645:3079`)
| property | value |
|---|---|
| width | 473 (full) |
| `layoutMode` | VERTICAL, items:center, gap:20 |
| `padding` | 16 |
| `fills` | `rgba(23,23,26,0.6)` + **backdrop-blur 24** |
| `cornerRadius` | 32 |

### Inner spec — WebsiteShareHeader (`645:4384`)
| property | value |
|---|---|
| width | 419 |
| `layoutMode` | VERTICAL, items:center, gap:20 |
| `padding` | pt:8, px:8 |
| children.row.gap | 15 |
| Thumbnail | 50×50, radius 10 |
| Title (default) | 18/600 `#FFFFFF` |
| URL | 14/400 `#848487`, ellipsis |
| Share chip | 42×42 r:14 bg `#17171a` (dark) / `#fcfcff` (light) |
| Separator | 1px `#5f5f61` (dark) / `#eaeaea` (light) |

### Inner spec — Contained icon+label (BrowserTopBar items)
| property | value |
|---|---|
| width | 54 |
| `layoutMode` | VERTICAL, items:center, gap:8 |
| chip bg | `#17171a` (dark) / `#fcfcff` (light) |
| chip radius | 48 |
| chip padding | 15 |
| chip shadow | `0 4 4.7 rgba(0,0,0,0.25)` (dark) / `0 4 7.7 -1 rgba(0,0,0,0.25)` (light) |
| icon size | 24×24 |
| label | 14/400 `#FFFFFF` (dark) / `#000000` (light), width 83, text-center |

### Inner spec — LiveActivity pill (`452:1121`)
- `fills`: `#0fcf6e`
- `layoutMode`: HORIZONTAL, items:center, gap:4
- `padding`: pl:4, pr:8, py:4
- `cornerRadius`: 10
- child: phone icon 12×12 + text 10/600 white tracking 0.1

### Inner spec — Browser icon box (`645:2944`)
| property | value |
|---|---|
| height | 202 |
| `layoutMode` | VERTICAL, items:center, justify:between |
| `padding` | px:25, py:21 |
| `fills` | `rgba(23,23,26,0.6)` |
| `cornerRadius` | 24 |
| rows | 2 × (4 icon+label cards, justify:between) |
| bottom | PageIndicator 6×6 dots, gap:6 |

### Inner spec — Icon+label card (`645:2804` etc.)
- w: **54**, `layoutMode`: VERTICAL, items:center, gap:6
- chip px:8 py:2 radius:48 (no fill, just hit target)
- icon 24×24
- label 14/400 white, width 84

---

## Shared Token Summary (raw, pre-normalization)

| token | value |
|---|---|
| **Frame** | 450/451 × 978, radius 40 |
| **Glass container strong** | `rgba(23,23,26,0.3)` + backdrop-blur 25 |
| **Glass container med** | `rgba(23,23,26,0.6)` + backdrop-blur 24 |
| **Glass chip weak** | `rgba(55,55,55,0.3)` + backdrop-blur 6 |
| **Now Bar glass** | `rgba(23,23,26,0.3)` + backdrop-blur 12 |
| **Tile border** | `1px rgba(255,255,255,0.2)` |
| **Shortcut border** | `0.25px rgba(55,55,55,0.3)` |
| **Tile radius** | 50 (QS) / 20 (Lock widgets) / 53 (Now Bar) / 61 (shortcut) / 32 (pop-out) |
| **Inner icon circle** | 56 r:63.636 p:13 ; inactive `rgba(180,180,180,0.2)` / active `#d5d5d5` |
| **Inactive text (title)** | `#efeef2` 15–16 / SemiBold(600) |
| **Inactive text (subtitle)** | `#cfcccf` 14 / Regular(400) |
| **Label (status)** | `rgba(255,255,255,0.8)` 15 / Bold(700) |
| **Font UI** | `One UI Sans APP VF` |
| **Font clock** | `SamsungNrDefault-V6` |
| **Grid item gap** | 18 (QS) · 10 (Notifications) · 16 (Lock widgets) · 20 (pop-out inner) |
| **Panel padding** | pt:18 px:22 (QS) · pt:18 px:18 (Notifications) · p:16 (pop-out) |

## `normalizeValues()` — One UI Guideline Snapping

Figma export values often contain sub-pixel noise (e.g. `63.636px`, `51.666px`, `3.659px`) or off-grid values (e.g. `17`, `22`, `47`). The One UI 8.5 guideline prescribes a **4dp base grid** with canonical radii; downstream consumers MUST use the normalized values, not raw Figma values, to preserve system consistency.

### One UI base grids

| grid | allowed values | usage |
|---|---|---|
| **Spacing (4dp)** | 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64 | gap / padding / margin |
| **Size (4dp ⊇ 8dp)** | 24, 32, 40, 48, 56, 64, 72, 88, 96, 128 | icon/tile size |
| **Radius (One UI radii)** | 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 50(pill) | cornerRadius |
| **Type scale** | 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 48, 64, 96, 112 | font-size |
| **Weight** | 400, 500, 600, 700 | fontWeight |
| **Touch target (min)** | 48 × 48 | interactive |

### Snapping rules (applied by `normalizeValues()`)

1. Snap to **nearest grid value**, preferring the **lower** step if equidistant.
2. Pill/round radii (circle toggles) snap to `size/2` (so `63.636@56` → `28`, rendered as `50%` or `9999px` pill).
3. Sub-pixel dividers (e.g. `3.659`) → `4`.
4. Exceptions (kept verbatim): **hero typography** (clock `112/82`), **established brand tokens** (pill `50` is canonical).
5. ±1px → snap silently. ±3px → snap with audit note. Beyond ±3px → surface as design-inconsistency.

### Applied normalizations (raw → normalized)

| raw | normalized | rule | location |
|---|---|---|---|
| 17 | **16** | 4dp grid | Tile Half px:17 |
| 18 | **16** | 4dp grid | QS panel pt/gap · Notifications px/pt |
| 22 | **24** | 4dp grid | QS panel px:22 |
| 26 | **24** | 4dp grid | Clock inner gap |
| 47 | **48** | size 4dp grid; meets 48 min-touch | Lock Shortcut |
| 50 | **50** (kept) | One UI canonical "pill" radius | Tile radius |
| 51.666 | **48** | touch target 48 (closest canonical) | SmartThings action buttons |
| 32.522 × 35 | **32 × 36** | 4dp grid | Shortcut open-icon container |
| 63.636 | **pill** (50%) | round | Toggle icon inner |
| 53 | **52** or `pill` | Now Bar radius (prefer `pill`) | Now Bar radius |
| 61 | **pill** (9999) | round shortcut | Lock shortcut chip |
| 199 | **200** | visual; paired with 208 tile gap | SingleToggle Half width |
| 332.963 | **336** | 4dp grid | separator width |
| 3.659 | **4** | 4dp grid | separator thickness |
| 15 (label text) | **14** (optional) | type scale — keep 15 for status only | `DGX-TJG` status label |
| 4.7 (shadow blur) | **4** | integer | chip shadow dark |
| 7.7 (shadow blur light) | **8** | integer | chip shadow light |
| 0.25 (stroke) | **0.5** | rendering subpixel | shortcut border |
| 0.15 (tracking) | **0.15** (kept) | CSS allows fractional | status label |

### Post-normalization token summary (authoritative for downstream docs/code)

```json
{
  "frame": { "w": 450, "h": 976 },
  "grid": 4,
  "radius": { "panel": 40, "tile": 50, "nowBar": 9999, "shortcut": 9999, "widget": 20, "media": 36, "popout": 32, "chip": 48 },
  "glass": {
    "strong": { "bg": "rgba(23,23,26,0.3)", "blur": 24 },
    "medium": { "bg": "rgba(23,23,26,0.6)", "blur": 24 },
    "weak":   { "bg": "rgba(55,55,55,0.3)", "blur": 8 },
    "nowbar": { "bg": "rgba(23,23,26,0.3)", "blur": 12 }
  },
  "stroke": { "tile": "1px rgba(255,255,255,0.2)", "shortcut": "0.5px rgba(255,255,255,0.2)" },
  "size": {
    "toggleSquare": 88, "toggleIcon": 56, "iconInner": 24, "iconInnerLg": 30,
    "shortcut": 48, "smartAction": 48, "widgetCard": { "w": 136, "h": 64 },
    "mediaCard": { "w": 408, "h": 180 }, "nowBar": { "w": 248, "h": 64 }
  },
  "spacing": {
    "panel": { "pt": 16, "px": 24 },
    "notifications": { "pt": 16, "px": 16, "gap": 8 },
    "qsGrid": 16,
    "tileHalf": { "px": 16, "py": 24 },
    "nowBar": { "pl": 12, "pr": 16, "py": 12, "gap": 12 }
  },
  "type": {
    "clock": { "family": "SamsungNrDefault-V6", "size": 112, "weight": 400, "leading": 82 },
    "title": { "family": "One UI Sans APP VF", "size": 16, "weight": 600, "color": "#EFEEF2" },
    "subtitle": { "family": "One UI Sans APP VF", "size": 14, "weight": 400, "color": "#CFCCCF" },
    "status": { "family": "One UI Sans APP VF", "size": 15, "weight": 700, "color": "rgba(255,255,255,0.8)", "tracking": 0.15 },
    "sectionLabel": { "family": "One UI Sans APP VF", "size": 14, "weight": 400, "color": "#FFFFFF" }
  },
  "colors": {
    "primary": "#FFFFFF",
    "secondaryText": "#848487",
    "containerDark": "#17171A",
    "containerLight": "#FCFCFF",
    "component": "#5F5F61",
    "liveActivity": "#0FCF6E",
    "toggleOn": "#D5D5D5",
    "toggleOff": "rgba(180,180,180,0.2)"
  }
}
```

### Audit notes (raw inconsistencies — see `evolve.md` for prevention rules)

- `padding px:17` in SingleToggle Half differs from One UI standard `px:16`.
- Shortcut 47×47 below the 48 min-touch-target.
- `0.25px` borders render inconsistently across pixel ratios.
- `22 px` panel side padding conflicts with the 24 dp rhythm.
- Now Bar radius `53` and Shortcut `61` are effectively pills given heights — use `pill` (9999) instead of magic numbers.

---

## Inferred Constraints (not exposed by Code Connect)

| element | `constraints.horizontal` | `constraints.vertical` |
|---|---|---|
| Frame outer (450×978) | LEFT_RIGHT | TOP_BOTTOM |
| Background image | SCALE | SCALE |
| Status Bar | LEFT_RIGHT | TOP |
| Lock Clock | CENTER | TOP |
| Now Bar | CENTER | BOTTOM |
| Lock shortcuts | LEFT / RIGHT (outer pair) | BOTTOM |
| QS grid tiles | LEFT_RIGHT (wrap) | TOP |
| Media card | LEFT_RIGHT | TOP |
| Notification cards | LEFT_RIGHT | TOP |
| Page indicator dots | CENTER | BOTTOM |
| Home indicator bar | CENTER | BOTTOM |

---

# Part 2 — Component Trees (raw structural extraction)

Source: Figma nodes `3011:4240`, `645:3080`, `645:4429`, `479:8075`, `390:427`, `836:4040`, `838:4076`.

### DialogBlurred (3011:4240)
- Geo: 328 × auto, radius 28, padding 20, gap 20
- Fill: dark `rgba(23,23,26,0.6)` / light `rgba(252,252,255,0.5)`, backdrop-blur 24
- Children: `Icon?` (40) → `ExtraContent?` (radius 28) → `TextGroup{Title 20/SemiBold, Description 14/Regular}` → `Buttons{Option(Cancel), Divider 2×32, Option(Apply) — 20/Bold}`

### InternetPopOutMenu (645:3080)
- Geo: 473 × auto, radius 32, padding 16, gap 20
- Fill: glass `rgba(23,23,26,0.6)` / `rgba(252,252,255,0.6)`, blur 24
- Children:
  - `WebsiteShareHeader` → `{Thumbnail 50×50 r10, TextBlock{Title 18/SemiBold + Url 14 muted}, ShareChip 36 r14 bg #17171A, Divider 1px}`
  - `BrowserTopBar` → 5 × `ContainedIconLabel{IconChip 48dp pill bg #17171A, shadow 0 4 4.7, Label 14/Regular}`
  - `BrowserIconBox` (inner glass r24) → 2 × `IconRow(4 items)` + `PageIndicator{dot 6 r-pill ×2}`

### GalleryPopOutMenu (645:4429)
- Geo: 415 × auto, radius 28, padding 24, gap 20
- Fill: glass + blur 24
- Children:
  - `TopIconRow` → 4 × `IconTile{Chip 48dp, Label 14}`
  - `LongButtonRow1` → 2 × `PillButton{radius 28, padding 38×11, bg #17171A, Icon 24 + Label 14}` one with `BadgeDot 6 #E65B17`
  - `LongButtonRow2` → 2 × `PillButton`
  - `StudioCard{AppIcon 24, Label 18/Regular, Chevron 24}` — radius 28 bg #17171A

### Toast (479:8075)
- Geo: 328 × auto (outer pad 10), inner pill radius 54→pill, padding 10h×8v, gap 10
- Fill: dark `#010102` / light `#F1F1F3`; no blur
- Children: `Icon? 24` → `Text 14/Regular` (flex-1) → `SnackbarButton{pill r20, pad 20×4, inverse bg, Label 14/SemiBold}`

### Container Scaffold (390:427)
- Geo: 412w, radius 16 outer, bg `#010102`
- Hierarchy:
  - `StatusBar` → `{Time 15/Bold, NotificationIcons, LiveActivity{PhoneIcon 12 + Timer 10/SemiBold, bg #0FCF6E r10}, StatusIcons{WiFi, Cellular, Battery}}`
  - `InnerStack` (r38→40, pad 10, gap 20) →
    - `HeaderContainer{AppIcon 74, Title 36/Bold, Info 14, MiniButton pill r28}`
    - `Card{Leading 24, TextCol{Title 18, Info 14}, Switch 40×22 r22.5 bg #0381FE | Chevron}`
    - `TextContainer` (body 14)
    - `MenuItemCard{Icon 24, Label 18}`
    - `MenuItemWithBodyCard{Icon 24, TextCol{Title 18, Body 14}}`
    - `SliderCard{Subheading 18, Sliders75{Icon, Track 19h r40 bg #848487, Fill r10 bg #387AFF, Thumb 24 r12 bg #000 + 2px #387AFF}}`
  - `NavigationBar{Indicator 144×4 r2 rgba(255,255,255,0.6), gradient 0→#17171A}`

### Now Bar / Navigation (836:4040)
- Geo: ~415w, radius pill (50), padding 20, gap 8 (normalized from 10)
- Fill: `rgba(55,55,55,0.3)` + 0.5px border `rgba(150,150,150,0.6)`, blur 25
- Children:
  - `HeaderRow{IconBadge 56 pill bg #0C8FAE + Glyph.location 36, Title 19/500, Subtitle1 15, Subtitle2 15/50% alpha}`
  - `ProgressTrack{Base 1dp white, Fill, ThumbChip 28 pill bg #0C8FAE + 3dp ring #D9E7FC + Glyph.driving 18}`
  - `ActionBar{Button.EndTrip pill r17, pad 14×10.5, label 15/500}` ⚠ under 48dp touch

### Now Bar / Activity (838:4076)
- Geo: 415 × 180, radius pill, padding 20, gap 8
- Fill/border/blur: same as 836:4040
- Children:
  - `HeaderRow{IconBadge 56 pill bg #4ED877 + samsung_health 36, Title 19/500, Metrics 15/50% alpha}`
  - `ProgressTrack{…, ThumbChip 28 pill bg #4ED877 + Glyph.running 18}`
  - `DialogBlurred/ActionBar r28 pad 20 gap 20 → Buttons{Pause 15/500, Finish 15/500}` ⚠ 47dp touch

---

## Composition Tokens (raw, sourced from Part 2 nodes)

| token | value | source |
|---|---|---|
| `glass.liveActivity.fill` | `rgba(55,55,55,0.30)` | 836, 838 |
| `glass.liveActivity.border` | `0.5px rgba(150,150,150,0.60)` | 836, 838 |
| `glass.liveActivity.blur` | 25 | 836, 838 |
| `nowbar.padding` | 20 | 836, 838 |
| `nowbar.gap` | 8 (from raw 10) | 836, 838 |
| `nowbar.radius` | pill (50) | 836, 838 |
| `iconBadge.size` | 56 (from raw 55) | 836, 838 |
| `iconBadge.radius` | pill | 836, 838 |
| `iconBadge.accent.navigation` | `#0C8FAE` | 836 |
| `iconBadge.accent.health` | `#4ED877` | 838 |
| `thumbChip.size` | 28 | 836, 838 |
| `thumbChip.ring` | 3dp `#D9E7FC` | 836, 838 |
| `iconChip.shadow` | `0 4 4.7 rgba(0,0,0,0.25)` dark | 645:3080 |
| `badgeDot.size` | 6 r-pill `#E65B17` | 645:4429 |
| `studioCard.radius` | 28 | 645:4429 |
| `toast.radius` | pill | 479:8075 |
| `toast.button.radius` | pill (20) | 479:8075 |
| `dialog.radius` | 28 | 3011:4240 |
| `popoutMenu.radius` | 32 (browser) / 28 (gallery) | 645:3080, 645:4429 |
| `scaffold.outerRadius` | 16 | 390:427 |
| `scaffold.innerStack.radius` | 40 (from raw 38) | 390:427 |
| `switch.track` | 40×22 r-pill bg #0381FE | 390:427 |
| `slider.track.height` | 19, r40, bg #848487 | 390:427 |
| `slider.thumb` | 24 r12 bg #000 + 2px #387AFF | 390:427 |
| `navIndicator` | 144×4 r2 rgba(255,255,255,0.6) | 390:427 |

## Touch-Target Audit (raw measurements only — fixes in evolve.md)

- Now Bar "End Trip" button measured at 28dp.
- Now Bar "Pause" / "Finish" measured at 47dp.
- Thumb chip on progress track measured at 28dp (visual only, not tappable).
