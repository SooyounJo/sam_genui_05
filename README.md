# Samsung One UI · GenUI

> A generative UI system for One UI 8.5: type a scenario in plain language,
> get a valid, themed, on-system Samsung screen rendered on a phone frame.

The whole loop runs through a 5-stage LLM pipeline with a parallel
content-enrichment side-call, an auto-iterating self-improvement engine,
and a theme system that swaps CSS variables in real time across windows.

### Framework overview

| Area | What it is |
|------|------------|
| **Server** | `server.js` — HTTP, SSE pipeline, embeddings, `/api/themes`, improvement engine routes |
| **Pipeline** | `pipeline.js` — interpret → select (RAG) + parallel content bag → compose → validate → explain |
| **Renderer** | `app/scenes.js` (orchestration) + `app/surface-layout.js` + `app/templates.js` + `app/atomics.js` |
| **GenUI shell** | `genui.html` — scenario UI, canvas, theme picker (`:root` theme apply) |
| **Theme editor** | `customize.html` — scoped live preview (`#preview-theme-scope`); Save posts to `/api/themes` |
| **Knowledge** | `figma-refs/*.json` — component registry, embeddings, themes, scenarios, rules |
| **Self-improve** | `improvement_engine.js` + `/improve` — test suite, rule trials, `evolve.md` |

---

## Diagram legend

All diagrams below share the same shape + color language, modeled on the
FigJam *Diagram Basics* template. Stay oriented by mapping shape →
role.

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'fontFamily':'ui-sans-serif, system-ui, sans-serif',
  'fontSize':'13px',
  'lineColor':'#7C6F9C',
  'background':'#F8F5FF'
}}}%%
flowchart LR
  s([Start / End]):::start
  p[Process]:::proc
  d{Decision}:::dec
  i[/Input · IO/]:::io
  db[(Data store)]:::data
  ai{{LLM call}}:::llm
  drop([Drop / Reject]):::drop

  classDef start fill:#F3E5F5,stroke:#8E24AA,color:#212121
  classDef proc  fill:#FAFAFA,stroke:#90A4AE,color:#212121
  classDef dec   fill:#FFF8E1,stroke:#F9A825,color:#212121
  classDef io    fill:#E3F2FD,stroke:#1E88E5,color:#212121
  classDef data  fill:#E8F5E9,stroke:#43A047,color:#212121
  classDef llm   fill:#EDE7F6,stroke:#7E57C2,color:#212121
  classDef drop  fill:#FCE4EC,stroke:#D81B60,color:#212121
```

| Shape | Color | Role |
|---|---|---|
| Pill `( )` | lavender | Start / End — terminal nodes |
| Rectangle `[ ]` | cream | Process — deterministic step |
| Diamond `{ }` | pale yellow | Decision — branch with Yes/No |
| Parallelogram `[/ /]` | pale blue | Input / IO — data crossing a boundary |
| Cylinder `[( )]` | pale green | Data store — registry, embeddings, themes |
| Hexagon `{{ }}` | pale violet | LLM call — one OpenAI request |
| Pill (warm) | pale pink | Drop / Reject — duplicate or invalid |

---

## At a glance

End-to-end request flow. Every hexagon is one OpenAI call.

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'fontFamily':'ui-sans-serif, system-ui, sans-serif',
  'fontSize':'13px',
  'lineColor':'#7C6F9C'
}}}%%
flowchart TD
  user([User · scenario text]):::start
  stream[/POST /api/pipeline/full/stream · SSE/]:::io
  user --> stream

  s1{{1 + 2 · Interpret + Normalize<br/>gpt-5.4-mini}}:::llm
  stream --> s1

  fork{Promise.all<br/>fan-out}:::dec
  s1 --> fork

  s3{{3 · Select<br/>gpt-5.4 · RAG top-30}}:::llm
  s35{{3.5 · Content Bag<br/>gpt-5.4-mini · parallel}}:::llm
  fork --> s3
  fork --> s35

  swap[applyContentSwap<br/>fills empty / dup slots]:::proc
  s3 --> swap
  s35 --> swap

  s4{{4 · Compose Layout<br/>gpt-5.4}}:::llm
  swap --> s4

  s5[5 · Validate<br/>plan + layout rollup]:::proc
  s4 --> s5

  fast{fastMode?}:::dec
  s5 --> fast
  s7{{7 · Explain<br/>gpt-5.4-mini}}:::llm
  fast -- "no" --> s7
  fast -- "yes (skip)" --> render

  render[Renderer<br/>scenes.js + surface-layout.js]:::proc
  s7 --> render
  canvas([Phone frame · Galaxy S26]):::start
  render --> canvas

  classDef start fill:#F3E5F5,stroke:#8E24AA,color:#212121
  classDef proc  fill:#FAFAFA,stroke:#90A4AE,color:#212121
  classDef dec   fill:#FFF8E1,stroke:#F9A825,color:#212121
  classDef io    fill:#E3F2FD,stroke:#1E88E5,color:#212121
  classDef llm   fill:#EDE7F6,stroke:#7E57C2,color:#212121
```

