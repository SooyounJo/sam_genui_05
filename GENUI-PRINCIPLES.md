# GENERATIVE PRINCIPLES — Samsung One UI 8.5 Gen UI

**Layer**: GENERATIVE PRINCIPLES
**Lives here**: Runtime decision logic — when to use which component, context-driven selection, density progression, the Static/Generative model, composition grammar, and dual-mode rendering rules.
**Does NOT live here**: Raw extracted numbers (see `figma-refs/extracted.md`), individual component visual specs (see `DESIGN.md`), screen-assembly geometry (see `ORCHESTRATION.md`), refinement memory (see `evolve.md`).

---

## 1. Premise

Samsung One UI 8.5 is **Gen UI**: interface composition is determined at runtime by evaluating user state, temporal context, active services, and device conditions, then selecting, parameterizing, and arranging components from a finite vocabulary according to a set of compositional rules.

This document defines twelve principles governing that runtime composition.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Gen UI** | System where component composition is determined at runtime based on contextual inputs |
| **Static Component** | UI element whose presence and position are fixed within a surface (persistent chrome) |
| **Gen Component** | UI element whose presence, configuration, and content are determined dynamically |
| **Surface** | Full-screen or overlay canvas onto which components are projected |
| **Chrome** | Persistent structural frame of a surface |
| **Composition** | Selecting, parameterizing, arranging Gen Components within a surface |
| **Slot** | Designated region within a surface that accepts Gen Components |
| **Context Vector** | Set of runtime inputs `C = {t, a, s, d, n}` (time, activity, services, device, notifications) |

---

## 3. Component Classification (S vs G)

### Decision Procedure
1. **Presence Test**: Can this component be absent under any valid system state? If yes → Generative.
2. **Position Test**: Does it occupy a fixed position regardless of other components? If yes → Static.
3. **Parameterization Test**: Is its *structure* (not just data) determined at runtime? If yes → Generative.

A "no, yes, no" answer = Static. Any other result = Generative.

### Static Components (Persistent Chrome)
| Component | Why Static |
|---|---|
| Status Bar | Always present, fixed position, fixed structure |
| Navigation Bar | Always present, mode set at settings level |
| App Bar | Always present in-app; text varies but structure fixed |
| Bottom Navigation | Always present in-app; tab content swaps but bar persists |

### Generative Components
| Component | Trigger Condition |
|---|---|
| Notification Card | Any pending notification |
| Now Bar | Active foreground service (media, timer, delivery, charging) |
| Lock Screen Widget | User configuration + data availability |
| Quick Settings Toggle | System capabilities + user-configurable arrangement |
| Media Player Card | Active media session |
| Home Screen Widget | User placement + provider data |
| Status Bar notification pill | Live notification present |
| Compound (SmartThings, Snackbar, Dialog, Edge Panel, Keyboard, Browser Top Bar, Page Indicator, Connected Tab, Bottom FAB, Slide Nav Button) | Context-dependent |

(Component visual specs live in `DESIGN.md`. Composition layouts live in `ORCHESTRATION.md`.)

---

## 4. The Static/Generative Model

```
U = S + G

Surface = Chrome(S) + Canvas(G*)

where:
  Chrome(S)  = fixed layout of static elements
  Canvas(G*) = zero or more generative elements in slotted regions
```

A surface with no active context vector renders only its Chrome. As context accumulates, Gen components populate the canvas.

---

## 5. The Twelve Principles

### P1 — Component Role Classification
**Definition**: Every UI element is classified as either Static (persistent chrome) or Generative (dynamic content). No element exists outside this dichotomy.
**Implementation**: Before rendering, partition elements into S and G. Render S first to establish frame. Then evaluate context and project G into slots. S must never be displaced by G.
**Cross-refs**: P4, P5

### P2 — Contextual Assembly
**Definition**: Gen components are assembled from atomic sub-components based on `C = {t, a, s, d, n}`. The same slot may host structurally different components depending on context.
**Implementation**: For each Gen slot, define `f(C) → Component | null`. Components must be fully parameterized by the context vector — no out-of-band configuration at render time.
**Examples**:
- Now Bar slot: media session → MediaPlayer; active timer → Timer; delivery tracking → DeliveryTracker; empty → render nothing
- Lock widget slot: morning t → weather priority; workout a → health rings priority
**Cross-refs**: P1, P9, P10

