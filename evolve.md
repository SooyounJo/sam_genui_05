# EVOLUTION MEMORY — Design Refinement Lessons

**Layer**: EVOLUTION MEMORY
**Lives here**: Lessons learned from refinement only — violated constraint → applied fix → reusable prevention rule.
**Does NOT live here**: Base specs. For factual values see `figma-refs/extracted.md`. For component definitions see `DESIGN.md`. For composition rules see `ORCHESTRATION.md`. For runtime decision logic see `GENUI-PRINCIPLES.md`.

---

## Format

```
### E{number}: {title}
- **Type**: spacing | hierarchy | density | alignment | sizing | readability | consistency | semantic | interaction | touch-target | radius | grid
- **Severity**: high | medium | low
- **Scenario**: {which screen/component type}
- **Issue**: {what was wrong}
- **Fix**: {what was changed}
- **Constraint**: {the reusable rule to prevent this in future generation}
- **Date**: {YYYY-MM-DD}
```

---

## Entries

### E1: Lock Shortcut below minimum touch target
- **Type**: touch-target
- **Severity**: high
- **Scenario**: Lock screen Shortcut chip
- **Issue**: Figma source measured 47×47dp — below the 48dp minimum touch target required by One UI accessibility guidelines.
- **Fix**: Promoted size to 48×48dp during normalization.
- **Constraint**: Any tappable element must reach ≥ 48dp visual or hit area; flag and snap any 44–47dp interactive control.
- **Date**: 2026-04-15

### E2: Now Bar action buttons under touch target
- **Type**: touch-target
- **Severity**: high
- **Scenario**: NowBar/Navigation "End Trip" (28dp) and NowBar/Activity "Pause"/"Finish" (47dp)
- **Issue**: Action buttons inside Now Bar fell below 48dp touch.
- **Fix**: Expanded hit area via padding to 48dp; visual may remain smaller.
- **Constraint**: Inside glass NowBar, wrap action buttons in an inner DialogBlurred (r=28) surface AND ensure each button's hit area ≥ 48dp via padding.
- **Date**: 2026-04-15

### E3: Sub-pixel border rendering inconsistency
- **Type**: consistency
- **Severity**: medium
- **Scenario**: Lock shortcut chip border (`0.25px rgba(55,55,55,0.3)`)
- **Issue**: 0.25px borders render inconsistently across pixel ratios (sometimes invisible, sometimes 1px).
- **Fix**: Promoted to 0.5px during normalization.
- **Constraint**: Never emit borders below 0.5px. Snap any sub-0.5 stroke up to 0.5px.
- **Date**: 2026-04-15

### E4: Off-grid panel padding
- **Type**: spacing
- **Severity**: medium
- **Scenario**: Quick Settings panel side padding (raw px:22)
- **Issue**: 22px conflicts with the 24dp rhythm used on home/app grids; creates visual mismatch when panels overlay grids.
- **Fix**: Snapped to 24dp.
- **Constraint**: Spacing values must come from {4,8,12,16,20,24,28,32,40,48,56,64}. Snap raw 22→24, raw 17→16, raw 18→16 silently when within ±3dp.
- **Date**: 2026-04-15

### E5: Magic-number radii on de-facto pills
- **Type**: radius
- **Severity**: medium
- **Scenario**: Now Bar (radius 53 on height 64) and Lock Shortcut chip (radius 61 on size 47–48)
- **Issue**: Radius values that are nearly half the height drift across device scales and produce subtly non-pill silhouettes.
- **Fix**: Replaced with `pill` (9999) token.
- **Constraint**: When a radius ≥ height/2, use the `pill` token, not a numeric radius. Eliminates device-scale drift.
- **Date**: 2026-04-15

### E6: Sub-pixel divider thickness
- **Type**: consistency
- **Severity**: low
- **Scenario**: Stack notification separator (raw 332.963 × 3.659 arc)
- **Issue**: Sub-pixel widths/thicknesses produce inconsistent rendering.
- **Fix**: Snapped width 332.963→336 and thickness 3.659→4.
- **Constraint**: All separators round to integer dp on both axes; thickness ≥ 1.
- **Date**: 2026-04-15

<!-- New entries appended here by the refinement system -->