Stages 3 and 3.5 fire **in parallel**, so the content bag adds zero
critical-path latency. The bag (~5s) finishes well inside the
selector's window (~11s), and the swap pass uses its output to fill
empty or duplicated slots before composition.

---

## The 5-stage pipeline

| # | Stage | Model | Input | Output | Why it exists |
|---|-------|-------|-------|--------|---------------|
| 1+2 | `runInterpretAndNormalize` | mini | scenario text | `interpretation` + `planningPacket` (uiState, tasks, slot_requirements) | Strip prose into structured intent so the selector has something machine-readable |
| 3 | `runSelect` | full | planningPacket + RAG shortlist | `plan.requiredComponents[]` (componentType, role, slot, content) | Pick concrete components from a vocabulary of 92 (filtered to 52 renderable, top-30 by embedding) |
| 3.5 | `runContentBag` | mini | scenario + uiState hints | unique-label fact bundle keyed by component type (weather, calendar, reminder × 3, message × 3, eta, …) | Material to fill empty / duplicated slots — runs in parallel with stage 3 |
| 4 | `runComposeLayout` | full | plan | `layoutPlan.groups[].children[]` (vertical-stack / horizontal-stack / grid) | Spatial reasoning + reference-layout matching + token alignment |
| 5 | `validatePlan` + `validateLayout` | — | plan + layoutPlan | `violations[]` rolled up by severity | 17+ rules: vocabulary, ordering, overflow, attention budget, role coherence |
| 7 | `runExplain` | mini | everything | `{ why_this_ui, what_was_prioritized, what_was_removed, what_should_be_fixed }` | Human-readable rationale for the panel beside the canvas |

**Per-stage routing** keeps cost down — heavy reasoning stays on `gpt-5.4`,
mechanical extraction lives on `gpt-5.4-mini`. Configurable in
`.env` (`OPENAI_MODEL`, `OPENAI_MODEL_FAST`, `OPENAI_MODEL_COMPOSE`,
`OPENAI_MODEL_EXPLAIN`, `OPENAI_MODEL_CONTENT_BAG`).