### P3 — Semantic Color Mapping
**Definition**: Each functional category receives a dedicated hue used consistently across all components in that category. Color encodes meaning, not decoration.
**Implementation**: Maintain a global semantic registry. All components in a category use the assigned hue for active/accent state. Mapping must be stable across surfaces and sessions.

| Category | Hue | Hex | Usage |
|---|---|---|---|
| Connectivity | Blue | `#4A90D9` | WiFi, Bluetooth, Mobile Data, NFC |
| Accessibility | Green | `#4CAF50` | Accessibility toggles, timer accents |
| AI / Bixby | Purple | `#9C27B0` | Bixby, Galaxy AI |
| Health / Fitness | Pink | `#E91E63` | Health rings, heart rate |
| Battery / Power | Orange | `#FF9800` | Battery, power mode, charging |
| Settings / System | Teal | `#009688` | Settings, media player tint |
| Communication | Coral/Red | `#FF5252` | FAB, missed call |

**Cross-refs**: P5, P10, P12

### P4 — Progressive Density
**Definition**: Information density increases monotonically as the user navigates from ambient to active surfaces. Each successive layer adds, never removes, prior context.
**Implementation**: Density ordering — Lock Screen (D1) < Notification Shade (D2) < QS Expanded (D3) < Full Application (D4). Transitions must be continuous; no abrupt density jumps.

| Layer | Level | Typical Component Count |
|---|---|---|
| Lock Screen | D1 — Ambient | 3–5 |
| Notification Shade | D2 — Glance | 10–15 |
| QS Expanded | D3 — Operational | 30–40 |
| Full Application | D4 — Immersive | 50+ |

**Cross-refs**: P1, P5, P7

### P5 — Glass Hierarchy
**Definition**: Frosted glass treatments apply at varying opacity tiers to communicate z-depth, interactivity, and importance. Higher opacity → more interactive / important.
**Implementation**: Use the glass tier appropriate to interactivity level (G0–G3 — full tier definitions in `DESIGN.md`).

**Tier-to-use mapping**:
| Tier | Used For |
|---|---|
| G0 | Wallpaper overlay, surface scrim |
| G1 | Notification cards, inactive toggles |
| G2 | Active toggles, Now Bar, media player |
| G3 | Dialogs, bottom sheets, focused inputs |

**Cross-refs**: P1, P3, P4, P12

### P6 — Pill Morphology
**Definition**: Pill (radius ≥ 999 / pill) is the dominant container morphology. Squircle for multi-row containers. Circle for icon buttons. Never sharp corners on Gen components.
**Implementation**:
| Shape | Apply to |
|---|---|
| Pill | Now Bar, notification pills, chips, Connected Tab, slide nav, single-row interactive |
| Squircle (26) | Cards, widgets, dialogs, media player, image containers |
| Circle (50%) | QS toggle icons, FAB, page-indicator dots, avatars |
| Rounded Rectangle (18) | Contained buttons, text fields, snackbar action |

**Cross-refs**: P7, P11

### P7 — Grid Quantization
**Definition**: All spatial dimensions quantize to multiples of 8dp (with 4 and 12 as half/1.5× exceptions). Widget sizes follow discrete classes.
**Implementation**: Spacing values ∈ {4, 8, 12, 16, 24, 32, 40, 48, 64}dp. Widget size class ∈ {2×1, 2×2, 4×2, 4×4}. Internal padding ≥ 16dp.
**Cross-refs**: P4, P6, P11

### P8 — Motion as Meaning
**Definition**: Animation curves and durations encode component classification. Static = restrained Basic Path. Generative = expressive Emphasized Path / spring. Motion communicates whether an element is structural or dynamic.
**Implementation**:
| Profile | Curve | Duration | Application |
|---|---|---|---|
| Basic Path | `cubic-bezier(0.22, 0.25, 0, 1)` | 200–300ms | Status bar, nav bar mode switch, app bar title |
| Emphasized Path | `cubic-bezier(0.05, 0.7, 0.1, 1.0)` | 300–500ms | Notification entry/exit, Now Bar morph, widget appearance |
| Spring | stiffness 300, damping 25 | ~400ms settle | Toggle activation, pull-to-refresh, overscroll |
| Density Transition | Emphasized | 400–500ms | D-layer transitions |

**Cross-refs**: P1, P4

### P9 — Notification Stratification
**Definition**: Notifications partition into Live > Other > Silent tiers. Tier assignment determined by priority flags + active state.
**Implementation**: Render in fixed order Live (top) → Other (middle) → Silent (bottom). Each section has a header label.

