# ORCHESTRATION SPEC — Screen Composition & Layout Assembly

**Layer**: ORCHESTRATION SPEC
**Lives here**: Screen-level composition rules — stacking order, gaps between components, anchoring, z-layers, grouping, frame rules — describing HOW components combine into screens.
**Does NOT live here**: Individual component visual specs (see `DESIGN.md`), raw Figma measurements (see `figma-refs/extracted.md`), runtime selection logic (see `GENUI-PRINCIPLES.md`), refinement memory (see `evolve.md`).

---

## 1. Screen Frame Structure

Every Samsung One UI 8.5 screen follows a fixed vertical frame:

```
┌─────────────────────────────────┐
│ Status Bar (24dp)               │  z:200, static, fixed top
├─────────────────────────────────┤
│ App Bar (56dp) — optional       │  z:10, static, fixed or scroll-away
├─────────────────────────────────┤
│ Content Area (flex: 1)          │  z:0, scrollable
├─────────────────────────────────┤
│ Bottom Nav (64dp) — optional    │  z:10, static, fixed bottom
├─────────────────────────────────┤
│ Nav Bar (48dp gesture / 20dp)   │  z:200, static, fixed bottom
└─────────────────────────────────┘
```

### Frame Measurements
- Total viewport: 360 × 780dp standard, 360 × 800dp tall
- Status Bar layout: `time(left, 14dp inset) | notification-pill(center) | system-icons(right, 14dp inset)`
- App Bar: padding 0 16, back icon left, title 16dp from icon-or-edge, overflow icons gap 24
- Bottom Nav: glass pill, padding 24h, items evenly distributed
- Navigation Bar gesture: pill 134×5 centered, bottom 8

---

## 2. Vertical Stacking Rules

### Component-to-Component Gaps

| From → To | Gap (dp) | Notes |
|---|---|---|
| Status Bar → App Bar | 0 | Seamless join |
| Status Bar → Content (no AppBar) | 0 | Lock screen, wallpaper screens |
| App Bar → First Content | 0 | Content scrolls under AppBar |
| App Bar → Section Title | 16 | When first element is a heading |
| Section Title → First Item | 8 | Tight coupling title→content |
| Card → Card | 12 | Vertical card list |
| Card → Card (same group) | 8 | Related cards cluster tighter |
| List Item → List Item | 0 | Divider provides separation |
| List Item → Section Header | 16 | New section breathing room |
| Button → Button (vertical) | 8 | Stacked actions |
| Input → Input | 16 | Form fields |
| Input → Helper Text | 4 | Error/hint hugs field |
| Chip Row → Content Below | 16 | Filter chips above list |
| Content → FAB | n/a | FAB absolute positioned |
| Last Content → Bottom Nav | 64 clear | Avoid hide under nav |

---

## 3. Horizontal Layout Rules

### Alignment Patterns

| Pattern | Usage | Spec |
|---|---|---|
| Edge-to-edge | Cards, media, dividers | `margin: 0; width: 100%` |
| Standard inset | Padded content | `padding: 0 24dp` mobile |
| Card inset | Cards within padded content | `margin: 0 16dp` |
| Center-aligned | Dialogs, empty states, hero | `align-items: center; text-align: center` |
| Split horizontal | Label+value, title+action | `justify-content: space-between` |

### Horizontal Component Groups

| Group | Gap | Alignment |
|---|---|---|
| Button + Button (horizontal) | 8 | center |
| Icon + Label (inline) | 8 | vertical center |
| Avatar + Text Block | 12 | vertical center, text top-aligned if multi-line |
| Chip + Chip | 6 | wrap allowed |
| Action Icon + Action Icon (AppBar) | 24 | vertical center |
| Tab + Tab (Pill Tab Bar) | 0 | items fill container evenly |

---

## 4. Quick Settings Panel Assembly