### Request flow (with parallelization)

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'fontFamily':'ui-sans-serif, system-ui, sans-serif',
  'fontSize':'13px',
  'primaryColor':'#EDE7F6',
  'primaryBorderColor':'#7E57C2',
  'primaryTextColor':'#212121',
  'lineColor':'#7C6F9C',
  'actorBkg':'#F3E5F5',
  'actorBorder':'#8E24AA',
  'actorTextColor':'#212121',
  'noteBkgColor':'#FFF8E1',
  'noteBorderColor':'#F9A825',
  'noteTextColor':'#212121'
}}}%%
sequenceDiagram
  autonumber
  participant UI as Browser (genui.html)
  participant Srv as server.js
  participant Pipe as pipeline.js
  participant LLM as OpenAI

  UI->>Srv: POST /api/pipeline/full/stream<br/>{scenario, viewport, fastMode}
  Srv->>Pipe: runInterpretAndNormalize
  Pipe->>LLM: gpt-5.4-mini (merged 1+2)
  LLM-->>Pipe: { intent, uiState, slotRequirements }
  Pipe-->>Srv: step_done · interpret
  Srv-->>UI: SSE event

  par stage 3
    Srv->>Pipe: runSelect (with RAG top-30)
    Pipe->>LLM: gpt-5.4 (vocabulary + content)
    LLM-->>Pipe: requiredComponents[]
  and stage 3.5 (parallel)
    Srv->>Pipe: runContentBag
    Pipe->>LLM: gpt-5.4-mini (varied facts)
    LLM-->>Pipe: { weather, calendar[3], reminder[3], … }
  end

  Note over Pipe: applyContentSwap<br/>fill empty / dup slots from bag
  Pipe-->>Srv: step_done · select
  Srv-->>UI: SSE event

  Srv->>Pipe: runComposeLayout
  Pipe->>LLM: gpt-5.4
  LLM-->>Pipe: layoutPlan.groups
  Pipe-->>Srv: step_done · compose
  Srv-->>UI: SSE event

  Srv->>Pipe: validate + rollup
  Pipe-->>Srv: violations
  Srv-->>UI: step_done · validate

  alt fastMode = false
    Srv->>Pipe: runExplain
    Pipe->>LLM: gpt-5.4-mini
    LLM-->>Pipe: { why_this_ui, … }
    Srv-->>UI: step_done · explain
  end

  Srv-->>UI: done · final bundle
  UI->>UI: renderPipelineResponse → DOM
```

---

## RAG vocabulary funnel

The component registry has 92 entries. Pasting all of them into every
selector prompt would be wasteful and pollute the LLM's choice space
with components that don't even have a renderer.

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'fontFamily':'ui-sans-serif, system-ui, sans-serif',
  'fontSize':'13px',
  'lineColor':'#7C6F9C'
}}}%%
flowchart LR
  reg[(Registry · 92 components)]:::data
  flt[Filter to renderable<br/>RENDERABLE_COMPONENT_IDS]:::proc
  rendered[(52 renderable IDs)]:::data
  embed[/Cosine top-K<br/>vs scenario embedding/]:::io
  top[(Top 30)]:::data
  mand[+ surface-mandatory<br/>status-bar · header]:::proc
  shortlist[(31–32 final shortlist)]:::data
  sel{{Stage 3 · Selector prompt}}:::llm

  reg --> flt --> rendered --> embed --> top --> mand --> shortlist --> sel

  classDef proc  fill:#FAFAFA,stroke:#90A4AE,color:#212121
  classDef io    fill:#E3F2FD,stroke:#1E88E5,color:#212121
  classDef data  fill:#E8F5E9,stroke:#43A047,color:#212121
  classDef llm   fill:#EDE7F6,stroke:#7E57C2,color:#212121
```

The 40 components dropped by the renderable filter (e.g.
`card.subheading`, `card.menu-item-body`, `dialog.browser-top-bar`)
exist in the registry but the renderer has no template for them — they
would fall through to `(no template registered)` placeholder cards and
trip multiple validators. Filtering at the embedding stage makes the
selector physically incapable of picking a non-renderable id.

**Source of truth for the renderable set** — four maps that must stay
in sync:

| Map | File | Role |
|---|---|---|
| `templates` | `app/templates.js` | 28 editor-primitive templates (`card`, `dialog`, `bottomnav`, …) |
| `PIPELINE_FALLBACK_TEMPLATES` | `app/templates.js` | 10 card-style fallback renders (`weather_glance_card`, `eta_card`, …) |
| `PIPELINE_CHROME_ATOMIC_ROLE` | `app/scenes.js` | 6 chrome IDs → atomic roles (status-bar, header, gesture-bar) |
| `PIPELINE_BODY_ATOMIC_ROLE` | `app/scenes.js` | 19 body IDs → atomic roles (focus-block, now-bar, action-row) |