| Tier | Header | Glass Tier | Text Opacity | Interactive |
|---|---|---|---|---|
| Live | "Live notifications" | G2 | 100% | Yes (buttons, controls) |
| Other | "Other notifications" | G1 | 90% | Limited (expand, dismiss) |
| Silent | "Silent notifications" | G0 | 60% | Minimal (dismiss only) |

**Constraint**: A notification within `<live-section>` must include at least one ACTION.
**Cross-refs**: P2, P4, P5

### P10 — Ambient Reactivity
**Definition**: UI elements passively adapt to ambient conditions — wallpaper palette, time of day, user activity, device orientation. Adaptations are continuous and non-disruptive.
**Implementation**: Extract a 5-color palette from the active wallpaper. Apply to glass tints (P5) and accent fills (where not overridden by P3). Time-of-day shifts color temperature warmer after sunset. Activity changes refresh widget data and Now Bar state. All ambient changes use Basic Path motion (P8) ≥ 500ms.
**Examples**: Blue wallpaper → blue-tinted glass on notifications. Evening → warmer glass. Run start → health widget foregrounded. Plug-in → Now Bar to charging state.
**Cross-refs**: P2, P3, P5, P8

### P11 — Connected Composition
**Definition**: Two or more Gen components can be "connected" — rendered with 0dp inter-component spacing within a shared container — to form compound widgets.
**Implementation**: Connected components have gap 0dp inside a shared container. Container shape per P6. Each sub-component retains internal padding (P7). Shared container glass level = max of children's glass levels.
**Examples**: SmartThings card (header pill + action icon row in shared squircle); Snackbar (text + action button in shared pill); Dialog button pair (Cancel + Apply in shared row).
**Cross-refs**: P5, P6, P7

### P12 — Dual-Mode Rendering
**Definition**: Every component must render in both dark and light modes. Mode switching is **not** color inversion — it is complete material treatment change.
**Implementation**: Define two material treatments per component. Dark = glass-based. Light = opaque-based. Surface bases: dark `#171717`, light `#FCFCFC`. Text: 87/60/38% opacity (primary/secondary/disabled). All semantic colors (P3) have dark and light variants with matched perceived brightness.
(Full mode comparison table is in `DESIGN.md` §7.)
**Cross-refs**: P3, P5, P10

---

## 6. Component Composition Grammar

### Terminal Symbols
```
<status-bar>      ::= TIME NOTIFICATION-PILL? SYSTEM-ICONS
<nav-bar>         ::= GESTURE-BAR | BUTTON-ROW
<app-bar>         ::= BACK-ICON TITLE OVERFLOW-MENU?
<bottom-nav>      ::= TAB-ITEM{4,5}
<notification>    ::= ICON APP-NAME CONTENT TIMESTAMP ACTION*
<now-bar>         ::= MEDIA-STATE | TIMER-STATE | DELIVERY-STATE | CHARGING-STATE
<qs-toggle>       ::= ICON COLOR-BG LABEL?
<widget>          ::= WIDGET-CONTENT SIZE-CLASS
<media-player>    ::= ALBUM-ART TITLE ARTIST PROGRESS CONTROLS
<dialog>          ::= TITLE DESCRIPTION? BUTTON-PAIR
<snackbar>        ::= TEXT-LABEL ACTION-BUTTON
<fab>             ::= ICON
<chip>            ::= LABEL ICON?
<edge-panel>      ::= PANEL-CONTENT PANEL-SIZE
<page-indicator>  ::= DOT{1,5}
<connected-tab>   ::= "+" LABEL?
<keyboard>        ::= KEY-GRID NUMBER-ROW? CHIP-ROW?
```