```
[Status Bar — 24, static]                   gap 0
[Action Bar — 48]   padding 0 16            icons right [edit, power, settings]
[QS Toggle Grid]    padding 0 24            4 cols × 2 rows (page 1)
                                            grid-gap 12 H · 16 V
[Page Indicator — 3 dots, gap 6]            gap 12 above, 16 below
[Brightness Slider]  padding 0 24, h 48     gap 16
[Tile Cards — 2-col grid]  padding 0 16, gap 8
[Media Control] padding 0 16  2 chips gap 8
[Bottom Shortcuts] padding 0 16  2 items gap 12
[Navigation Bar — 48 (3-button)]
```

### QS Composition Rules
- 4 columns mobile, 6 columns tablet
- toggle grid-gap 12 horizontal, 16 vertical
- tile cards layout: `[icon left] [title] [subtitle below] [action-icon right]`
- gap icon→text 12; gap title→subtitle 2

---

## 5. Lock Screen Assembly

```
[Status Bar — 24, transparent]              gap 0
[Wallpaper — full bleed, z:0]
[Clock]   position ~25–35% from top         gap 4 → date
[Widgets] below clock, max 2 compact, gap 8
[flex spacer]
[Now Bar Row — bottom anchored]   bottom 72 (20 nav + 52 clear)
  layout: [quick-action 48] [now-bar flex] [quick-action 48]   gap 8
[Navigation Bar — 20, gesture]
```

### Now Bar Adjacent Row
```
┌──────────┐  ┌────────────────────────┐  ┌──────────┐
│  Phone   │  │   Now Bar (pill)       │  │  Camera  │
│  48×48   │  │   flex: 1              │  │  48×48   │
└──────────┘  └────────────────────────┘  └──────────┘
     gap 8           gap 8
Outer row padding 0 16, align-items center
```

---

## 6. Home Screen Assembly

### Default Home (widgets + apps)
```
[Status Bar — 24]                           gap 0
[Wallpaper full-bleed]
[Widget Zone — starts ~140–200 from top]    padding 0 16
  2-col widget grid, gap 8 H · 8 V          max 3–4 rows visible
[Search Bar]   full-width minus 32 margin   h 48, radius 999, glass
[App Icon Grid]  padding 0 24               4 cols, col-gap ~28, row-gap 20
[Page Indicator — centered]                 dots 6, gap 6
[Dock — 4 icons]   ~48 above nav            no labels, gap evenly
[Navigation Bar — 48]
```

### Widget-Heavy Home (no app grid)
```
[Status Bar — 24]                           gap 0
[Widget Area]   padding 0 16
  Row 1: full-width (4×2)                   gap 8 below
  Row 2: 2-column mixed (2×2 + 2×1 stacks)  gap 8
  Row 3: 2-column equal (2×2 + 2×2)
[Dock — 4 icons]
[Navigation Bar — 48]
```

### App Drawer
```
[Status Bar — 24]                           gap 0
[App Icon Grid — full screen]   padding 24 24 0
  4 cols × N rows, col-gap ~28, row-gap 24, max ~5 rows visible
[flex spacer]
[Page Indicator — 3 dots, centered]         gap 16 below last row
[Search Bar]    padding 0 16, h 44, radius 999, glass G1
                margin-bottom 8 above nav
[Navigation Bar — 48 (3-button)]
```

---

## 7. Widget Grid Composition Rules

```
Grid: 4 columns base (each ~82dp + 8dp gap)
Container padding: 16dp horizontal (= 360 - 32 = 328dp usable)
Widget gap: 8dp (both axes)
2-unit width = ~168–176dp  |  4-unit width = ~344–368dp

Stacking: widgets snap to grid, sizes from fixed set only
Mixed heights OK: 2×2 left + two 2×1 stacked right
Height alignment: top-aligned per row, next row = tallest + 8dp
Maximum: ~3–4 rows visible above dock
Scroll: vertical if widget area exceeds visible space
```

### Widget Color Behavior
- Opaque fill: weather (sky blue), alarm (purple), calendar (white/surface)
- Semi-transparent: health, greeting — glass G0/G1
- Image fill: photo widget — image clips to radius
- Tinted: greeting/AI widgets — wallpaper palette, warm tint
- Rule: no two adjacent widgets share the same background color