Their union (52 IDs) is `RENDERABLE_COMPONENT_IDS` in `pipeline.js`.

---

## Diversity rules + 4-tier dedup ladder

The selector LLM, left alone, will happily emit "STEP 2 OF 7 · Sauté
tofu …" three times in a row. We catch that at four levels — each
tier loosens the matching criterion until even cross-componentType
duplicates get pruned.

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'fontFamily':'ui-sans-serif, system-ui, sans-serif',
  'fontSize':'13px',
  'lineColor':'#7C6F9C'
}}}%%
flowchart TD
  raw[/Raw LLM picks/]:::io
  raw --> t1{PRIMARY<br/>componentType + normalized label}:::dec
  t1 -- match --> drop1([drop]):::drop
  t1 -- pass --> t2{SECONDARY<br/>+ value}:::dec
  t2 -- match --> drop2([drop]):::drop
  t2 -- pass --> t3{TERTIARY<br/>alphanumeric-only}:::dec
  t3 -- match --> drop3([drop]):::drop
  t3 -- pass --> t4{QUATERNARY<br/>cross-type label / value}:::dec
  t4 -- match --> drop4([drop]):::drop
  t4 -- pass --> cap{TYPE_CAP<br/>≤ 3 of any componentType}:::dec
  cap -- over --> drop5([drop]):::drop
  cap -- under --> survive([survive · enter swap]):::pass

  classDef io    fill:#E3F2FD,stroke:#1E88E5,color:#212121
  classDef dec   fill:#FFF8E1,stroke:#F9A825,color:#212121
  classDef drop  fill:#FCE4EC,stroke:#D81B60,color:#212121
  classDef pass  fill:#E8F5E9,stroke:#43A047,color:#212121
```

Most duplicates die at PRIMARY. The cross-type tier is the safety
net for `btn-contained "Coupang cart"` + `action_chip_row "Coupang
cart"` style collisions where the label is identical but the
componentType differs.

The **selector prompt** also bakes in upstream diversity rules: max 2
of the same componentType, every label must be unique, prefer variety,
and `input_summary_card` is reserved for form summaries (not a generic
content card).

---

## Per-slot content resolution

A subtle renderer trap: the old `contentByType` Map keyed by
componentType only — so when the plan has 3 distinct
`input_summary_card` entries with different content (e.g. "Cooking
session", "Recipe", "Step 3 of 7"), `Map.set` overwrote each previous
entry, and all 3 layout children rendered with the **last** entry's
content. The screen looked like 3 identical step cards.

The fix is a 3-tier resolver:

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'fontFamily':'ui-sans-serif, system-ui, sans-serif',
  'fontSize':'13px',
  'lineColor':'#7C6F9C'
}}}%%
flowchart LR
  child[/Layout child<br/>{componentId, slot}/]:::io
  child --> r1{contentBySlot[slot]?}:::dec
  r1 -- hit --> done([use this content]):::pass
  r1 -- miss --> r2{contentByTypeQueue[type].shift?}:::dec
  r2 -- hit --> done
  r2 -- miss --> r3[contentByType<br/>legacy last-wins]:::proc
  r3 --> done

  classDef io    fill:#E3F2FD,stroke:#1E88E5,color:#212121
  classDef dec   fill:#FFF8E1,stroke:#F9A825,color:#212121
  classDef proc  fill:#FAFAFA,stroke:#90A4AE,color:#212121
  classDef pass  fill:#E8F5E9,stroke:#43A047,color:#212121