### Non-Terminal Productions
```
<surface>         ::= <lock-screen> | <notification-shade> | <qs-panel>
                    | <app-surface> | <home-screen>

<lock-screen>     ::= <chrome> <widget-area>? <now-bar>?
<notification-shade> ::= <chrome> <qs-mini> <notification-list>
<qs-panel>        ::= <chrome> <qs-grid> <brightness-slider>? <media-player>? <device-control>?
<app-surface>     ::= <chrome> <app-content> <bottom-nav>?
<home-screen>     ::= <chrome> <widget-grid> <app-icon-grid> <page-indicator>?

<chrome>          ::= <status-bar> <nav-bar>
<widget-area>     ::= <widget>{0,4}
<notification-list> ::= <live-section>? <other-section>? <silent-section>?
<live-section>    ::= HEADER("Live notifications") <notification>{1,}
<other-section>   ::= HEADER("Other notifications") <notification>{1,}
<silent-section>  ::= HEADER("Silent notifications") <notification>{1,}
<qs-mini>         ::= <qs-toggle>{6}
<qs-grid>         ::= <qs-toggle>{6,24}
<widget-grid>     ::= <widget>{0,8}

<compound>        ::= <connected-header> <connected-body> | <snackbar> | <dialog>
<connected-header> ::= ICON TITLE SUBTITLE?
<connected-body>  ::= ICON-BUTTON{1,4} | CONTENT-BLOCK
<button-pair>     ::= FLAT-BUTTON CONTAINED-BUTTON | OUTLINED-BUTTON OUTLINED-BUTTON
<menu>            ::= MENU-ITEM{1,6}
```

### Well-Formedness Constraints
```
C1:  Every <surface> contains exactly one <chrome>.
C2:  <now-bar> appears on at most one surface at a time.
C3:  <notification-list> sections appear in order: live > other > silent.
C4:  <qs-grid> column count fixed at 6; row count 1–4.
C5:  <widget> SIZE-CLASS ∈ {2×1, 2×2, 4×2, 4×4}.
C6:  <button-pair> members must contrast in visual weight.
C7:  <compound> children share single container boundary (gap 0).
C8:  <menu> items ≤ 6 per column; overflow requires second column or scroll.
C9:  <notification> in <live-section> must include ≥ 1 ACTION.
C10: <chrome> renders before any Gen elements on the same surface.
```

### Composition Example
```
<lock-screen>
  <chrome>
    <status-bar> 9:41 [notification-pill:"Spotify"] [wifi, signal-4, battery-85] </status-bar>
    <nav-bar> GESTURE-BAR </nav-bar>
  </chrome>
  <widget-area>
    <widget> Weather(72F, Sunny) 2x1 </widget>
    <widget> HeartRate(72bpm) 2x1 </widget>
  </widget-area>
  <now-bar>
    MEDIA-STATE(album:"Kind of Blue", artist:"Miles Davis", playing:true, tint:teal)
  </now-bar>
</lock-screen>
```

---

## 7. Rendering Pipeline

```
1. RESOLVE context vector C = {t, a, s, d, n}
2. SELECT surface template based on user interaction state
3. RENDER chrome (Static components) into fixed positions
4. EVALUATE Gen slots:
   For each slot in surface template:
     a. APPLY selection function f(C) → component | null
     b. If component != null:
        i.   PARAMETERIZE component with context data
        ii.  APPLY material treatment (P5 + P12)
        iii. APPLY semantic color (P3) if applicable
        iv.  APPLY shape (P6) by component type
        v.   SIZE to grid (P7)
        vi.  QUEUE entry animation (P8)
5. LAYOUT Gen components within slots (P7)
6. APPLY ambient reactivity adjustments (P10)
7. EXECUTE queued animations
```

---

## 8. Interaction Patterns (runtime triggers)

| Pattern | Gesture | Response |
|---|---|---|
| Toggle activation | Single tap | Spring animation (P8) + light haptic |
| Toggle settings | Long press (300ms) | Navigate to full settings |
| Notification expand | Tap | Expand card + reveal actions (Emphasized Path) |
| Notification dismiss | Horizontal swipe | Slide out + fade (200ms Basic Path) |
| Now Bar expand | Tap | Density Transition to full media/timer |
| QS pull-down | Vertical swipe from status bar | D1 → D2 (spring) |
| QS expand | Second vertical swipe | D2 → D3 (Density Transition) |
| Edge panel reveal | Swipe from screen edge | Slide-in (Emphasized Path 300ms) |
| Widget resize | Long press + drag | Snap to grid size class (P7) |

---

## 9. Evaluation Framework

### Compliance Rubric (per principle, per component)
| Score | Label | Criteria |
|---|---|---|
| 0 | Non-compliant | Principle violated or unaddressed |
| 1 | Partial | Implemented with significant gaps |
| 2 | Compliant | Fully implemented with minor deviations |
| 3 | Exemplary | Fully implemented; reference example |