---

## 8. App Icon Grid & Dock

### Grid Layout
```
Columns: 4 (mobile) / 5 (tablet)
Column gap: evenly distributed (≈28dp on 360dp)
Row gap: 24dp
Container padding: 0 24dp
Max visible rows: 4–5 without scroll
```

### Dock Layout
```
Position: ~48dp above navigation bar
Items: 4 (always)
Gap: evenly distributed (≈28dp)
No labels
Optional glass pill background: radius 999, padding 8 20, glass G0
Separator: 12dp gap to page indicator above
```

### Page Indicator (home)
- centered horizontally between app grid and dock
- dots 6dp, gap 6dp; vertical margin 12 above dock, 12 below grid

### Search Bar (drawer bottom)
- bottom of drawer above nav bar; height 44, radius 999, glass G1
- placeholder left, overflow icon right
- margins: 8 above nav, 16 below page indicator; full-width minus 32

---

## 9. Container Nesting Rules

### Card Internal Order
```
Card (radius 26, padding 16–20)
├── Header Row (optional)   Icon/Avatar 40 + gap 12 + Title + Subtitle
├── gap 12
├── Content Area
├── gap 16 (before actions)
└── Action Row (optional)   align right or space-between, button gap 8
```

### Dialog Internal Order
```
Dialog (radius 26 top, padding 24)
├── Title 18/700
├── gap 8
├── Description 14/400 line-height 1.5
├── gap 24
└── Button Row
    ├── height 48, border-top 1px divider
    ├── Cancel (flex 1, flat, left)
    ├── 1px vertical divider
    └── Apply (flex 1, flat, right)
```

### Notification Card Internal Order
```
Notification (radius 999, padding 16 20)
├── App Icon 20, circle
├── gap 8
├── App Name 12/500 text-3
├── flex spacer
├── Timestamp 11/400 text-3
├── (next line, full width)
├── Title 14/600
├── gap 2
└── Preview 13/400 text-2 max 2 lines
```

### Radius Stepping (depth)
Outer → inner: **16 (device) → 40 (hero stack) → 28 (card) → 20 (chip) → pill (control)**.
Children must never have a larger radius than their parent. The InnerStack (40) within a 16-radius scaffold is a documented "hero wrapper" exception.

### Glass Stacking (depth)
Outermost `nowbar (0.3α)` floats above `popout (0.6α)` above `solid card #17171A`.
Glass surfaces only at **top-of-stack floating** layers.
Never place a solid sibling at the same z-depth as a transparent one.

---

## 10. Z-Layer & Overlay System

### Z-Index Stack
| Layer | Z-Index | Elements | Material |
|---|---|---|---|
| Base | 0 | Content, lists, grids | Opaque or surface |
| Floating | 10 | FAB, Bottom Nav, Pill Tab | Glass G1 |
| Elevated | 20 | Snackbar, Toast | Glass G2 |
| Panel | 50 | Bottom Sheet, QS Panel | Glass G2 + dim |
| Overlay | 90 | Bottom Sheet (expanded) | Glass G2 + dim |
| Modal | 100 | Dialog | Glass G2 + dim(0.65) |
| Now Bar | 150 | Now Bar (above panels) | Tinted glass G2 |
| System | 200 | Status Bar, Nav Bar | Transparent or glass G0 |

### Overlay Dim
- **Dialog**: `rgba(0,0,0,0.65)` full viewport behind
- **Bottom Sheet**: `rgba(0,0,0,0.4)` behind, touch-to-dismiss
- **QS Panel**: none (replaces content)
- **Snackbar**: no dim
- **Rule**: only ONE overlay layer active at a time. Priority: Dialog > Sheet > Snackbar.