```

Distinct slots get their own content; identical-type-different-content
plan entries are handed out in plan order via the queue. Last-wins
remains as a final fallback so missing slots still render *something*
rather than crash.

---

## Layout composer post-fixes

The composer LLM produces a layout, then a deterministic chain of
post-processors adjusts it before validation:

| Post-fix | What it does |
|---|---|
| `chrome-role correction` | LLM sometimes tags content components as `role: "chrome"` — demoted to subject/state/context |
| `same-label dedup` | 4-tier ladder above |
| `type-cap` | Hard ceiling of 3 per componentType |
| `mandatory injection` | Surface-required IDs (status-bar, header for `app`) added if the LLM didn't pick them |
| `context-aware injection` | Morning scenarios → calendar, etc. |
| `role-based child reorder` | Each group sorted subject → state → context → action → feedback |
| `auto-grid (tile whitelist)` | If a group has 3+ same-type children AND the type is in `GRID_FRIENDLY_IDS` (weather / qs-toggle / widget-small / shortcut / buttons), promote container → 2-col grid. Text-heavy cards stay vertical-stack. |
| `composer backfill` | If composer dropped plan components, append them to the appropriate group |
| `chrome migration` | Move non-chrome components out of chrome groups |

**Chrome exemption** in the validators — `validateLayoutOverflow`
skips width / visibleChildren checks for any child whose
`role === 'chrome'` or whose parent group is `role === 'chrome'`.
Chrome is full-width by design and doesn't compete for the user's
attention budget; flagging it was a false positive that produced 1–2
noise violations every run.

---

## Theme system

Presets live in **`figma-refs/themes.json`** and are served by **`GET /api/themes`** / **`POST /api/themes/active`**. Built-in ids today include **default**, **flat**, **gradient**, **glass**, **grain**, and **neon**, plus user **custom** themes saved from the editor.

### Two apply paths (this changed vs older README drafts)

The main app and the customizer intentionally apply tokens differently:

| Surface | Mechanism | Why |
|---------|-----------|-----|
| **`genui.html`** | `<style id="theme-vars">` injects **all** vars as `:root { … }` (`applyVarsToRoot`) | Top bar, sidebar, and phone canvas should share one coherent preset. |
| **`customize.html`** | **`document.documentElement`** gets **`--oneui-theme-style`** and **`--oneui-chroma`** only; **everything else** (`--page-bg`, `--text-*`, `--surface-*`, card tokens, …) goes on **`#preview-theme-scope`** around the preview grid (`applyThemeVars` / `_writeVar`) | Left editor chrome stays readable; neon/dark presets must not collapse contrast on the inspector. |

The renderer reads **`--oneui-theme-style`** from `:root` (`surface-layout.js` → `_themeSurfaceStyleRoot()`). **`_G()`** builds card shells: **`flat`** and **`neon`** use one matte **`var(--surface-bg)`** layer; **`glass`** keeps overlay + blur; **`base`** uses a single tokenized surface stack (see code for grain/other styles).

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'fontFamily':'ui-sans-serif, system-ui, sans-serif',
  'fontSize':'13px',
  'lineColor':'#7C6F9C'
}}}%%
flowchart TD
  themes[(themes.json + custom)]:::data
  api[/GET·POST /api/themes<br/>POST /api/themes/active/]:::io
  customize[Customizer /customize]:::proc
  scope["#preview-theme-scope<br/>most CSS vars"]:::proc
  rootDoc["documentElement<br/>--oneui-theme-style · --oneui-chroma"]:::proc
  genui[GenUI genui.html]:::proc
  rootStyle["#theme-vars :root<br/>full preset"]:::proc
  vars[(Shared token names<br/>--surface-bg · --text-primary · …)]:::data
  consumer[Atomic cards<br/>surface-layout.js]:::proc
  bc[/BroadcastChannel oneui-themes/]:::io
  picker[Topbar Theme picker]:::proc
  canvas([Phone canvas]):::start

  themes --> api
  api --> customize
  customize --> scope
  customize --> rootDoc
  customize -- Save / activate --> api
  customize -. theme-saved · theme-active-changed .-> bc
  bc -. sync .-> picker
  api --> genui
  genui --> rootStyle
  rootStyle --> vars
  scope --> vars
  rootDoc -. style flag .-> consumer
  vars --> consumer --> canvas
  picker --> genui

  classDef start fill:#F3E5F5,stroke:#8E24AA,color:#212121
  classDef proc  fill:#FAFAFA,stroke:#90A4AE,color:#212121
  classDef io    fill:#E3F2FD,stroke:#1E88E5,color:#212121
  classDef data  fill:#E8F5E9,stroke:#43A047,color:#212121