### Principle Weights
| Principle | Weight |
|---|---|
| P1 Classification | 1.0 |
| P2 Contextual Assembly | 1.5 |
| P3 Semantic Color | 1.0 |
| P4 Progressive Density | 1.0 |
| P5 Glass Hierarchy | 1.5 |
| P6 Pill Morphology | 0.5 |
| P7 Grid Quantization | 1.0 |
| P8 Motion as Meaning | 1.0 |
| P9 Notification Stratification | 0.5 |
| P10 Ambient Reactivity | 1.0 |
| P11 Connected Composition | 0.5 |
| P12 Dual-Mode Rendering | 1.5 |
| **Total** | **12.0** (max weighted score: 36) |

### Compliance Thresholds
| Range | Rating |
|---|---|
| 30.0–36.0 | Fully Compliant |
| 24.0–29.9 | Substantially Compliant |
| 18.0–23.9 | Partially Compliant |
| 12.0–17.9 | Minimally Compliant |
| 0.0–11.9 | Non-Compliant |

### Surface Evaluation Procedure
1. Inventory all components on the surface.
2. Classify each as S or G (P1).
3. Validate composition against §6 grammar + constraints.
4. Score each Gen component via the matrix.
5. Assess motion profiles (P8) for entry/exit/state-change.
6. Verify dark + light rendering (P12).
7. Verify behavior across ≥ 3 wallpaper palettes (P10).
8. Walk D1→D4 and verify progressive density (P4).
9. Aggregate weighted score.

### Quick Checklist
| # | Check | Principle |
|---|---|---|
| 1 | All components classified S or G | P1 |
| 2 | Gen components absent when context empty | P2 |
| 3 | Functional categories use consistent colors | P3 |
| 4 | Deeper layers contain strictly more info | P4 |
| 5 | Glass opacity correlates with interactivity | P5 |
| 6 | Pills for single-row, squircles for multi-row | P6 |
| 7 | All spacing multiple of 8 (or 4/12 exception) | P7 |
| 8 | S uses Basic Path; G uses Emphasized/Spring | P8 |
| 9 | Notifications ordered Live > Other > Silent | P9 |
| 10 | Glass tints adapt to wallpaper | P10 |
| 11 | Connected components share container, gap 0 | P11 |
| 12 | Dark/light use distinct material treatments | P12 |

---

## 10. Cross-Reference Matrix

|  | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 | P10 | P11 | P12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **P1** | -- | . | . | X | X | . | . | X | . | . | . | . |
| **P2** | X | -- | . | . | . | . | . | . | X | X | . | . |
| **P3** | . | . | -- | . | X | . | . | . | . | X | . | X |
| **P4** | X | . | . | -- | X | . | X | . | . | . | . | . |
| **P5** | X | . | X | X | -- | . | . | . | . | . | X | X |
| **P6** | . | . | . | . | . | -- | X | . | . | . | X | . |
| **P7** | . | . | . | X | . | X | -- | . | . | . | X | . |
| **P8** | X | . | . | X | . | . | . | -- | . | . | . | . |
| **P9** | . | X | . | X | X | . | . | . | -- | . | . | . |
| **P10** | . | X | X | . | X | . | . | X | . | -- | . | . |
| **P11** | . | . | . | . | X | X | X | . | . | . | -- | . |
| **P12** | . | . | X | . | X | . | . | . | . | X | . | -- |

---

## 11. References

1. Samsung Electronics. "One UI 8.5 Design Guidelines." Samsung Developers, 2025–2026.
2. Samsung Electronics. "Quick Settings Design Kit for One UI 8.5." Figma Community, 2025.
3. Google. "Material Design 3 Specification." material.io, 2024.
4. Google. "Android Accessibility Guidelines." developer.android.com, 2025.
5. Oulasvirta, A., et al. "Combinatorial Optimization of Graphical User Interface Designs." *Proc. IEEE*, 108(3), 2020.
6. Swearngin, A. and Li, Y. "Modeling Mobile Interface Tappability Using Crowdsourcing and Deep Learning." *CHI 2019*.
7. Dayama, N. R., et al. "Grounding of Graphic Design Attributes." *CHI 2021*.
8. Apple Inc. "Human Interface Guidelines: Materials." developer.apple.com, 2025.
9. Deka, B., et al. "Rico: A Mobile App Dataset for Building Data-Driven Design Applications." *UIST 2017*.
10. Li, G., et al. "Learning to Denoise Raw Mobile UI Layouts for Improving Datasets at Scale." *CHI 2022*.