### Dialog Overlay (full-width bottom sheet style)
```
Dim: rgba(0,0,0,0.65), z:100, full viewport
Container: bottom of screen, 0 from bottom
  width 100%, radius 26 top-left/right, 0 bottom
  padding 24 all sides
  Title → Description gap 8
  Description → Button row gap 24
  Button row: 2 buttons, separated 1px vertical divider, each flex:1 h:48
```

---

## 11. Scroll Behavior & Anchoring

### Fixed Elements (never scroll)
- Status Bar (top)
- Navigation Bar (bottom)
- Bottom Nav (above nav bar)
- FAB (bottom-right, 16 inset)
- Now Bar (lock screen only)

### Scroll-Reactive Elements
- App Bar: opacity 1→0 on downward scroll, returns on upward
- Floating Pill Tab: 2dp parallax upward shift
- Section headers: sticky top below AppBar within their section

### Content Anchoring
| Anchor | Behavior | Clear Zone |
|---|---|---|
| Top | Content starts below AppBar | 56 |
| Bottom (BottomNav) | Above nav | 64 + 20 = 84 |
| Bottom (no nav) | Above gesture bar | 20 |
| Center-V | Lock screen, empty states | Equal top/bottom padding |
| FAB | Bottom-right corner | 16 from right, 16 above BottomNav |

---

## 12. Touch Target & Clearance

### Minimum Touch Targets
| Element | Min Touch | Visual |
|---|---|---|
| Button | 48×48 | 48×height |
| Icon button | 48×48 | 24×24 visual |
| List item | full-width × 56 | full-width × 56 |
| QS Toggle | 72×72 | 64 visual |
| Chip | 48×32 | auto×32 |
| Switch | 52×48 | 52×32 visual |
| Bottom Nav item | 72×64 | 24 icon + label |
| Tab | 48×46 | auto×46 |

### Clearance
- Min 8dp gap between any two interactive elements (vertical or horizontal)
- FAB clearance 16dp from nearest interactive
- Edge clearance 8dp minimum
- Bottom safe area 20dp

---

## 13. Responsive Breakpoints (composition)

| Viewport | Cols | Side Padding | Card Width | Behavior |
|---|---|---|---|---|
| < 360 | 1 | 16 | full − 32 | compact single column |
| 360–479 | 1 | 24 | full − 48 | standard mobile |
| 480–691 | 1–2 | 24 | max 420 or 2-col | large phone / small tablet |
| 692–987 | 2 | 32 | (w − 72)/2 | tablet |
| 988+ | 2–3 | 40 | max 400/col | desktop |

### Breakpoint Grid Behavior
- QS Grid: 4 cols mobile, 6 cols tablet
- Widget Grid: 4-col base, sizes snap
- Card Grid: 1 mobile, 2 tablet, 2–3 desktop
- Bottom Nav: pill on mobile, side rail on tablet/desktop

### Web breakpoints (alternate)
| Name | Width |
|---|---|
| Mobile | <768 |
| Tablet | 768–1279 |
| Desktop | 1280–1920 |
| Large Desktop | >1920, centered with 1920 max wrapper |

Web container widths: 988 desktop / 692 tablet / 360 mobile (24 padding).

---

## 14. Composition Templates (Figma-verified trees)

### DialogBlurred
```
DialogBlurred(w=328, r=28, pad=20, gap=20, fill=glass.medium, blur=24)
  ├─ Icon?            (40)
  ├─ ExtraContent?    (r=28, dashed 4px #848487)
  ├─ TextGroup
  │    ├─ Title       (20/SemiBold)
  │    └─ Description (14/Regular)
  └─ Buttons          (row, 2 equal, divider 2×32)
       ├─ Option(Cancel) 20/Bold
       └─ Option(Apply)  20/Bold
```