```

**Live preview** — In the customizer, edits call `_writeVar`; values go to the selected preview cell **or** to `#preview-theme-scope` (and document-only keys to `:root`). The preview grid re-renders so atoms pick up new vars. **Save** persists via **`POST /api/themes`** and broadcasts **`theme-active-changed`** so **`genui.html`** refreshes its theme list / active preset without a manual reload.

Theme transitions across GenUI chrome (where implemented in CSS) animate over ~280ms **`cubic-bezier(0.2, 0, 0, 1)`** for color / background / border / shadow — non-layout properties only. **`prefers-reduced-motion`** skips animation where wired.

---

## Self-improving loop

20 test scenarios (15 train + 5 holdout) live in
`figma-refs/test_scenarios.json`. The improvement engine runs the
suite, asks an LLM to extract patterns from the violations, trials a
candidate rule against the scenarios, and persists the rule only if
holdout violations actually drop.

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'fontFamily':'ui-sans-serif, system-ui, sans-serif',
  'fontSize':'13px',
  'lineColor':'#7C6F9C'
}}}%%
flowchart LR
  suite[(Test suite<br/>20 scenarios)]:::data
  run[Run pipeline<br/>per scenario]:::proc
  agg[Aggregate violations<br/>by ruleId × scenario]:::proc
  ext{{Pattern extraction<br/>LLM analyzes failure clusters}}:::llm
  cand[/Candidate rule/]:::io
  trial[Trial<br/>re-run suite WITH the rule]:::proc
  delta{Holdout violations<br/>improved?}:::dec
  persist[(Persist to evolve.md<br/>+ rehydrate at boot)]:::data
  reject([Reject]):::drop

  suite --> run --> agg --> ext --> cand --> trial --> delta
  delta -- "yes" --> persist
  delta -- "no"  --> reject
  persist -. "feeds future runs" .-> suite

  classDef proc  fill:#FAFAFA,stroke:#90A4AE,color:#212121
  classDef dec   fill:#FFF8E1,stroke:#F9A825,color:#212121
  classDef io    fill:#E3F2FD,stroke:#1E88E5,color:#212121
  classDef data  fill:#E8F5E9,stroke:#43A047,color:#212121
  classDef llm   fill:#EDE7F6,stroke:#7E57C2,color:#212121
  classDef drop  fill:#FCE4EC,stroke:#D81B60,color:#212121
```

Boot output shows `Improve test-suite 20 scenarios · N learned rules
rehydrated`. Cycle history snapshots are persisted under
`data/improvement_history/`. Dashboard at `/improve`.

---

## API surface

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/pipeline/full` | POST | Single-shot, returns full bundle |
| `/api/pipeline/full/stream` | POST | SSE — emits `step_started` / `step_done` per stage (used by the UI for progressive render) |
| `/api/pipeline/plan` | POST | Stages 1–3 only |
| `/api/pipeline/compose` | POST | Stages 1–4 |
| `/api/themes` | GET / POST | List themes / save a custom theme |
| `/api/themes/active` | POST | Set the active theme id |
| `/api/improve/test-suite` | GET | List the 20 scenarios |
| `/api/improve/extract` | POST | Run pattern extraction on current violations |
| `/api/improve/trial` | POST | Trial a candidate rule on the suite |
| `/api/improve/cycle` | POST | Full cycle (extract → trial → persist) |
| `/api/agent/health` | GET | Server health + model name |

---

## File map