### InternetPopOutMenu
```
InternetPopOutMenu(w=473, r=32, pad=16, gap=20, glass.medium)
  ├─ WebsiteShareHeader
  │    ├─ Thumbnail(50, r=10)
  │    ├─ TextBlock{Title 18/SemiBold, Url 14 muted}
  │    ├─ ShareChip(36, r=14, bg=#17171A)
  │    └─ Divider(1px)
  ├─ BrowserTopBar (5× ContainedIconLabel)
  └─ BrowserIconBox (inner glass r=24)
       ├─ IconRow(4× IconWithLabel)
       ├─ IconRow(4× IconWithLabel)
       └─ PageIndicator(2× dot 6)
```

### GalleryPopOutMenu
```
GalleryPopOutMenu(w=415, r=28, pad=24, gap=20, glass.medium)
  ├─ TopIconRow (4× IconTile{Chip 48, Label 14})
  ├─ LongButtonRow1 (2× PillButton{r=28, pad=38×11, bg=#17171A}, one w/ BadgeDot)
  ├─ LongButtonRow2 (2× PillButton)
  └─ StudioCard{AppIcon 24, Label 18, Chevron 24} r=28
```

### Toast
```
Toast(w=328, outerPad=10)
  └─ Content(pill, pad=10×8, gap=10, bg dark=#010102 | light=#F1F1F3)
       ├─ Icon?            (24)
       ├─ Text             (14/Regular, flex-1)
       └─ SnackbarButton   (pill r=20, pad=20×4, inverse bg, Label 14/SemiBold)
```

### Scaffold (canonical phone frame)
```
Container(w=412, r=16, bg=#010102)
  ├─ StatusBar
  │    ├─ Time(15/Bold, 0.8α)
  │    ├─ NotificationIcons (19)
  │    ├─ LiveActivity{PhoneIcon 12 + Timer 10/SemiBold, bg=#0FCF6E r=10}
  │    └─ StatusIcons {WiFi, Cellular, Battery}
  ├─ InnerStack(r=40, pad=10, gap=20)
  │    ├─ HeaderContainer{AppIcon 74, Title 36/Bold, Info 14, MiniButton pill r=28}
  │    ├─ Card{Leading 24, TextCol{Title 18, Info 14}, (Switch | Chevron)}
  │    ├─ TextContainer (body 14)
  │    ├─ MenuItemCard{Icon 24, Label 18}
  │    ├─ MenuItemWithBodyCard{Icon 24, TextCol{Title 18, Body 14}}
  │    └─ SliderCard{Subheading 18, Sliders75{Icon, Track, Fill, Thumb}}
  └─ NavigationBar{Indicator 144×4 r=2}
```

### NowBar / Navigation
```
NowBar(w=415, r=pill, pad=20, gap=8, glass.liveActivity)
  ├─ HeaderRow
  │    ├─ IconBadge(56, pill, bg=#0C8FAE) + Glyph.location 36
  │    ├─ Title       (19/500 white)
  │    ├─ Subtitle1   (15/500 white)
  │    └─ Subtitle2   (15/500 rgba(255,255,255,0.5))
  ├─ ProgressTrack
  │    ├─ Track.Base  (1dp white)
  │    ├─ Track.Fill
  │    └─ ThumbChip(28, pill, bg=#0C8FAE, ring 3dp #D9E7FC) + Glyph.driving 18
  └─ ActionBar
       └─ Button.EndTrip (pill, pad=14×10.5, label 15/500)
```

### NowBar / Activity
```
NowBar(w=415, h=180, r=pill, pad=20, gap=8, glass.liveActivity)
  ├─ HeaderRow
  │    ├─ IconBadge(56, pill, bg=#4ED877) + Glyph.samsung_health 36
  │    ├─ Title "Running - 00:13 / 20:00" (19/500)
  │    └─ Metrics (15/500 50% α)
  ├─ ProgressTrack(…, ThumbChip bg=#4ED877 + Glyph.running 18)
  └─ DialogBlurred (r=28, pad=20, gap=20)
       └─ Buttons
            ├─ Button.Pause  (15/500)
            └─ Button.Finish (15/500)
```

---

## 15. Composition Rules