| Layer | File | Role |
|---|---|---|
| **Server** | `server.js` | HTTP, routing, OpenAI calls, per-stage model routing, embeddings, theme + improve endpoints |
| | `pipeline.js` | The 5 stages, RAG shortlist, content bag, dedup ladder, type cap, post-fixes, validators |
| | `layout_composer.js` | `validateLayoutOverflow` + `validateContextComponentMatch` (chrome-exempt width / visibleChildren checks) |
| | `schema_normalizer.js` | Defensive schema reconciliation (LLM emits camel↔snake variants) |
| | `improvement_engine.js` | Test runner + pattern extractor + trial harness + persist |
| | `generator.js` | Local-mode keyword matcher (legacy fallback) |
| **Client (UI shell)** | `genui.html` | Sidebar tabs (Generate / Design / Refine / Wallpaper / Motion), topbar (Theme / Light / Device / Clear), canvas frame |
| | `customize.html` | Theme editor — scoped preview (`#preview-theme-scope`), Save / Discard, BroadcastChannel |
| | `improve.html` | Self-improvement cycle dashboard |
| | `index.html` | Project landing — links to genui / customize / improve / preview |
| **Client (renderer)** | `app/scenes.js` | `renderPipelineResponse` orchestrator, per-slot content resolver, focus-block / now-bar / action-row adapters, kind parsers |
| | `app/surface-layout.js` | Atomic shapes + `_G()` surfaces · now-bar · focus-block · notifications · QS · embeds `GalaxyAtomics` |
| | `app/atomics.js` | Samsung-shaped primitives (Clock, WeatherDate, toggles, …) consumed by surface-layout |
| | `app/templates.js` | Editor-primitive templates + `PIPELINE_FALLBACK_TEMPLATES` |
| | `app/agent.js` | Path-A pipeline client (SSE consumer) + auto-iterate loop |
| | `app/canvas.js` | `clearCanvas` + DesignDoc reset |
| | `app/settings.js` | Light/Dark canvas toggle, applyColor walker |
| **Knowledge base** | `figma-refs/component_registry.json` | 92 component specs (variants, layout_spec, allowed_contexts) |
| | `figma-refs/component_embeddings.json` | 1536-dim embeddings for RAG (text-embedding-3-small) |
| | `figma-refs/themes.json` | Theme presets + `_active` id |
| | `figma-refs/test_scenarios.json` | 20 scenarios for the improvement engine |
| | `figma-refs/generator_memory.json` | Mandatory components per surface, layout reference orders |
| | `figma-refs/design_rules.json` | Token families |
| | `DESIGN.md` / `GENUI-PRINCIPLES.md` / `ORCHESTRATION.md` | Knowledge base for `buildPromptContext` to slice into prompts |
| | `evolve.md` | Persisted learned constraints from the self-improvement engine |
| **Build** | `scripts/build_component_embeddings.js` | Regenerates the RAG corpus from `component_registry.json` |
| **State** | `data/improvement_history/*.json` | Snapshots of past improvement cycles |

---

## Local dev

```bash
# 1. Set your key + per-stage model routing
echo 'OPENAI_API_KEY=sk-...'              >  .env
echo 'PIPELINE_RAG=on'                    >> .env
echo 'OPENAI_MODEL=gpt-5.4'               >> .env
echo 'OPENAI_MODEL_FAST=gpt-5.4'          >> .env
echo 'OPENAI_MODEL_COMPOSE=gpt-5.4'       >> .env
echo 'OPENAI_MODEL_EXPLAIN=gpt-5.4-mini'  >> .env
echo 'OPENAI_MODEL_CONTENT_BAG=gpt-5.4-mini' >> .env

# 2. Run
yarn dev
# → http://127.0.0.1:3000  (다른 앱이 3000을 쓰면 .env에 PORT=3001 등으로 변경)
```

Boot banner reflects model routing, RAG status, suite size, and how
many learned rules were rehydrated:

```
✓ Running on  http://127.0.0.1:3000  (loopback-only)
✓ Model       gpt-5.4   (select)
✓ Model EXPL  gpt-5.4-mini  (explain)
✓ Model BAG   gpt-5.4-mini  (stage 3.5 content bag, parallel)
✓ Stage 3 RAG ON  (top-30 from 92, +~400ms/call)
✓ Improve     test-suite 20 scenarios · 0 learned rules rehydrated → POST /api/improve/cycle
✓ Limits      body<=1024KB  llm<=4 concurrent / 60 per min
```

---

## Topbar UX

```
┌────────────────────────────────────────────────────────────────────┐
│ ⌂  SAMSUNG GenUI    [Theme ▾ ✎] [Light]   [📱 Galaxy S26 ▾]  [Clear] │
└────────────────────────────────────────────────────────────────────┘
```

Grouped left → right by purpose: **Look** (theme + canvas mode) →
**Device** → **Action**. Theme picker lives in the topbar (not the
Generate panel) because it's a global preference, not a per-generate
option. The ✎ icon opens `/customize` in a new window with
BroadcastChannel sync.

---

## One UI design tokens (reference)

This is still a One UI 8.5 design system at heart — the generative
pipeline produces UIs that respect these tokens.

### Color
| Token | Light | Dark | Use |
|---|---|---|---|
| Primary | `#0381FE` | `#0381FE` | FAB, sliders, accent |
| Primary Dark | `#0072DE` | `#3E91FF` | Contained buttons |
| Activated | `#3E91FF` | `#3E91FF` | Checkboxes, toggles |
| Surface | `#FCFCFC` | `#171717` | Page background |
| Text Primary | `#252525` | `#FAFAFA` | Body text |
| Divider | `#E4E4E4` | `#47E4E4E4` | Borders |

### Radius
| Token | Value | Use |
|---|---|---|
| Checkbox | 4dp | Small controls |
| List item | 8dp | Item backgrounds |
| Bottom nav | 12dp | Nav buttons |
| Switch | 16dp | Toggle track |
| Button | 18dp | All buttons |
| Chip | 22dp | Tags, filters |
| Card / Dialog / Sheet | 26dp | Containers |
| FAB | 50% | Floating action |
| Search / Pill | 999dp | Search bars |

### Motion
| Token | Curve / Duration | Use |
|---|---|---|
| `ease-emphasized` | `(0.2, 0, 0, 1)` | Hero transitions, sheets |
| `ease-spring` | `(0.2, 0.6, 0.4, 1)` | Dialogs, FAB, scale |
| `ease-bounce` | `(0.34, 1.56, 0.64, 1)` | Celebration, success |
| `dur-normal` | 300ms | Standard transitions |
| `dur-slow` | 400ms | Bottom sheets, dialogs |
| `dur-page` | 800ms | Page transitions |

---

## Diagram style notes

Diagrams above use a shape + color language ported from FigJam's
*Diagram Basics* template:

- **Pill (lavender)** for terminal nodes (Start / End / Phone canvas)
- **Rectangle (cream)** for deterministic processes
- **Diamond (pale yellow)** for decisions — Yes / No / Success branches
- **Parallelogram (pale blue)** for I/O — data crossing a boundary
- **Cylinder (pale green)** for data stores (registry, embeddings, themes)
- **Hexagon (pale violet)** for LLM calls — emphasizes "AI thinks here"
- **Pill (warm pink)** for drops / rejects — duplicate or invalid

GitHub renders Mermaid natively, so the diagrams are first-class
content on the repo landing page.

---

## Source references

- [Samsung Korea](https://www.samsung.com/sec/) · [Samsung US](https://www.samsung.com/us/)
- [Samsung Brand Identity](https://www.samsung.com/sec/about-us/brand-identity/)
- [One UI Design System](https://design.samsung.com/global/contents/one-ui/)
- [One UI Developer Docs](https://developer.samsung.com/one-ui)
- [oneui-design (GitHub)](https://github.com/OneUIProject/oneui-design)
- [FigJam · Diagram Basics (template)](https://www.figma.com/board/4OPGrPb6iawIeZtqbFizBQ/Diagram-Basics--Community-) — diagram shape/color language