| Rule | Application |
|---|---|
| Icon **identity** uses 56dp accent pill (IconBadge); icon **action** uses 48dp neutral pill + shadow (IconChip). Never mix. | NowBar/Hero vs menus/bars |
| Action buttons inside a glass NowBar must wrap in an inner DialogBlurred (r=28) for legibility | NowBar/Activity Pause+Finish |
| Radius stepping outer→inner: 16 → 40 → 28 → 20 → pill | Scaffold and all popouts |
| Glass depth: nowbar (0.3α) above popout (0.6α) above solid card (#17171A) | Never solid under transparent sibling |
| Pop-out menus: 32 (browser/share, wide) or 28 (gallery, tighter) | Width dictates radius choice |
| Progress thumbs share a single style across NowBar variants (Nav / Activity / Media) | Component spec lives in `DESIGN.md`; rule here is "reuse same thumb across NowBar variants" |
| LiveActivity status pill is embedded inline within the Status Bar center slot | Status-bar composition only; component visual spec lives in `DESIGN.md` |

---

## 16. Connected Component Pairs

| Pair | Spatial Rule |
|---|---|
| AppBar + SearchBar | Search below AppBar gap 0, or embedded in AppBar |
| Card + ActionSheet | Sheet rises from card; share radius on connected edge |
| List + FAB | FAB floats over list; last list item has 72dp bottom padding |
| Input + ErrorText | Error 4dp below input, 12/var(--error) |
| Tabs + TabContent | Gap 0; content swipes horizontally; tabs fixed |
| Now Bar + Lock Shortcuts | Same horizontal row; Now Bar flex:1, shortcuts fixed 48 |
| Dialog + Dim | Dim covers everything below z:100; dialog centered or bottom |
| Notification + Notification | Stack vertically gap 8, same radius/material |
| QS Toggle + QS Toggle | Grid layout only — never free-positioned |
| Widget + Widget | Grid snapping only, gap 8, sizes from fixed set |

---

## 17. Animation Sequencing

### Entry Stagger Order (screen load)
1. **Static chrome** (0–40ms): Status bar, App bar, Bottom nav — fadeIn
2. **Primary content** (100–200ms): Main heading, hero image — slideUp
3. **Secondary content** (200–350ms): Cards, list items — slideUp stagger 40ms
4. **Tertiary** (350–500ms): Chips, badges, metadata — fadeIn
5. **Floating** (400–600ms): FAB, Now Bar — scaleUp + spring

### Density Layer Transitions
- Lock → Notification Shade: slideDown 400ms, gen curve
- Notification Shade → QS Full: expand 500ms, gen curve
- QS Full → Notification Shade: collapse 400ms, gen curve
- Any → Dialog: fadeIn 200ms dim + scaleUp 300ms dialog

---

## 18. Anti-Patterns (Composition)

| Anti-Pattern | Correct Pattern |
|---|---|
| Card inside Card | Flat content sections within card |
| Dialog with > 2 buttons | Max 2; use ActionSheet for 3+ |
| FAB overlapping Bottom Nav | FAB 16dp above Bottom Nav top edge |
| Full-width button inside narrow card | Button matches card padding (inset 16–20) |
| Scrollable inside scrollable | Only horizontal-within-vertical permitted |
| Opaque overlay on glass surface | Use glass material for floating elements |
| Mixed radius in same container | All children share parent's radius system |
| Interactive elements under 8dp gap | Min 8dp between any two tappable |
| Text directly on wallpaper without scrim | Use glass container or text shadow |
| > 5 items in Bottom Nav | Max 5; "More" for overflow |
| IconBadge < 56dp in identity context | Promote to 56dp accent pill |
| IconChip without shadow inside glass surface | Add `0 4 4 rgba(0,0,0,0.25)` |
| Button row in glass NowBar not wrapped in DialogBlurred | Wrap in r=28 inner surface |
| Radius non-stepping (child larger than parent) | Step radii outer→inner |
| Glass surface with opaque sibling at same z-depth | Promote opaque to solid card layer beneath |
| Tappable element with hit area < 48dp | Expand hit area via padding |
