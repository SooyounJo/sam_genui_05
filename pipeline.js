// ============================================================================
//  GENUI PIPELINE v1 (3-step variant) — interpreter → normalizer → planner
//  ---------------------------------------------------------------------------
//  Each step is an INDEPENDENT LLM call. Output JSON of step N is passed
//  verbatim to step N+1. No step invents UI markup.
//
//    STEP 1  scenario_interpreter  scenario_text → {intent, context, tasks,
//                                                   constraints, ui_state}
//    STEP 2  handoff_normalizer    STEP_1 → {planning_summary, task_groups,
//                                            slot_requirements,
//                                            selection_constraints, ui_state}
//    STEP 3  component_selector    STEP_2 → {required_components[],
//                                            planner_notes}
//
//  Plus step_7 explanation_layer (invoked separately).
// ============================================================================

const fs = require('fs');
const path = require('path');
const {
  normalizeInterpreterOutput,
  normalizeNormalizerOutput,
  normalizeSelectorOutput,
  normalizeComposerOutput
} = require('./schema_normalizer');
const {
  validateContextComponentMatch,
  validateLayoutOverflow,
  buildViolation:  buildLayoutViolation,
  flattenGroups:   _flattenGroups
} = require('./layout_composer');
const Generator = require('./generator');
const DesignMemory = require('./design_memory');

const REGISTRY_PATH = path.join(__dirname, 'figma-refs', 'component_registry.json');
let REGISTRY = null;
try { REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
catch (e) { console.warn('[pipeline] component_registry.json not found or invalid:', e.message); }

// ---------------------------------------------------------------------------
//  COMPONENT EMBEDDINGS  (Stage 3 RAG shortlist)
//  Pre-computed by scripts/build_component_embeddings.js. At runtime we
//  embed the user scenario, take cosine top-K, and feed only that shortlist
//  to the planner LLM. This lets the vocabulary cover all 92 registry
//  entries without ballooning the prompt.
//
//  DEFAULT OFF (speed-first): RAG adds ~400ms per pipeline call for the
//  embedding fetch. Since latency is non-negotiable, the runtime shortlist
//  is OPT-IN. Set `PIPELINE_RAG=on` in .env to enable. With RAG off, the
//  selector reverts to the legacy 10-item curated vocabulary AND the
//  validator reverts to checking against the 10-item set — fully
//  pre-RAG behavior.
// ---------------------------------------------------------------------------
const RAG_ENABLED = (process.env.PIPELINE_RAG || 'off').toLowerCase() === 'on';
// AI-first mode (default): keep One UI safety rails, but reduce scenario-
// specific deterministic injections/contracts so the model can reason freely.
const HEAVY_RULES = (process.env.PIPELINE_HEAVY_RULES || 'off').toLowerCase() === 'on';

// Bundled map hero (NYC POI preview). Default on so travel/running screens always
// show a raster; set PIPELINE_MAP_DUMMY=off to use live OSM tiles again.
const GENUI_DUMMY_MAP_PREVIEW_URL =
  process.env.GENUI_DUMMY_MAP_URL || '/assets/genui/dummy-map-preview.png';
const USE_DUMMY_MAP_PREVIEW = (process.env.PIPELINE_MAP_DUMMY || 'on').toLowerCase() !== 'off';

// Glance / dashboard tiles that can share a 2-column grid (2×2, 2×3, …).
// glanceable layouts forbid wide grids unless every visible child is from this set.
const DASHBOARD_TILE_COMPONENT_IDS = new Set([
  'reminder_card',
  'weather_glance_card',
  'message_summary_card',
  'calendar_summary_card',
  'eta_card',
  'input_summary_card',
  'widget-small'
]);

/** E-book / reading status / chapter flows — used for 2-up grid heuristics. */
function isReadingBriefScenarioText(scenarioText, planningPacket) {
  const scen = String(scenarioText || '');
  const ui = (planningPacket && planningPacket.uiState) || {};
  const tags = Array.isArray(ui.contextTags) ? ui.contextTags.map(String) : [];
  return (
    /\b(reading|reader|e-?book|ebook|chapter|passage|pages?\s+\d|book\s+progress|novel|audiobook|book\s+reader|reading\s+status)\b/i.test(
      scen
    ) ||
    /(독서|전자책|책\s*읽기|독서\s*현황|진행\s*률|챕터|책갈피)/.test(scen) ||
    tags.some(t => /\b(e-?book|reading|reader|chapter)\b/i.test(t))
  );
}

/** Guided cooking / kitchen session — avoid fragmenting primary into many grid tiles. */
function isGuidedCookingWorkflowScenario(scenarioText, planningPacket) {
  const scen = String(scenarioText || '');
  const ui = (planningPacket && planningPacket.uiState) || {};
  const tags = Array.isArray(ui.contextTags) ? ui.contextTags.map(String) : [];
  if (tags.some(t => /hands-busy-cooking|cooking-session/i.test(t))) return true;
  if (
    tags.some(t => /assistant-task/i.test(t)) &&
    /\b(cook|recipe|kitchen|chef|meal|prep|simmer|stove|ingredient)\b/i.test(scen)
  ) {
    return true;
  }
  return /\b(cook(?:ing)?|recipe|kitchen|\bchef\b|meal\s*prep|guided\s*cook|stove|simmer)\b/i.test(scen);
}

// ---------------------------------------------------------------------------
//  CONTEXT-AWARE INJECTION RULES
//  Maps a context tag (or a regex on tags) to component IDs the runSelect
//  stage will programmatically inject when:
//    (a) the tag appears in uiState.contextTags, AND
//    (b) the component isn't already in the plan, AND
//    (c) the component is in the allowed semantic vocabulary.
//  This addresses the "selector picks too narrowly" failure mode where the
//  LLM identifies relevant tasks (e.g. "scan-upcoming-day-context") but
//  doesn't translate them into rich content cards. Injection is silent and
//  deterministic — no prompt strings, no LLM dependency, no leakage risk.
// ---------------------------------------------------------------------------
const CONTEXT_INJECTION_RULES = {
  // Time-of-day / ambient
  'morning':       ['calendar_summary_card', 'reminder_card'],
  'briefing':      ['calendar_summary_card', 'reminder_card', 'message_summary_card'],
  'evening':       ['reminder_card'],
  'agenda':        ['calendar_summary_card'],
  'schedule':      ['calendar_summary_card'],
  // Activity / state
  'media-playing': [],   // now-bar.media-player handled by mandatory/render path
  'driving':       ['navigation_turn_card', 'eta_card'],
  'navigation':    ['navigation_turn_card'],
  'commute':       ['eta_card'],
  // Communication
  'messages':      ['message_summary_card'],
  'incoming-message': ['message_summary_card'],
  'notifications': [],   // notification-card handled separately
  // Tasks
  'reminder':      ['reminder_card'],
  'tasks':         ['reminder_card'],
  'todo':          ['reminder_card'],
  // Guided assistants (cooking/workout/timer) — quick toggles + session strip when tags present
  'assistant-task':     ['quick_toggle_row', 'media_control_bar'],
  'assistive-session':  ['action_chip_row', 'quick_toggle_row'],
  'hands-busy-cooking': ['quick_toggle_row', 'action_chip_row'],
  'timer':             ['media_control_bar'],
  'cooking-session':    ['action_chip_row', 'media_control_bar']
};

// ---------------------------------------------------------------------------
//  LEARNED RULES — runtime hooks
//  The improvement engine (improvement_engine.js) trials new rules by
//  applying them to these runtime maps without restarting the server. If a
//  trial improves test-suite scores, the rule is persisted to
//  figma-refs/learned_rules.json and loaded again on next boot.
// ---------------------------------------------------------------------------
const LEARNED_CONTEXT_INJECTIONS = {};   // tag → [componentIds]
const LEARNED_EVOLVE_ENTRIES     = [];   // [{ id, type, constraint }]
const LEARNED_RULE_INDEX         = {};   // ruleId → { kind, ...payload } for reverts

function addLearnedRule(rule) {
  if (!rule || !rule.type || !rule.payload || !rule.id) return false;
  if (rule.type === 'context_injection') {
    const tag = String(rule.payload.tag || '').toLowerCase();
    const ids = Array.isArray(rule.payload.componentIds) ? rule.payload.componentIds.slice() : [];
    if (!tag || ids.length === 0) return false;
    if (!LEARNED_CONTEXT_INJECTIONS[tag]) LEARNED_CONTEXT_INJECTIONS[tag] = [];
    ids.forEach(id => {
      if (LEARNED_CONTEXT_INJECTIONS[tag].indexOf(id) < 0) LEARNED_CONTEXT_INJECTIONS[tag].push(id);
    });
    LEARNED_RULE_INDEX[rule.id] = { kind: 'context_injection', tag, componentIds: ids };
    return true;
  }
  if (rule.type === 'evolve_constraint') {
    LEARNED_EVOLVE_ENTRIES.push({
      id:         rule.id,
      type:       rule.payload.type || 'general',
      constraint: rule.payload.constraint || ''
    });
    LEARNED_RULE_INDEX[rule.id] = { kind: 'evolve_constraint' };
    return true;
  }
  // composer_hint / selector_hint require human approval — not auto-applied
  return false;
}

function removeLearnedRule(ruleId) {
  if (!ruleId || !LEARNED_RULE_INDEX[ruleId]) return false;
  const idx = LEARNED_RULE_INDEX[ruleId];
  if (idx.kind === 'context_injection') {
    const { tag, componentIds } = idx;
    if (tag && LEARNED_CONTEXT_INJECTIONS[tag]) {
      LEARNED_CONTEXT_INJECTIONS[tag] = LEARNED_CONTEXT_INJECTIONS[tag]
        .filter(id => componentIds.indexOf(id) < 0);
      if (LEARNED_CONTEXT_INJECTIONS[tag].length === 0) delete LEARNED_CONTEXT_INJECTIONS[tag];
    }
  } else if (idx.kind === 'evolve_constraint') {
    for (let i = LEARNED_EVOLVE_ENTRIES.length - 1; i >= 0; i--) {
      if (LEARNED_EVOLVE_ENTRIES[i].id === ruleId) LEARNED_EVOLVE_ENTRIES.splice(i, 1);
    }
  }
  delete LEARNED_RULE_INDEX[ruleId];
  return true;
}

function listLearnedRules() {
  return {
    contextInjections: { ...LEARNED_CONTEXT_INJECTIONS },
    evolveEntries:     LEARNED_EVOLVE_ENTRIES.slice(),
    indexed:           Object.keys(LEARNED_RULE_INDEX)
  };
}

// Placeholder content for context-injected components. These look like
// real sample data (so the renderer's per-component visual treatment has
// something to lay out) but don't claim scenario-specific accuracy. A
// future improvement would be a tiny content-fill LLM call — but that
// adds latency, and the user's priority is speed.
const CONTEXT_INJECTION_PLACEHOLDERS = {
  'calendar_summary_card':  { label: 'Next up · Today',    value: 'Stand-up · 9:30 AM · Studio A' },
  'reminder_card':          { label: "Today's tasks",      value: '3 items · Due today' },
  'message_summary_card':   { label: 'Messages · 2 new',   value: 'Alex: Running 10 min late' },
  'eta_card':               { label: 'ETA · Home',         value: '12 min · Light traffic' },
  'navigation_turn_card':   { label: 'In 200 m',           value: 'Turn right onto Hangang-daero' },
  'notification-card':      { label: 'Notification',       value: 'Tap to view' }
};

// ---------------------------------------------------------------------------
//  Guided cooking / recipe assistant — planning packet enricher + selector
//  contract. Fixes: (a) FAST mode capped slot_requirements at 3 in the LLM
//  hint, (b) runSelect preferred rawCombined so server-side packet fixes
//  never reached the selector prompt.
// ---------------------------------------------------------------------------

const GUIDED_FAST_PLANNING_ESCAPE_HINT =
  '\n\n[GUIDED ASSISTANT / COOKING / RECIPE EXCEPTION]\n' +
  'Ignore the FAST caps above for THIS scenario class only:\n' +
  '- slotRequirements: emit AT LEAST 7 distinct behavioral slots covering ' +
  'subject headline + facets, active step prose, personalization rationale, ' +
  'timers/session controls, quick intent chips (voice/substitutions/done), ' +
  'optional toggles, and primary/secondary button affordances.\n' +
  '- tasks[] up to 6 entries if needed; selection_constraints prefer/avoid ' +
  'up to 5 entries each.\n' +
  'Goal: selection must receive a complete slot map—not 3 vague slots.';

const GUIDED_FAST_FLIGHT_ESCAPE_HINT =
  '\n\n[FLIGHT / BOARDING / ITINERARY EXCEPTION]\n' +
  'Ignore the FAST caps above for THIS scenario class only:\n' +
  '- slotRequirements: emit AT LEAST 6 distinct behavioral slots covering ' +
  'trip headline (airline/route/flight #), itinerary times (local dep/arr OR boarding opens/closes), ' +
  'gate & terminal (& seat/bag hints), boarding/status line, ETA or walks to gate, ' +
  'travel action chips & a primary CTA (wallet / boarding / directions).\n' +
  '- tasks[] up to 5 entries.\n' +
  'Goal: selectors must receive enough itinerary slots—not a boarding-strip alone.';

const GUIDED_FAST_IOT_ESCAPE_HINT =
  '\n\n[IOT / SMART-HOME CONTROL EXCEPTION]\n' +
  'Ignore the FAST caps above for THIS scenario class only:\n' +
  '- slotRequirements: emit AT LEAST 7 distinct behavioral slots covering ' +
  'room/device context, primary device state, adjustable control (brightness/temperature/volume), ' +
  'quick scenes, live telemetry (power/temperature/humidity), and at least one safety/override action.\n' +
  '- tasks[] up to 6 entries.\n' +
  'Goal: selectors must receive rich control-state-context slots—not one generic card + chips.';

const COOKING_ASSISTANT_SLOT_BLUEPRINT = [
  {
    slot:          'recipe_subject_and_facets',
    purpose:       'Recipe or meal headline with dietary personalization / facet chips',
    contentType:   'compound_summary',
    priority:      1,
    selectionHint:
      'Headline plus supporting facts; prefer reminder_card, calendar_summary_card, or weather_glance_card idioms—not input_summary_card unless this is strictly a filled-form recap.'
  },
  {
    slot:          'active_step_instruction',
    purpose:       'The instruction the user performs in this moment (step body)',
    contentType:   'dense_text',
    priority:      1,
    selectionHint:
      'Multi-line instructional text; prefer reminder_card or message_summary_card—not a chip row.'
  },
  {
    slot:          'session_timer_or_transport',
    purpose:       'Pause, timer, snooze, or session strip for hands-busy cooking',
    contentType:   'playback_controls',
    priority:      2,
    selectionHint: 'Use media_control_bar for countdown/scrub/pause semantics.'
  },
  {
    slot:          'quick_intent_chips',
    purpose:       'Voice tip, substitutions, scaling, units, mark step done',
    contentType:   'chip_actions',
    priority:      2,
    selectionHint:
      'Use action_chip_row with discrete content.actions entries (one per chip); labels must be cooking-specific.'
  },
  {
    slot:          'binary_preferences_row',
    purpose:       'Allergens, diet filters, mute voice — binary presets',
    contentType:   'toggle_row',
    priority:      3,
    selectionHint: 'Use quick_toggle_row when the scenario needs compact on/off presets.'
  },
  {
    slot:          'substitution_or_personalization_detail',
    purpose:       'Why ingredients or steps were adapted to the user',
    contentType:   'supporting_detail',
    priority:      3,
    selectionHint: 'Secondary explanation; prefer eta_card or message_summary_card.'
  },
  {
    slot:          'primary_step_ctas',
    purpose:       'Dominant actions: Start prep, Next step, Save recipe',
    contentType:   'primary_action',
    priority:      2,
    selectionHint:
      'Use btn-contained for the dominant action; btn-outlined for secondary—not passive cards.'
  }
];

/** Flight/boarding assistants — analogue to cooking blueprint (no recipes). */
const FLIGHT_TRAVEL_SLOT_BLUEPRINT = [
  {
    slot:          'flight_subject_headline',
    purpose:       'Airline/flight/route summary the user anchors on (flight #, cities, boarding pass cue)',
    contentType:   'compound_summary',
    priority:      1,
    selectionHint:
      'Prefer reminder_card or calendar_summary_card as subject—not input_summary_card. Label+value MUST include route pair or flight id + one concrete boarding fact.'
  },
  {
    slot:          'schedule_boarding_gate',
    purpose:       'Depart/arrive LOCAL times OR boarding-window / gate-close alongside gate number & terminal',
    contentType:   'dense_text',
    priority:      1,
    selectionHint:
      'calendar_summary_card for times; pairing with boarding/gate prose in reminder_card OK; avoid placeholders like "Flight 123".'
  },
  {
    slot:          'transit_eta_or_terminal_note',
    purpose:       'Time-to-gate, security cue, lounge, baggage claim carousel',
    contentType:   'eta_or_context',
    priority:      2,
    selectionHint: 'Prefer eta_card for “mins to gate” style lines; fallback navigation_turn_card short cue.'
  },
  {
    slot:          'travel_quick_actions',
    purpose:       'Boarding QR, Offline pass, Directions, Lounge, Meal order—travel-specific intents',
    contentType:   'chip_actions',
    priority:      2,
    selectionHint:
      'Use action_chip_row with content.actions[]. Labels must mention travel verbs—never Voice tip / Substitute recipe / Scale meal.'
  },
  {
    slot:          'primary_travel_cta',
    purpose:       'Dominant traveler action — open boarding pass / add wallet / navigate',
    contentType:   'primary_action',
    priority:      2,
    selectionHint: 'btn-contained (+ optional btn-outlined). Use travel verbs only.'
  }
];

const IOT_ASSISTANT_SLOT_BLUEPRINT = [
  {
    slot: 'iot_space_and_device',
    purpose: 'Current room + selected device context (e.g. Bedroom lamp, AC, purifier)',
    contentType: 'compound_summary',
    priority: 1,
    selectionHint: 'Prefer reminder_card or input_summary_card with concrete room/device names.'
  },
  {
    slot: 'iot_primary_state',
    purpose: 'Main device state (on/off/mode/scene) visible at first glance',
    contentType: 'status_summary',
    priority: 1,
    selectionHint: 'Prefer reminder_card or message_summary_card; include mode + level.'
  },
  {
    slot: 'iot_adjustable_control',
    purpose: 'Continuous control (brightness, temperature, fan, volume)',
    contentType: 'continuous_control',
    priority: 1,
    selectionHint: 'Prefer vertical-slider or media_control_bar when scrub/pause semantics fit.'
  },
  {
    slot: 'iot_quick_scene_actions',
    purpose: 'Scene shortcuts (Sleep, Reading, Away, Movie, Party)',
    contentType: 'chip_actions',
    priority: 2,
    selectionHint: 'Use action_chip_row with scenario-specific scenes, not generic labels.'
  },
  {
    slot: 'iot_toggle_cluster',
    purpose: 'Binary toggles (power lock, auto mode, eco, motion)',
    contentType: 'toggle_row',
    priority: 2,
    selectionHint: 'Use quick_toggle_row only for true binary controls.'
  },
  {
    slot: 'iot_live_telemetry',
    purpose: 'Ambient readings and device metrics (temp, humidity, power, connectivity)',
    contentType: 'metrics',
    priority: 2,
    selectionHint: 'Prefer widget-small/list-item/input_summary_card with numeric telemetry.'
  },
  {
    slot: 'iot_safety_or_override',
    purpose: 'Critical action (all off, lock, emergency, schedule override)',
    contentType: 'primary_action',
    priority: 2,
    selectionHint: 'Use btn-contained (optional btn-outlined) with explicit safety verb.'
  }
];

/** True playback intent on a travel scenario (allow media_control_bar). */
function travelScenarioWantsPlaybackStrip(blob) {
  return /\b(podcast|music|playlist|listening|streaming|playback|audiobook|spotify|headphones|now\s+playing)\b/i.test(blob || '');
}

function _contextTagsMerged(interpretation, planningPacket) {
  const a = (interpretation && interpretation.uiState && interpretation.uiState.contextTags) || [];
  const b = (planningPacket && planningPacket.uiState && planningPacket.uiState.contextTags) || [];
  const out = []
    .concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])
    .map(String);
  return out;
}

/** Text-level domain tags for cross-domain filtering (flight vs kitchen, etc.). */
function classifyScenarioDomains(scenarioText, interpretation) {
  const goal = interpretation && interpretation.intent && interpretation.intent.primaryGoal
    ? String(interpretation.intent.primaryGoal)
    : '';
  const blob = `${scenarioText || ''}\n${goal}`;
  const travel =
    /\b(flight|airplane|airport|\bgate\b|boarding|check-?in|itinerary|layover|carry-?on|boarding\s+pass|flight\s+assistant)\b/i.test(blob) ||
    /\b(trip|travel|traveling|travelling|vacation|getaway|\bholiday\b|tour(ism)?|excursion|road\s*trip|city\s*break|sightseeing)\b/i.test(blob) ||
    /(항공|비행기|공항|탑승|체크인|체크\s*인|출국|입국|환승|탑승구|탑승권|기내|\b기장\b|여행\s*일정|\b여행\b|출장|휴가|패키지(?:\s*여행)?)/.test(blob);
  const cooking =
    /\b(cook(ing)?|kitchen|recipe|\bchef\b|meal\s+prep|\bmeal\b|ingredient|nutrition|kcal|calorie|substitut|gluten|vegan|\bdiet\b|food\s+delivery|takeout|tap\s+to\s+order|restaurant)\b/i.test(blob) ||
    /(요리|레시피|요리법|냉장고|재료|칼로리|다이어트|글루텐|비건|식단|밀키트|배달\s*음식|음식\s*주문|베이킹|굽기|삶기|볶음|찌개|반찬)/.test(blob);
  const workout =
    /\b(workout|fitness|exercise|\brunning\b|racing|cycling|\blaps?\b|heart\s+rate|yoga)\b/i.test(blob) ||
    /(운동|헬스|요가|근력|유산소)/.test(blob);
  return { blob, travel, cooking, workout };
}

/** Remove cooking context tags when the scenario is travel-only (interpreter noise). */
function stripCookingSignalsFromTravelUiState(planningPacket, interpretation, scenarioText) {
  const dom = classifyScenarioDomains(scenarioText, interpretation);
  if (!dom.travel || dom.cooking) return;

  function cleanTags(ui) {
    if (!ui || !Array.isArray(ui.contextTags)) return;
    ui.contextTags = ui.contextTags.filter(tag => {
      const t = String(tag).toLowerCase();
      if (t === 'hands-busy-cooking' || t === 'cooking-session') return false;
      // assistant-task pulls quick_toggle_row + media_control_bar (music strip) —
      // wrong default for boarding/flight assistants (see CONTEXT_INJECTION_RULES).
      if (t === 'assistant-task' && !travelScenarioWantsPlaybackStrip(dom.blob)) return false;
      // Timer-only tag would inject media_control_bar; keep only if countdown language exists.
      if (t === 'timer' &&
          !/\b(boarding\s+closes|gate\s+closes|depart(?:s|ure)?|countdown|\d{1,2}:\d{2})\b/i.test(scenarioText || '')) {
        return false;
      }
      return true;
    });
  }
  if (planningPacket && planningPacket.uiState) cleanTags(planningPacket.uiState);
  if (interpretation && interpretation.uiState) cleanTags(interpretation.uiState);
}

/**
 * Share sheet / picker / explicit bottom-sheet scenarios should adopt
 * system-dialog + dialog-surface so the renderer mounts pipeline-bottom-sheet chrome.
 */
function applyDialogSurfaceHeuristic(planningPacket, scenarioText, interpretation) {
  const pp = planningPacket;
  if (!pp || !pp.uiState) return;
  const ui = pp.uiState;
  if ((ui.baseSurface || 'app') !== 'app') return;
  if (ui.overlayType && ui.overlayType !== 'none') return;
  const raw = String(scenarioText || '');
  const goal = interpretation && interpretation.intent && interpretation.intent.primaryGoal
    ? String(interpretation.intent.primaryGoal)
    : '';
  const blob = [raw, goal].join('\n');
  const iu = interpretation && interpretation.uiState;
  const tagStr = []
    .concat(Array.isArray(ui.contextTags) ? ui.contextTags : [])
    .concat(iu && Array.isArray(iu.contextTags) ? iu.contextTags : [])
    .map(t => String(t || '').toLowerCase())
    .join(' ');
  const tagWantsDialog =
    /\b(bottom[-_]?sheet|bottomsheet|sheet[-_]?ui|dialog[-_]?surface|share[-_]?sheet|action[-_]?sheet|coordination[-_]?sheet|option[-_]?picker|target[-_]?picker|system[-_]?dialog)\b/.test(
      tagStr
    );
  const tagWantsReadingChrome =
    /\b(reader[-_]?quick[-_]?bar|reading[-_]?quick[-_]?bar|ebook[-_]?quick[-_]?bar|reader[-_]?sheet|reading[-_]?sheet|ebook[-_]?sheet|book[-_]?reader[-_]?sheet|reading[-_]?bottom[-_]?sheet)\b/.test(
      tagStr
    );
  const reEn =
    /\b(share\s*sheet|sharing\s*sheet|bottom\s*sheet|action\s*sheet|coordination\s*sheet|target\s*picker|option\s*picker|system\s*dialog|modal\s*(dialog|bottom)|half\s*sheet|peek\s*sheet|slide\s*-?\s*up\s*(sheet|panel)?|sheet\s*-?\s*shaped|pick\s+one(\s+of)?|choose\s+(an\s+)?option|pick\s+(a|an|your)\s+\w+\s+from)\b/i;
  const reReadingSheetEn =
    /\b(reader\s+quick\s*bar|reading\s+quick\s*bar|e[- ]?book\s+quick\s*bar|book\s+reader\s+quick\s*bar|(reading|reader|e[- ]?book)\s+(bottom\s*sheet|as\s+a\s+sheet|sheet\s+only|peek\s+sheet|in\s+a\s+sheet)|(quick\s*bar|bottom\s*sheet)\s+only\s+(for\s+)?(reading|reader|book)|reading\s+controls\s+((in|on)\s+(a\s+)?(sheet|quick\s*bar))|controls\s+only\s+(sheet|quick\s*bar)|reading\s+status\s+(sheet|bar)\b)/i;
  const reKo =
    /바텀\s*시트|바텀시트|바텀\s*카드\s*형|카드\s*형\s*바텀|하단\s*시트|하단\s*(모달|패널|카드|영역)|공유\s*시트|옵션\s*(선택|피커)|액션\s*시트|조율\s*시트|시스템\s*다이얼로그|공유\s*하기|목록에서\s*(골라|선택)|시트\s*형|카드\s*형\s*시트|시트\s*형\s*카드|슬라이드\s*(업|올림)|반\s*올림|끌어\s*올려|딤\s*(처리|배경)|(둥근\s*)?하단\s*카드/;
  const reReadingSheetKo =
    /독서\s*(퀵\s*바|퀵바|바텀\s*시트|바텀시트|바텀만|하단\s*시트)|(전자)?책\s*(퀵\s*바|퀵바|바텀)|리딩\s*(퀵\s*바|퀵바|바텀)|독서\s*상태\s*(퀵\s*바|퀵바|시트|바텀)|바텀\s*만\s*으로|시트\s*만\s*으로|퀵\s*바\s*만/;
  if (
    !reEn.test(blob) &&
    !reKo.test(blob) &&
    !tagWantsDialog &&
    !tagWantsReadingChrome &&
    !reReadingSheetEn.test(blob) &&
    !reReadingSheetKo.test(blob)
  ) {
    return;
  }
  ui.overlayType = 'system-dialog';
  if (!ui.overlayCoverage || ui.overlayCoverage === 'none') {
    ui.overlayCoverage = 'partial';
  }
  ui.backgroundPolicy = 'dialog-surface';
  if (iu) {
    iu.overlayType = ui.overlayType;
    iu.overlayCoverage = ui.overlayCoverage;
    iu.backgroundPolicy = ui.backgroundPolicy;
  }
}

/** Drop plan rows whose copy clearly belongs to another domain (e.g. recipe text on a flight screen). */
function stripCrossDomainPlanClutter(plan, scenarioText, interpretation) {
  if (!plan || !Array.isArray(plan.requiredComponents)) return 0;
  const dom = classifyScenarioDomains(scenarioText, interpretation);
  const COOKING_MARK = /\b(calorie|kcal|gluten|vegan|substitut|ingredient|recipe|servings|nutrition|chicken\s+salad|meal\s+prep|scale\s+recipe|simmer|saut[eé])\b/i;
  const TRAVEL_MARK = /\b(boarding|gate\s*[a-z]?\d+|check-?in|itinerary|layover|carry-?on|boarding\s+pass|departure|arrival|\bflight\b)\b/i;
  const RECIPE_ACTION = /\b(voice\s+tip|substitute|scale\s+recipe|mark\s+done|ingredient|converter|next\s+step|unit\s+converter)\b/i;

  const before = plan.requiredComponents.length;

  if (dom.travel && !dom.cooking) {
    plan.requiredComponents = plan.requiredComponents.filter(c => {
      const cstr = JSON.stringify(c.content || {}).toLowerCase();
      if (c.componentType === 'action_chip_row') {
        const acts = Array.isArray(c.content && c.content.actions) ? c.content.actions : [];
        const actBlob = acts.map(a => String((a && a.label) || '').toLowerCase()).join(' ');
        if (RECIPE_ACTION.test(actBlob) || COOKING_MARK.test(actBlob)) return false;
      }
      if (COOKING_MARK.test(cstr) && !TRAVEL_MARK.test(cstr)) return false;
      if ((c.componentType === 'btn-contained' || c.componentType === 'btn-outlined') &&
          /\b(next\s+step|advance\s+instructions|unit\s+converter)\b/i.test(
            String((c.content && c.content.label) || '') + ' ' +
            String((c.content && c.content.value) || '')
          )) return false;
      // Now-playing strips are off-domain unless user asked for playback.
      if (c.componentType === 'media_control_bar') {
        const piece = `${(c.content && c.content.label) || ''} ${(c.content && c.content.value) || ''}`.toLowerCase();
        const looksPlayback = /\b(playing|smooth\s+jazz|podcast|track|playlist|shuffle|playback|listening|paused|song|episode|music)\b/i.test(piece)
          || /\b(skip|shuffle|album)\b/i.test(piece);
        const looksBoardingTimer = /\b(boarding|gate)\b.*\b(closes|begins|opens)\b/i.test(piece)
          || /\b(countdown|flight\s+tracker|timer)\b/i.test(piece)
          || /\d{1,2}:\d{2}:\d{2}/.test(piece)
          || (c.content && c.content.icon) === 'timer';
        if (looksPlayback && !looksBoardingTimer && !travelScenarioWantsPlaybackStrip(dom.blob)) return false;
      }
      return true;
    });
  } else if (dom.cooking && !dom.travel) {
    plan.requiredComponents = plan.requiredComponents.filter(c => {
      const cstr = JSON.stringify(c.content || {}).toLowerCase();
      // Drop orphan flight-only rows when there is no travel scenario.
      if ((c.componentType === 'reminder_card' || c.componentType === 'message_summary_card' || c.componentType === 'calendar_summary_card')
          && TRAVEL_MARK.test(cstr) && !COOKING_MARK.test(cstr)) {
        return false;
      }
      return true;
    });
  }

  const dropped = before - plan.requiredComponents.length;
  if (dropped > 0 && plan.plannerNotes) {
    plan.plannerNotes.crossDomainStripped = dropped;
    console.log('[pipeline] cross-domain strip: removed', dropped, 'off-domain component row(s)');
  }
  return dropped;
}

function isGuidedCookingAssistantScenario(scenarioText, interpretation, planningPacket) {
  const s = scenarioText || '';
  // Travel-only scenarios must not inherit cooking slot blueprints / tags.
  const travelExclusive =
    /\b(flight|airplane|boarding|gate|airline|itinerary|check-?in|layover)\b/i.test(s) &&
    !/\b(cook|recipe|kitchen|chef|meal|prep|timer|substitut)\b/i.test(s);
  if (travelExclusive) return false;
  const tags = _contextTagsMerged(interpretation, planningPacket);
  // Do NOT use "timer" tag alone — boarding timers are common on travel UIs.
  const tagHit = tags.some(t =>
    /assistant-task|hands-busy-cooking|cooking-session/i.test(t)
  );
  const cookingish   = /\b(cook(?:ing)?|kitchen|recipe|chef|meal|prep)\b/i.test(s);
  const assistantish = /\b(assistant|personalized|coach|guided)\b/i.test(s);
  return tagHit || (cookingish && assistantish) || /\bpersonalized\s+cooking\b/i.test(s);
}

function likelyGuidedCookingAssistantScenarioText(scenarioText) {
  return isGuidedCookingAssistantScenario(scenarioText, null, null);
}

/** Travel / flight / boarding itineraries (not kitchen). */
function isFlightTravelScenario(scenarioText, interpretation, planningPacket) {
  const dom = classifyScenarioDomains(scenarioText, interpretation);
  return !!(dom.travel && !dom.cooking);
}

function likelyFlightTravelScenarioText(scenarioText) {
  return isFlightTravelScenario(scenarioText, null, null);
}

/** City / destination hint for trip copy — keeps placeholders scenario-grounded. */
function tripLabelFromScenario(scenarioText) {
  const s = String(scenarioText || '').trim();
  const m = s.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(trip|travel|vacation|getaway|holiday)\b/i);
  if (m) return m[1].trim();
  const city = s.match(
    /\b(New York|NYC|Los Angeles|San Francisco|London|Paris|Tokyo|Seoul|Busan|Jeju|Bangkok|Singapore|Rome|Berlin|Chicago|Boston)\b/i
  );
  if (city) return city[1];
  const ko = s.match(/(서울|부산|제주|도쿄|뉴욕|파리|런던)/);
  if (ko) return ko[1];
  return '';
}

/**
 * Travel / trip screens: never stay at "title + music strip + one CTA".
 * Swaps spurious media_control_bar → itinerary card when playback wasn't requested,
 * and backfills informational tiles up to a small floor.
 */
function ensureTravelTripPlanDensity(plan, scenarioText, interpretation, planningPacket) {
  if (!plan || !Array.isArray(plan.requiredComponents)) return 0;
  const ui = planningPacket && planningPacket.uiState;
  if (!ui || ui.baseSurface !== 'app') return 0;
  if (!isFlightTravelScenario(scenarioText, interpretation, planningPacket)) return 0;

  const rows = plan.requiredComponents;
  const dom = classifyScenarioDomains(scenarioText, interpretation);
  const allowPlayback = travelScenarioWantsPlaybackStrip(dom.blob);
  const city = tripLabelFromScenario(scenarioText);
  const tripLine = city
    ? `Day plan · ${city}: hotels, transit passes, reservations, museum slots, dinner — use real times & addresses (40+ chars).`
    : 'Itinerary: arrival, lodging, day blocks, local transit, dinner reservation — concrete times and place names.';

  const INFO = new Set([
    'reminder_card',
    'calendar_summary_card',
    'eta_card',
    'navigation_turn_card',
    'message_summary_card',
    'weather_glance_card',
    'input_summary_card'
  ]);
  function countInfo() {
    return rows.filter(c => c && c.role !== 'chrome' && INFO.has(c.componentType)).length;
  }

  let touched = 0;
  if (!allowPlayback) {
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      if (!c || c.componentType !== 'media_control_bar' || c.role === 'chrome') continue;
      rows[i] = Object.assign({}, c, {
        componentType: 'reminder_card',
        slot: String(c.slot || 'trip_row').replace(/[^a-z0-9_]/gi, '_').toLowerCase() + '_itinerary_note',
        content: {
          label: city ? `Itinerary · ${city}` : 'Trip · Itinerary',
          value: tripLine,
          icon: 'schedule'
        },
        _source: (c._source || 'selector') + '+travel-swap-no-playback'
      });
      touched++;
    }
  }

  let added = 0;
  function pushRow(slot, type, role, pri, content) {
    rows.push({
      slot,
      componentType: type,
      variantHint: 'default',
      priority: pri,
      role,
      content,
      constraints: [],
      _source: 'travel-density-floor'
    });
    added++;
  }

  let infoCount = countInfo();
  if (infoCount < 3 && !rows.some(c => c && c.role !== 'chrome' && c.componentType === 'calendar_summary_card')) {
    pushRow(
      'travel_floor_calendar',
      'calendar_summary_card',
      'subject',
      1,
      {
        label: city ? `Schedule · ${city}` : 'Schedule · Trip',
        value: city
          ? `Today · 9:30 AM meet guide · 2:00 PM museum ticket · 7:30 PM dinner (${city}) · buffer for jet lag.`
          : 'Today · morning block, afternoon reservation, evening plans — local times and confirmation numbers.',
        icon: 'schedule'
      }
    );
    infoCount = countInfo();
  }
  if (infoCount < 3 && !rows.some(c => c && c.role !== 'chrome' && c.componentType === 'eta_card')) {
    pushRow(
      'travel_floor_eta',
      'eta_card',
      'context',
      2,
      {
        label: city ? `Getting around · ${city}` : 'Transit & ETA',
        value: city
          ? `Airport to hotel ~45 min · subway + walk · buffer before first reservation (${city}).`
          : 'Airport ↔ city center ETA, transit card, and buffer before first reservation.',
        icon: null
      }
    );
    infoCount = countInfo();
  }
  if (infoCount < 3 && !rows.some(c => c && c.role !== 'chrome' && c.componentType === 'navigation_turn_card')) {
    pushRow(
      'travel_floor_nav',
      'navigation_turn_card',
      'context',
      2,
      {
        label: city ? `On foot · ${city}` : 'Walking / directions',
        value: city
          ? `Next: toward old town · 180 m · arrive before your timed entry (${city}).`
          : 'Next turn + landmark cue toward your first booking — distances in meters.',
        icon: null
      }
    );
  }

  const total = touched + added;
  if (total) {
    plan.plannerNotes = plan.plannerNotes || {};
    plan.plannerNotes.travelDensity = { swapped: touched, added };
    console.log('[pipeline] runSelect: travel density — swapped ' + touched + ', added ' + added);
  }
  return total;
}

// ---------------------------------------------------------------------------
//  Personal travel / city-trip interface — explicit context contract
//  (ticket + fare + map + schedule + actions). Inference merges slots into
//  the planning packet; enforcement verifies coverage after select.
// ---------------------------------------------------------------------------

function isPersonalTravelInterfaceScenario(scenarioText, interpretation, planningPacket) {
  if (!isFlightTravelScenario(scenarioText, interpretation, planningPacket)) return false;
  const s = String(scenarioText || '');
  const goal =
    interpretation && interpretation.intent && interpretation.intent.primaryGoal
      ? String(interpretation.intent.primaryGoal)
      : '';
  const blob = `${s}\n${goal}`;
  const personalUi =
    /\b(personal(ized)?|tailored|custom\b|just\s+for\s+me|my\s+own\s+ui|퍼스널|맞춤|나만의|개인(?:화)?)\b/i.test(blob) &&
    /\b(interface|ui\b|screen|dashboard|hub|허브|화면|인터페이스)\b/i.test(blob);
  const tripFor =
    /(여행\s*(?:을|를)?\s*위한|for\s+(?:my\s+)?(?:\w+\s+)?trip|trip\s+to)/i.test(blob) &&
    /\b(personal|tailored|custom|퍼스널|맞춤|나만의)\b/i.test(blob);
  const koPersonalTrip =
    /(퍼스널|맞춤|나만의).*(여행|인터페이스|화면|대시보드|앱)/.test(blob) ||
    /여행\s*(?:을|를)?\s*위한.*(퍼스널|맞춤|나만의)/.test(blob);
  return !!(personalUi || tripFor || koPersonalTrip);
}

/** Scenario-aware copy for transit ticket / fare / schedule lines (reference-quality density). */
function personalTravelInterfaceCopyPack(scenarioText) {
  const city = tripLabelFromScenario(scenarioText);
  const s = String(scenarioText || '').toLowerCase();
  const nyc =
    /\b(new\s*york|nyc|manhattan|brooklyn|queens)\b/.test(s) ||
    (city && /^new york$/i.test(String(city).trim()));
  if (nyc) {
    return {
      ticketLabel: 'ACTIVE TICKET',
      ticketValue:
        '7-Day Unlimited MetroCard · Valid through May 12 · 2 rides used today',
      fareLabel: 'FARE & PASSES',
      fareValue: '$34 · 7-day unlimited · OMNY tap-to-pay or MetroCard · vs. pay-per-ride',
      scheduleLabel: 'TODAY · NEW YORK',
      scheduleValue:
        '10:00 AM Midtown meet · 2:00 PM MoMA entry · 7:30 PM dinner SoHo — confirm reservations',
      chipActions: [
        { label: 'OMNY balance', kind: 'secondary', icon: 'credit_card' },
        { label: 'Subway map', kind: 'secondary', icon: 'pin' },
        { label: 'Museum passes', kind: 'primary', icon: 'bookmark' }
      ]
    };
  }
  const c = city || 'your city';
  return {
    ticketLabel: 'ACTIVE TICKET',
    ticketValue: `${c} transit pass · validity window · rides / trips used today`,
    fareLabel: 'FARE & BUDGET',
    fareValue: `Day pass vs. stored value (${c}) · airport express · estimate weekly spend`,
    scheduleLabel: `TODAY · ${c.toUpperCase()}`,
    scheduleValue:
      'Morning reservation · afternoon slot · evening plans — use local times and addresses',
    chipActions: [
      { label: 'Transit tickets', kind: 'primary', icon: 'pin' },
      { label: 'City map', kind: 'secondary', icon: 'pin' },
      { label: 'Saved places', kind: 'secondary', icon: 'bookmark' }
    ]
  };
}

const PERSONAL_TRAVEL_INTERFACE_SLOT_BLUEPRINT = [
  {
    slot:          'personal_trip_transit_ticket',
    purpose:
      'Hero transit pass / ticket card: pass name, validity, usage (e.g. MetroCard, OMNY, city pass)',
    contentType:   'compound_summary',
    priority:      1,
    selectionHint:
      'Prefer reminder_card or widget-small with ACTIVE TICKET-style label—never a bare title chip.'
  },
  {
    slot:          'personal_trip_fare_pricing',
    purpose:       'Concrete fares: unlimited vs pay-per-ride, currency, budget line',
    contentType:   'compound_summary',
    priority:      2,
    selectionHint: 'Use input_summary_card or reminder_card with $ / local currency and pass names.'
  },
  {
    slot:          'personal_trip_today_schedule',
    purpose:       'Today’s time blocks: reservations, museums, dining with times',
    contentType:   'schedule_prose',
    priority:      1,
    selectionHint: 'calendar_summary_card with distinct morning / afternoon / evening lines.'
  },
  {
    slot:          'personal_trip_quick_actions',
    purpose:       'Trip affordances: reload pass, maps, tickets, saved POIs',
    contentType:   'chip_actions',
    priority:      2,
    selectionHint: 'action_chip_row with content.actions[] — travel verbs only.'
  }
];

/**
 * Stage 1–2 side: attach contract metadata + slot requirements so the selector
 * sees the same “reasoning” the validator will check.
 */
function attachPersonalTravelInterfaceContract(planningPacket, scenarioText, interpretation) {
  const pp = planningPacket;
  if (!pp || typeof pp !== 'object') return;
  if (!isPersonalTravelInterfaceScenario(scenarioText, interpretation, pp)) return;

  const pack = personalTravelInterfaceCopyPack(scenarioText);
  const city = tripLabelFromScenario(scenarioText) || 'destination';
  pp.scenarioContentContract = {
    intent:    'personal-travel-interface',
    cityHint:  city,
    facets:    ['transit_ticket', 'fare_pricing', 'map_route', 'today_schedule', 'quick_actions'],
    rationale:
      'Personal city-trip UI requires an active ticket/pass card, fare & pass economics, a map preview, ' +
      "today's concrete schedule, and quick trip actions—validated after component selection.",
    inferredCopy: pack
  };

  pp.slotRequirements = Array.isArray(pp.slotRequirements) ? pp.slotRequirements : [];
  const keyOf = slot => String(slot || '').trim().toLowerCase().replace(/\s+/g, '_');
  const existing = new Set(pp.slotRequirements.map(sr => keyOf(sr.slot)));
  PERSONAL_TRAVEL_INTERFACE_SLOT_BLUEPRINT.forEach(blueprint => {
    const k = keyOf(blueprint.slot);
    if (!existing.has(k)) {
      pp.slotRequirements.push({ ...blueprint });
      existing.add(k);
    }
  });

  pp.selectionConstraints = pp.selectionConstraints || {};
  pp.selectionConstraints.prefer = pp.selectionConstraints.prefer || [];
  const prefSet = new Set(pp.selectionConstraints.prefer.map(String));
  [
    'reminder_card',
    'calendar_summary_card',
    'input_summary_card',
    'eta_card',
    'navigation_turn_card',
    'action_chip_row',
    'widget-small',
    'btn-contained'
  ].forEach(p => prefSet.add(p));
  pp.selectionConstraints.prefer = Array.from(prefSet);

  console.log('[pipeline] scenarioContentContract: personal travel interface — slots merged');
}

function _planRowBlob(c) {
  return `${(c.content && c.content.label) || ''} ${(c.content && c.content.value) || ''}`.toLowerCase();
}

function _facetTransitTicket(plan) {
  return (plan.requiredComponents || []).some(c => {
    if (!c || c.role === 'chrome') return false;
    if (!['reminder_card', 'widget-small', 'input_summary_card'].includes(c.componentType)) return false;
    const t = _planRowBlob(c);
    return /active\s+ticket|metrocard|metro\s+card|omny|unlimited|\d+\s*-?\s*day|rides?\s+used|transit\s+pass|페리|패스|티켓|교통패스|탑승권/.test(t);
  });
}

function _facetFarePricing(plan) {
  return (plan.requiredComponents || []).some(c => {
    if (!c || c.role === 'chrome') return false;
    if (!['reminder_card', 'input_summary_card', 'widget-small'].includes(c.componentType)) return false;
    const t = _planRowBlob(c);
    return (
      /\$|€|£|usd|eur|gbp|won|원|\d+\s*(usd|eur)|fare|price|budget|pass\b|pay-per|티켓\s*가|요금|가격/.test(t) &&
      !/active\s+ticket|rides?\s+used/.test(t)
    );
  });
}

function _facetMapRoute(plan) {
  return (plan.requiredComponents || []).some(c => {
    if (!c || c.role === 'chrome') return false;
    if (['eta_card', 'navigation_turn_card'].includes(c.componentType)) return true;
    if (['calendar_summary_card', 'reminder_card', 'input_summary_card'].includes(c.componentType)) {
      const u = String((c.content && c.content.imageUrl) || '').trim();
      if (u) return true;
    }
    const t = _planRowBlob(c);
    return /map|route|지도|내비|directions|turn\s+in|\d+\s*m\b|\d+\s*km/.test(t);
  });
}

function _facetTodaySchedule(plan) {
  return (plan.requiredComponents || []).some(
    c => c && c.role !== 'chrome' && c.componentType === 'calendar_summary_card'
  );
}

function _facetQuickActions(plan) {
  const rows = (plan.requiredComponents || []).filter(c => c && c.role !== 'chrome');
  const chips = rows.some(c => c.componentType === 'action_chip_row');
  const btns = rows.filter(c => c.componentType === 'btn-contained' || c.componentType === 'btn-outlined');
  return chips || btns.length >= 2;
}

/**
 * Stage 3 tail: backfill missing contract facets, then emit violations for any gap.
 */
function enforcePersonalTravelInterfaceContract(plan, planningPacket, scenarioText, interpretation) {
  const violations = [];
  if (!plan || !Array.isArray(plan.requiredComponents)) return violations;
  if (!isPersonalTravelInterfaceScenario(scenarioText, interpretation, planningPacket)) return violations;

  const ui = planningPacket && planningPacket.uiState;
  if (!ui || ui.baseSurface !== 'app') return violations;

  const pack =
    (planningPacket.scenarioContentContract && planningPacket.scenarioContentContract.inferredCopy) ||
    personalTravelInterfaceCopyPack(scenarioText);
  const rows = plan.requiredComponents;
  const idGen = makeIdGen('contract-v');
  const injected = [];

  function inject(row) {
    rows.push(row);
    injected.push(row.slot || row.componentType);
  }

  if (!_facetTransitTicket(plan)) {
    inject({
      slot:          'contract_transit_ticket',
      componentType: 'reminder_card',
      variantHint:   'default',
      priority:      1,
      role:          'subject',
      content:       {
        label: pack.ticketLabel,
        value: pack.ticketValue,
        icon:  'credit_card'
      },
      constraints:   [],
      _source:       'scenario-content-contract'
    });
  }
  if (!_facetFarePricing(plan)) {
    inject({
      slot:          'contract_fare_pricing',
      componentType: 'input_summary_card',
      variantHint:   'default',
      priority:      2,
      role:          'context',
      content:       {
        label: pack.fareLabel,
        value: pack.fareValue,
        icon:  null
      },
      constraints:   [],
      _source:       'scenario-content-contract'
    });
  }
  if (!_facetTodaySchedule(plan)) {
    inject({
      slot:          'contract_today_schedule',
      componentType: 'calendar_summary_card',
      variantHint:   'default',
      priority:      1,
      role:          'subject',
      content:       {
        label: pack.scheduleLabel,
        value: pack.scheduleValue,
        icon:  'schedule'
      },
      constraints:   [],
      _source:       'scenario-content-contract'
    });
  }
  if (!_facetMapRoute(plan)) {
    inject({
      slot:          'contract_map_eta',
      componentType: 'eta_card',
      variantHint:   'default',
      priority:      2,
      role:          'context',
      content:       {
        label: `Map · ${tripLabelFromScenario(scenarioText) || 'Trip'}`,
        value: 'Route preview and POI context — map tile attached after finalize',
        icon:  null
      },
      constraints:   [],
      _source:       'scenario-content-contract'
    });
  }
  if (!_facetQuickActions(plan)) {
    inject({
      slot:          'contract_trip_chips',
      componentType: 'action_chip_row',
      variantHint:   'default',
      priority:      2,
      role:          'action',
      content:       {
        label: '',
        value: '',
        icon:  null,
        actions: pack.chipActions || []
      },
      constraints:   [],
      _source:       'scenario-content-contract'
    });
  }

  if (injected.length) {
    plan.plannerNotes = plan.plannerNotes || {};
    plan.plannerNotes.scenarioContentContractInjected = injected;
    console.log(
      '[pipeline] scenarioContentContract: injected ' + injected.length + ' row(s): ' + injected.join(', ')
    );
  }

  const contract = planningPacket.scenarioContentContract || {};
  const checks = [
    { id: 'transit_ticket', ok: _facetTransitTicket(plan), label: 'transit ticket / pass card' },
    { id: 'fare_pricing', ok: _facetFarePricing(plan), label: 'fare & pass pricing' },
    { id: 'map_route', ok: _facetMapRoute(plan), label: 'map or route context' },
    { id: 'today_schedule', ok: _facetTodaySchedule(plan), label: "today's schedule" },
    { id: 'quick_actions', ok: _facetQuickActions(plan), label: 'trip action chips or buttons' }
  ];
  checks.forEach(ch => {
    if (ch.ok) return;
    violations.push(
      buildViolation({
        id:       idGen(),
        stage:    'plan',
        ruleId:   'scenario_content_contract_gap',
        category: 'scenario-contract',
        severity: 'medium',
        status:   'auto-fixable',
        element:  ch.id,
        property: 'facet',
        actual:   'missing',
        expected: ch.label,
        message:  `Personal travel interface contract: still missing facet "${ch.label}" after enforcement.`,
        autoFix:  { possible: true, action: 're-run contract inject', value: ch.id }
      })
    );
  });

  if (planningPacket.scenarioContentContract) {
    planningPacket.scenarioContentContract.verifiedAt = 'runSelect';
    planningPacket.scenarioContentContract.facetStatus = checks.reduce((acc, x) => {
      acc[x.id] = x.ok;
      return acc;
    }, {});
  }

  return violations;
}

function isIoTAssistantScenario(scenarioText, interpretation, planningPacket) {
  const s = scenarioText || '';
  const goal = interpretation && interpretation.intent && interpretation.intent.primaryGoal
    ? String(interpretation.intent.primaryGoal)
    : '';
  const tags = _contextTagsMerged(interpretation, planningPacket).join(' ');
  const blob = `${s}\n${goal}\n${tags}`;
  const iotCore = /\b(iot|smart[\s-]?home|home\s*assistant|smartthings|homekit|matter|zigbee|z-wave)\b/i.test(blob);
  const deviceCore = /\b(light|lamp|bulb|switch|thermostat|ac|air\s*conditioner|heater|fan|humidifier|dehumidifier|curtain|blind|door\s*lock|garage|camera|speaker|tv|outlet|plug|vacuum|robot)\b/i.test(blob);
  const controlCore = /\b(turn\s*on|turn\s*off|dim|brightness|temperature|scene|automation|schedule|routine|room|device|power)\b/i.test(blob);
  return !!(iotCore || (deviceCore && controlCore));
}

function likelyIoTAssistantScenarioText(scenarioText) {
  return isIoTAssistantScenario(scenarioText, null, null);
}

function enrichPlanningPacketForGuidedCookingAssistant(planningPacket, scenarioText, interpretation) {
  const pp = planningPacket;
  if (!pp || typeof pp !== 'object') return pp;
  if (!isGuidedCookingAssistantScenario(scenarioText, interpretation, pp)) return pp;

  pp.slotRequirements = Array.isArray(pp.slotRequirements) ? pp.slotRequirements : [];
  pp.selectionConstraints = pp.selectionConstraints || {};
  pp.selectionConstraints.prefer = pp.selectionConstraints.prefer || [];
  pp.selectionConstraints.avoid = pp.selectionConstraints.avoid || [];
  pp.selectionConstraints.collapseFirst = pp.selectionConstraints.collapseFirst || [];

  const keyOf = slot => String(slot || '').trim().toLowerCase().replace(/\s+/g, '_');
  const existing = new Set(pp.slotRequirements.map(sr => keyOf(sr.slot)));

  COOKING_ASSISTANT_SLOT_BLUEPRINT.forEach(blueprint => {
    const k = keyOf(blueprint.slot);
    if (!existing.has(k)) {
      pp.slotRequirements.push({ ...blueprint });
      existing.add(k);
    }
  });

  const extraPrefer = [
    'reminder_card',
    'calendar_summary_card',
    'weather_glance_card',
    'message_summary_card',
    'media_control_bar',
    'action_chip_row',
    'quick_toggle_row',
    'btn-contained',
    'btn-outlined'
  ];
  const prefSet = new Set(pp.selectionConstraints.prefer.map(String));
  extraPrefer.forEach(p => prefSet.add(p));
  pp.selectionConstraints.prefer = Array.from(prefSet);

  const extraAvoid = [
    'Repeating identical input_summary_card for non-form content',
    'Gallery-style unrelated action_chip_row labels (Videos, Albums)'
  ];
  extraAvoid.forEach(line => {
    if (pp.selectionConstraints.avoid.indexOf(line) < 0) pp.selectionConstraints.avoid.push(line);
  });

  pp.uiState = pp.uiState || {};
  const tagList = Array.isArray(pp.uiState.contextTags) ? pp.uiState.contextTags.slice() : [];
  ['assistant-task', 'cooking-session'].forEach(t => {
    if (tagList.indexOf(t) < 0) tagList.push(t);
  });
  if (/\b(timer|stopwatch|countdown|simmer)\b/i.test(scenarioText || '') && tagList.indexOf('timer') < 0) {
    tagList.push('timer');
  }
  if (/\b(hands[\s-]?free|messy\s+hands|hands[\s-]?busy|voice\s+(tip|command))\b/i.test(scenarioText || '')
      && tagList.indexOf('hands-busy-cooking') < 0) {
    tagList.push('hands-busy-cooking');
  }
  pp.uiState.contextTags = tagList;

  pp.planningSummary = pp.planningSummary || {};
  if (!String(pp.planningSummary.primaryGoal || '').trim()) {
    pp.planningSummary.primaryGoal =
      'Guided cooking assistant: facets + active step + session controls + quick intents + CTAs.';
  }

  console.log('[pipeline] enrichPlanningPacket: guided cooking — slot count', pp.slotRequirements.length);
  return pp;
}

function buildGuidedCookingAssistantSelectorContract(scenarioText, planningPacket, interpretation) {
  if (!isGuidedCookingAssistantScenario(scenarioText, interpretation, planningPacket)) return '';

  return [
    '',
    '[DETERMINISTIC SLOT→COMPONENT CONTRACT — guided cooking / recipe assistant]',
    'Server merged behavioral slots into the packet. Map them to VOCABULARY ids:',
    '1) Recipe subject + facets → reminder_card | calendar_summary_card | weather_glance_card (not generic input_summary_card unless form recap).',
    '2) Active step prose → reminder_card | message_summary_card.',
    '3) Timers / session strip → media_control_bar.',
    '4) Voice / substitute / scaling / done → action_chip_row with content.actions[] (one object per chip).',
    '5) Binary prefs → quick_toggle_row.',
    '6) Substitution “why” → eta_card | message_summary_card.',
    '7) Next step / Start → btn-contained (+ btn-outlined secondary).',
    'When these slots exist: cover (1)+(3)+(4) and at least one of (7)—not passive cards only. Same componentType ≤2× except chrome.',
    ''
  ].join('\n');
}

function enrichPlanningPacketForFlightTravel(planningPacket, scenarioText, interpretation) {
  const pp = planningPacket;
  if (!pp || typeof pp !== 'object') return pp;
  if (!isFlightTravelScenario(scenarioText, interpretation, pp)) return pp;

  pp.slotRequirements = Array.isArray(pp.slotRequirements) ? pp.slotRequirements : [];
  pp.selectionConstraints = pp.selectionConstraints || {};
  pp.selectionConstraints.prefer = pp.selectionConstraints.prefer || [];
  pp.selectionConstraints.avoid = pp.selectionConstraints.avoid || [];
  pp.selectionConstraints.collapseFirst = pp.selectionConstraints.collapseFirst || [];

  const keyOf = slot => String(slot || '').trim().toLowerCase().replace(/\s+/g, '_');
  const existing = new Set(pp.slotRequirements.map(sr => keyOf(sr.slot)));

  FLIGHT_TRAVEL_SLOT_BLUEPRINT.forEach(blueprint => {
    const k = keyOf(blueprint.slot);
    if (!existing.has(k)) {
      pp.slotRequirements.push({ ...blueprint });
      existing.add(k);
    }
  });

  const flightPrefer = [
    'reminder_card',
    'calendar_summary_card',
    'eta_card',
    'navigation_turn_card',
    'action_chip_row',
    'btn-contained',
    'btn-outlined'
  ];
  const prefSet = new Set(pp.selectionConstraints.prefer.map(String));
  flightPrefer.forEach(p => prefSet.add(p));
  pp.selectionConstraints.prefer = Array.from(prefSet);

  const avoidLines = [
    'media_control_bar pretending to be music/podcast on an itinerary with no explicit audio user request',
    'input_summary_card as a substitute for itinerary prose when calendar_summary_card or reminder_card is available'
  ];
  avoidLines.forEach(line => {
    if (pp.selectionConstraints.avoid.indexOf(line) < 0) pp.selectionConstraints.avoid.push(line);
  });

  pp.uiState = pp.uiState || {};
  const tagList = Array.isArray(pp.uiState.contextTags) ? pp.uiState.contextTags.slice() : [];
  ['commute', 'schedule', 'navigation'].forEach(t => {
    if (tagList.indexOf(t) < 0) tagList.push(t);
  });
  pp.uiState.contextTags = tagList;

  pp.planningSummary = pp.planningSummary || {};
  if (!String(pp.planningSummary.primaryGoal || '').trim()) {
    pp.planningSummary.primaryGoal =
      'Travel / trip assistant: rich itinerary (schedule, transit, maps, reservations) + travel actions—not a thin title with only playback and one CTA.';
  }

  console.log('[pipeline] enrichPlanningPacket: flight/travel — slot count', pp.slotRequirements.length);
  return pp;
}

function enrichPlanningPacketForIoTAssistant(planningPacket, scenarioText, interpretation) {
  const pp = planningPacket;
  if (!pp || typeof pp !== 'object') return pp;
  if (!isIoTAssistantScenario(scenarioText, interpretation, pp)) return pp;

  pp.slotRequirements = Array.isArray(pp.slotRequirements) ? pp.slotRequirements : [];
  pp.selectionConstraints = pp.selectionConstraints || {};
  pp.selectionConstraints.prefer = pp.selectionConstraints.prefer || [];
  pp.selectionConstraints.avoid = pp.selectionConstraints.avoid || [];
  pp.selectionConstraints.collapseFirst = pp.selectionConstraints.collapseFirst || [];

  const keyOf = slot => String(slot || '').trim().toLowerCase().replace(/\s+/g, '_');
  const existing = new Set(pp.slotRequirements.map(sr => keyOf(sr.slot)));
  IOT_ASSISTANT_SLOT_BLUEPRINT.forEach(blueprint => {
    const k = keyOf(blueprint.slot);
    if (!existing.has(k)) {
      pp.slotRequirements.push({ ...blueprint });
      existing.add(k);
    }
  });

  const prefer = [
    'reminder_card', 'input_summary_card', 'action_chip_row', 'quick_toggle_row',
    'media_control_bar', 'widget-small', 'list-item', 'btn-contained', 'btn-outlined'
  ];
  const prefSet = new Set(pp.selectionConstraints.prefer.map(String));
  prefer.forEach(p => prefSet.add(p));
  pp.selectionConstraints.prefer = Array.from(prefSet);

  const avoids = [
    'Generic placeholder labels like Device 1 / Room 1',
    'Purely decorative chips with no control meaning',
    'Single-card output without control + telemetry pairing'
  ];
  avoids.forEach(line => {
    if (pp.selectionConstraints.avoid.indexOf(line) < 0) pp.selectionConstraints.avoid.push(line);
  });

  pp.uiState = pp.uiState || {};
  const tagList = Array.isArray(pp.uiState.contextTags) ? pp.uiState.contextTags.slice() : [];
  ['assistant-task', 'iot-control'].forEach(t => {
    if (tagList.indexOf(t) < 0) tagList.push(t);
  });
  pp.uiState.contextTags = tagList;

  pp.planningSummary = pp.planningSummary || {};
  if (!String(pp.planningSummary.primaryGoal || '').trim()) {
    pp.planningSummary.primaryGoal =
      'IoT assistant: room/device context + state + adjustable controls + scenes + telemetry + safety action.';
  }
  console.log('[pipeline] enrichPlanningPacket: iot assistant — slot count', pp.slotRequirements.length);
  return pp;
}

function buildFlightTravelSelectorContract(scenarioText, planningPacket, interpretation) {
  if (!isFlightTravelScenario(scenarioText, interpretation, planningPacket)) return '';

  return [
    '',
    '[DETERMINISTIC SLOT→COMPONENT CONTRACT — flight / boarding / trip / itinerary assistant]',
    'Map travel behavioral slots to VOCABULARY ids:',
    '1) itinerary + gate + boarding window → reminder_card AND/OR calendar_summary_card (subject) with REAL city pair or flight # + LOCAL date/times.',
    '2) mins to gate / security cue → eta_card.',
    '3) optional short turn cue → navigation_turn_card.',
    '4) travel-only chips → action_chip_row (offline pass, lounge, directions, seat)—never recipe Voice tip / Substitute / Scale.',
    '5) boarding CTA → btn-contained (+ btn-outlined) (“Open boarding pass”, “Add to Wallet”, “Navigate”).',
    'FORBID media_control_bar unless the user scenario explicitly names audio playback OR you show a GATE countdown (timer semantics).',
    ''
  ].join('\n');
}

function buildPersonalTravelInterfaceSelectorContract(scenarioText, planningPacket, interpretation) {
  if (!isPersonalTravelInterfaceScenario(scenarioText, interpretation, planningPacket)) return '';

  return [
    '',
    '[SCENARIO CONTENT CONTRACT — personal / tailored city-trip interface]',
    'The planning packet includes server-inferred scenarioContentContract. Cover EVERY facet as a DISTINCT requiredComponents row:',
    '1) Transit ticket / pass — reminder_card or widget-small: ACTIVE TICKET headline, pass name, validity end date, rides used today (or trip-day equivalent).',
    '2) Fare & pricing — input_summary_card or reminder_card: currency, unlimited vs pay-per-ride, realistic amounts (e.g. OMNY / MetroCard).',
    "3) Map / route — eta_card or navigation_turn_card with city/route semantics; map preview may be attached server-side.",
    "4) Today's schedule — calendar_summary_card with morning / afternoon / evening blocks and venue names.",
    '5) Quick trip actions — action_chip_row (reload, maps, passes) plus btn-contained primary (e.g. Continue / Open wallet).',
    'Do not collapse these into one vague card; the validation stage checks each facet.',
    ''
  ].join('\n');
}

function buildIoTAssistantSelectorContract(scenarioText, planningPacket, interpretation) {
  if (!isIoTAssistantScenario(scenarioText, interpretation, planningPacket)) return '';
  return [
    '',
    '[DETERMINISTIC SLOT→COMPONENT CONTRACT — IoT / smart-home assistant]',
    'Map server slot requirements to concrete control-oriented components:',
    '1) room + device headline → reminder_card or input_summary_card (real room/device names).',
    '2) current mode/state → reminder_card | message_summary_card (explicit mode + level).',
    '3) adjustable control → vertical-slider OR media_control_bar (for scrub-like control).',
    '4) scene shortcuts → action_chip_row with content.actions[] (Sleep/Reading/Away/etc).',
    '5) binary toggles → quick_toggle_row (only for true on/off controls).',
    '6) telemetry → widget-small | list-item | input_summary_card with numbers (temp/humidity/power).',
    '7) safety override → btn-contained (+ optional btn-outlined).',
    'At minimum include: one context/subject card + one control primitive + one telemetry element + one action.',
    'Avoid generic labels ("Device 1", "Option A"). Use concrete IoT semantics.',
    ''
  ].join('\n');
}

const EMBEDDINGS_PATH = path.join(__dirname, 'figma-refs', 'component_embeddings.json');
let COMPONENT_EMBEDDINGS = null;
(function _loadComponentEmbeddings() {
  try {
    if (!fs.existsSync(EMBEDDINGS_PATH)) {
      console.warn('[pipeline] component_embeddings.json not found — RAG shortlist disabled. Run: node scripts/build_component_embeddings.js');
      return;
    }
    const raw = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, 'utf8'));
    if (!raw || !raw.components) return;
    // Pre-compute L2 norms for cosine similarity. We need the norm of each
    // component vector (query norm is computed once per call).
    Object.keys(raw.components).forEach(id => {
      const c = raw.components[id];
      if (!Array.isArray(c.embedding)) return;
      let s = 0;
      for (let i = 0; i < c.embedding.length; i++) s += c.embedding[i] * c.embedding[i];
      c._norm = Math.sqrt(s);
    });
    COMPONENT_EMBEDDINGS = raw;
    console.log(`[pipeline] embeddings loaded: ${Object.keys(raw.components).length} components, ${raw.dim}d, model=${raw.model}`);
  } catch (e) {
    console.warn('[pipeline] embeddings load failed:', e.message);
  }
})();

// Cosine similarity between query vector q (norm not pre-computed) and a
// component vector with pre-computed `_norm`. Returns 0 on shape mismatch.
function _cosine(q, qNorm, vec, vecNorm) {
  if (!Array.isArray(q) || !Array.isArray(vec) || q.length !== vec.length) return 0;
  let dot = 0;
  for (let i = 0; i < q.length; i++) dot += q[i] * vec[i];
  const denom = qNorm * vecNorm;
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
//  RENDERABLE_COMPONENT_IDS — the set of componentIds the client renderer
//  (app/scenes.js + app/templates.js + app/surface-layout.js) actually has
//  visual templates for. The selector + RAG shortlist MUST stay inside this
//  set, otherwise we get "(no template registered)" placeholder cards on
//  the device frame which trip width / order validators and surface as
//  multiple violations per render.
//
//  Source of truth (must match these maps in the client):
//   - templates                       (app/templates.js, line 10)
//   - PIPELINE_FALLBACK_TEMPLATES     (app/templates.js, line 60)
//   - PIPELINE_CHROME_ATOMIC_ROLE     (app/scenes.js,    line 695)
//   - PIPELINE_BODY_ATOMIC_ROLE       (app/scenes.js,    line 708)
//
//  Updating this list: when you add a new id to ANY of those four maps,
//  add it here too. The set is intentionally explicit so a missing
//  renderer is a hard failure on the server side, not a silent placeholder
//  card on the device.
// ---------------------------------------------------------------------------
const RENDERABLE_COMPONENT_IDS = new Set([
  // ─── chrome (PIPELINE_CHROME_ATOMIC_ROLE) ───
  'container.status-bar-app',
  'status-bar.default',
  'container.header',
  'container.nav-gestures-dark',
  'container.nav-buttons-light',
  'dialog.nav-gesture-bar',
  // ─── body atomics (PIPELINE_BODY_ATOMIC_ROLE) ───
  'input_summary_card',
  'weather_glance_card',
  'calendar_summary_card',
  'message_summary_card',
  'eta_card',
  'reminder_card',
  'media_control_bar',
  'now-bar.media-player',
  'now-bar.dual-line',
  'now-bar.single-line',
  'now-bar.charging',
  'navigation_turn_card',
  'action_chip_row',
  'quick_toggle_row',
  'notification-card',
  'notification.ai-regular',
  'lock-screen.clock',
  'lock-screen.weather-date',
  'lock-screen.shortcut-circle',
  'dialog.icon-grid-box',
  'dialog.browser-top-bar',
  'dialog.website-share-header',
  // ─── editor primitives with full templates (templates.js) ───
  'btn-contained', 'btn-outlined', 'btn-flat', 'fab',
  'switch', 'checkbox', 'radio', 'chip', 'input', 'search',
  'appbar', 'bottomnav', 'pill-tab', 'tab-bar',
  'card', 'list-item', 'dialog', 'snackbar', 'divider', 'badge',
  'status-bar', 'now-bar', 'qs-toggle', 'qs-grid',
  'media-card', 'widget-small', 'keyboard'
]);

function isRenderableComponentId(id) {
  return RENDERABLE_COMPONENT_IDS.has(id);
}

// Retrieve top-K component IDs by cosine similarity to the query embedding.
// Returns [] if embeddings aren't loaded (caller falls back to full vocab).
//
// FILTER: only renderable IDs are returned. The RAG corpus contains 92
// registry components but only ~45 of those have a client renderer; the
// rest produce "(no template registered)" placeholder cards on the device
// frame and trip multiple validators. Filtering here makes the selector
// physically incapable of picking a non-renderable id.
function retrieveTopKComponentIds(queryEmbedding, k) {
  if (!COMPONENT_EMBEDDINGS || !Array.isArray(queryEmbedding)) return [];
  const components = COMPONENT_EMBEDDINGS.components;
  let qNorm = 0;
  for (let i = 0; i < queryEmbedding.length; i++) qNorm += queryEmbedding[i] * queryEmbedding[i];
  qNorm = Math.sqrt(qNorm);
  const scored = [];
  Object.keys(components).forEach(id => {
    if (!RENDERABLE_COMPONENT_IDS.has(id)) return;     // <- filter
    const c = components[id];
    if (!c || !Array.isArray(c.embedding)) return;
    const score = _cosine(queryEmbedding, qNorm, c.embedding, c._norm || 1);
    scored.push({ id, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => s.id);
}

// ============================================================================
//  DESIGN-SYSTEM KNOWLEDGE BASE
//  ---------------------------------------------------------------------------
//  Reads DESIGN.md / GENUI-PRINCIPLES.md / ORCHESTRATION.md / evolve.md at
//  module load, parses them into a { slug: body } map per file, and exposes
//  buildPromptContext(stage, uiState) which returns a focused slice suitable
//  for injecting into the user-message of an LLM call. Each stage gets only
//  the sections that matter to it so the LLM isn't drowned in principles.
// ============================================================================

function _safeRead(name) {
  try { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }
  catch (_) { return ''; }
}

function _slug(s) {
  return (s || '')
    .replace(/^\s*\d+\.\s*/, '')        // strip leading "1. "
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Split markdown hierarchically. A ## parent's body includes everything up
// to the next ## — i.e. its own content PLUS all ### children verbatim.
// Each ### child is also keyed independently for fine-grained lookups.
// This way `vertical_stacking_rules` returns the full chapter, while the
// narrower `component_to_component_gaps` key still resolves to just that.
function _parseSections(md) {
  const sections = {};
  if (!md) return sections;
  let h2Key = null, h2Lines = [];
  let h3Key = null, h3Lines = [];
  const closeH3 = () => {
    if (h3Key) sections[h3Key] = h3Lines.join('\n').trim();
    h3Key = null; h3Lines = [];
  };
  const closeH2 = () => {
    closeH3();
    if (h2Key) sections[h2Key] = h2Lines.join('\n').trim();
    h2Key = null; h2Lines = [];
  };
  for (const line of md.split('\n')) {
    const m2 = line.match(/^## (.+)$/);
    const m3 = line.match(/^### (.+)$/);
    if (m2) {
      closeH2();
      h2Key = _slug(m2[1]);
      h2Lines = [line];
    } else if (m3) {
      closeH3();
      h3Key = _slug(m3[1]);
      h3Lines = [line];
      h2Lines.push(line);
    } else {
      if (h3Key) { h3Lines.push(line); h2Lines.push(line); }
      else if (h2Key) h2Lines.push(line);
    }
  }
  closeH2();
  return sections;
}

// Parse evolve.md into entries with { id, title, type, severity, scenario,
// issue, fix, constraint, date }. The "constraint" is the reusable rule.
function _parseEvolve(md) {
  if (!md) return [];
  const out = [];
  let curr = null;
  for (const line of md.split('\n')) {
    const mEntry = line.match(/^### (E\d+):\s*(.+)$/);
    if (mEntry) {
      if (curr) out.push(curr);
      curr = { id: mEntry[1], title: mEntry[2].trim() };
      continue;
    }
    if (!curr) continue;
    const mField = line.match(/^-\s*\*\*(\w+)\*\*:\s*(.+)$/);
    if (mField) curr[mField[1].toLowerCase()] = mField[2].trim();
  }
  if (curr) out.push(curr);
  return out;
}

const DESIGN_SECTIONS = _parseSections(_safeRead('DESIGN.md'));
const GENUI_SECTIONS  = _parseSections(_safeRead('GENUI-PRINCIPLES.md'));
const ORCH_SECTIONS   = _parseSections(_safeRead('ORCHESTRATION.md'));
const EVOLVE_ENTRIES  = _parseEvolve(_safeRead('evolve.md'));

// Cap any one section so a single massive chapter can't drown a prompt.
const MAX_SECTION_CHARS = 2000;

function _take(source, key) {
  const s = source[key];
  if (!s) return null;
  return s.length > MAX_SECTION_CHARS
    ? s.slice(0, MAX_SECTION_CHARS) + '\n[...truncated]'
    : s;
}

// Cached compact token reference from figma-refs/design_rules.json. Built
// once at module load. Referenced by the composer prompt so the LLM has
// the exact numeric token values (radius scale, spacing scale, typography
// scale) it should align padding / gap / radius decisions to.
let _DESIGN_TOKEN_BLOCK = '';
(function _buildDesignTokenBlockOnce() {
  let rules = null;
  try { rules = require('./figma-refs/design_rules.json'); }
  catch (e) { return; /* design_rules.json missing — composer just goes without */ }
  const lines = ['## Design tokens (from design_rules.json — exact values; align padding/gap/radius/typography to these)'];

  if (rules.radius) {
    const items = Object.keys(rules.radius)
      .filter(k => !k.startsWith('_'))
      .map(k => k + '=' + rules.radius[k]);
    lines.push('- radius: ' + items.join(', '));
    if (rules.radius._usage) lines.push('  usage: ' + rules.radius._usage);
  }
  if (rules.spacing) {
    const items = Object.keys(rules.spacing)
      .filter(k => !k.startsWith('_'))
      .map(k => k + '=' + rules.spacing[k]);
    lines.push('- spacing: ' + items.join(', '));
    if (rules.spacing._usage) lines.push('  usage: ' + rules.spacing._usage);
  }
  if (rules.typography && rules.typography.size) {
    const sizes = Object.keys(rules.typography.size)
      .map(k => k + '=' + rules.typography.size[k]);
    lines.push('- typography.size: ' + sizes.join(', '));
  }
  if (rules.typography && rules.typography.weight) {
    const weights = Object.keys(rules.typography.weight)
      .map(k => k + '=' + rules.typography.weight[k]);
    lines.push('- typography.weight: ' + weights.join(', '));
  }
  if (rules.glass && rules.glass._usage) {
    lines.push('- glass: ' + rules.glass._usage);
  }
  _DESIGN_TOKEN_BLOCK = lines.join('\n');
})();

function _buildDesignTokenBlock() {
  return _DESIGN_TOKEN_BLOCK;
}

// Cached refinement-rules block — pulled from figma-refs/refinement_rules.json.
// Each rule encodes a previously-observed mistake + how it should be fixed.
// Injecting these into the composer prompt as "common mistakes to avoid"
// nudges the LLM to produce the corrected pattern up-front, instead of
// requiring the rule-engine to fix it post-hoc.
let _REFINEMENT_RULES_BLOCK = '';
(function _buildRefinementRulesBlockOnce() {
  let bundle = null;
  try { bundle = require('./figma-refs/refinement_rules.json'); }
  catch (e) { return; }
  const rules = (bundle && Array.isArray(bundle.rules))
    ? bundle.rules.filter(r => r.enabled !== false)
    : [];
  if (!rules.length) return;
  const lines = ['## Refinement rules (anti-patterns previously caught — produce the corrected pattern from the start)'];
  rules.forEach(r => {
    const desc = r.description || r.id;
    lines.push('- [' + r.id + '] ' + desc);
  });
  _REFINEMENT_RULES_BLOCK = lines.join('\n');
})();

function _buildRefinementRulesBlock() {
  return _REFINEMENT_RULES_BLOCK;
}

// ---------------------------------------------------------------------------
//  COMPONENT DESCRIPTIONS for the planner prompt
//  Hand-authored overrides for the ~24 most-used components; the remaining
//  ~68 are auto-derived from orchestration_type + allowed_contexts at boot.
// ---------------------------------------------------------------------------

const COMPONENT_DESCRIPTIONS = {
  'btn-contained':       'Filled primary action button — use for CTAs, form submits, and positive next-step actions.',
  'btn-outlined':        'Outlined secondary action button — use for alternate, cancel-adjacent, or dismissable actions.',
  'btn-flat':            'Text-only ghost button — use for low-emphasis inline actions (dismiss, view more).',
  'fab':                 'Floating action button — single primary in-context action (compose, add, scan).',
  'switch':              'On/off toggle for a setting with instant effect.',
  'checkbox':            'Multi-select boolean option; respects pair-gap rules.',
  'radio':               'Single-select from a short list (≤ 5 options).',
  'chip':                'Filter / choice / tag — prefer for multi-select of short labels.',
  'input':               'Single-line text input field.',
  'search':              'Search bar with placeholder and icon; can collapse into a pill.',
  'status-bar':          'System status bar (time, battery, signal). Always first — surface chrome.',
  'appbar':              'App top bar with title, back/menu, and action icons.',
  'bottomnav':           'Bottom navigation bar with 3–5 destinations; anchored last.',
  'pill-tab':            'Pill-shaped tab bar for inline navigation inside content.',
  'tab-bar':             'Content-level tab segmentation.',
  'card':                'Surface-contained content block; hosts title, body, actions.',
  'list-item':           'One row of a vertical list (title, optional subtitle + trailing action).',
  'dialog':              'Modal overlay with title, body, and 1–3 actions; blocks underlying surface.',
  'snackbar':            'Transient ambient notification; auto-dismiss or single action.',
  'notification-card':   'Notification payload (avatar, title, body, actions); stratify per P9.',
  'media-card':          'Current-media surface: album art, track info, playback controls.',
  'now-bar':             'Compact ambient widget for in-progress activity (playing, call, timer).',
  'weather_glance_card': 'Small one-line weather summary (temperature + condition icon).',
  'qs-toggle':           'Quick-Settings tile toggle (Wi-Fi, Bluetooth, rotation, etc.).'
};

// Human-readable hint per orchestration_type for auto-description fallback.
const ORCH_TYPE_HINT = {
  button: 'Button', fab: 'Floating action button', switch: 'Toggle switch',
  chip: 'Chip (tag / filter / choice)', input: 'Text input',
  'search-bar': 'Search field', 'search-bar-ai': 'AI-powered search field',
  card: 'Content card', 'list-item': 'List row', dialog: 'Modal dialog',
  'now-bar': 'Now-bar ambient widget', 'now-bar-alert': 'Now-bar alert / status widget',
  'lock-widget': 'Lock-screen widget', 'lock-clock': 'Lock-screen clock block',
  'lock-weather-date': 'Lock-screen weather + date line',
  'lock-shortcut': 'Lock-screen quick shortcut chip',
  'qs-toggle': 'Quick-Settings toggle',
  'quick-toggle-half': 'Quick-Settings half-width toggle',
  'quick-toggle-single': 'Quick-Settings single toggle',
  'quick-shortcut-half': 'Quick-Settings half-width shortcut',
  'quick-settings-header': 'Quick-Settings header row',
  'vertical-slider': 'Quick-Settings vertical slider (brightness / volume)',
  'smartthings-rollup': 'SmartThings device rollup card',
  'system-status': 'System status bar',
  'inline-live-activity': 'Live-activity chip inline in status bar',
  'status-bar': 'System status bar', appbar: 'App top bar',
  bottomnav: 'Bottom navigation bar', 'tab-bar': 'Tab bar',
  'media-card': 'Media player card', 'media-player-tile': 'Media player tile',
  'notification-card': 'Notification card',
  'ai-notification': 'AI-generated notification',
  'live-notification': 'Live updating notification',
  'stacked-notification': 'Stacked notification group',
  'section-label': 'Section label / divider label',
  'dialog-header': 'Dialog header', 'browser-top-bar': 'Browser top bar',
  'icon-picker-grid': 'Icon picker grid (inside dialog)',
  'page-indicator': 'Paginated screens indicator',
  'home-gesture-bar': 'Home gesture bar', 'modal-dim': 'Modal dim-screen overlay',
  'button-primary': 'Primary (accent) button', 'button-ai': 'Galaxy AI styled button',
  'button-inline': 'Inline small header button',
  'app-shell': 'App shell container', 'content-area': 'App content area container',
  'app-header': 'App header container', 'app-status-bar': 'App-level status bar',
  'nav-bar-gestures': 'Gesture-style nav bar', 'nav-bar-buttons': 'Three-button nav bar',
  'card-toggle': 'Card containing a toggle row',
  'card-menu': 'Card menu item', 'card-menu-body': 'Card menu item body',
  'card-subheading': 'Card subheading row',
  'card-navigation': 'Chevron-navigation card',
  'card-radio': 'Radio-selection card',
  'card-stacked-group': 'Stacked card group',
  'modal-dialog-surface': 'Modal dialog surface',
  content: 'Content element', notification: 'Notification', widget: 'Widget'
};

function _cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function _autoDescription(c) {
  const base = ORCH_TYPE_HINT[c.orchestration_type]
            || (_cap(c.category || '') + ' component');
  const ctxs = Array.isArray(c.allowed_contexts) && c.allowed_contexts.length
    ? ' · contexts: ' + c.allowed_contexts.slice(0, 5).join('/')
    : '';
  return base + ctxs + '.';
}

// Pre-build the component vocabulary block once at module load.
let COMPONENT_DESCRIPTIONS_BLOCK = '(component registry unavailable)';
(function _buildComponentDescBlock() {
  if (!REGISTRY || !REGISTRY.components) return;
  const allowed = (REGISTRY.vocabulary && REGISTRY.vocabulary.semantic_allowed_types)
               || (REGISTRY.vocabulary && REGISTRY.vocabulary.allowed_types)
               || Object.keys(REGISTRY.components || {});
  const byCat = {};
  allowed.forEach(id => {
    const c = REGISTRY.components[id];
    if (!c) return;
    const cat = c.category || 'other';
    (byCat[cat] = byCat[cat] || []).push({ id, c });
  });
  const lines = [
    'COMPONENT VOCABULARY (select only these IDs; grouped by category).',
    'Each entry shows id [variants] [tokens]: description.',
    '- variants is the CLOSED set of values your variant_hint may take.',
    '- tokens are the design tokens the component uses (radius/background/',
    '  text_style); align your composer padding/gap decisions to these.',
    'Pick "default" or omit variant when no specific one fits.'
  ];
  // Helper: format a component's tokens object as a compact "[tokens: …]"
  // suffix. Skips when tokens is empty so simple components stay readable.
  function _fmtTokens(c) {
    const t = c && c.tokens;
    if (!t || typeof t !== 'object') return '';
    const parts = [];
    if (t.radius)            parts.push('radius=' + t.radius);
    if (t.background)        parts.push('bg=' + t.background);
    if (t.text_style_title)  parts.push('text=' + t.text_style_title);
    if (t.text_style)        parts.push('text=' + t.text_style);
    if (t.gap)               parts.push('gap=' + t.gap);
    if (!parts.length) return '';
    return ' [tokens: ' + parts.join(', ') + ']';
  }
  // Description-source priority chain (most specific → most generic):
  //   1. c.description + c.purpose from the registry (PDF-enriched, best)
  //   2. COMPONENT_DESCRIPTIONS[id]   — designer-curated overrides
  //   3. _autoDescription(c)          — auto-derived from category/contexts
  function _composeDesc(id, c) {
    if (c.description) {
      // Combine description (what it looks like) + purpose (when to use)
      // into one dense line for the vocabulary block.
      return c.purpose
        ? c.description + ' Use when: ' + c.purpose
        : c.description;
    }
    return COMPONENT_DESCRIPTIONS[id] || _autoDescription(c);
  }
  // Format a component's typical_content as a compact, indented example
  // block. Limit to 3 examples max per component to keep the vocabulary
  // prompt compact while still giving the LLM concrete reference text.
  // The LLM uses these as a template for label/value generation, so the
  // generic-placeholder problem ("Personalized guidance / Adaptations
  // based on...") gets resolved at the source rather than via post-hoc
  // validators.
  function _fmtTypicalContent(c) {
    const tc = c && c.typical_content;
    if (!tc || !Array.isArray(tc.examples) || tc.examples.length === 0) return '';
    const examples = tc.examples.slice(0, 3).map(ex => {
      const scn   = ex.scenario ? ex.scenario + ': ' : '';
      const label = ex.label ? '"' + ex.label + '"' : '""';
      const val   = ex.value ? '"' + ex.value + '"' : '""';
      return '    · ' + scn + 'label=' + label + ', value=' + val;
    });
    const guidance = tc.guidance ? '\n    Guidance: ' + tc.guidance : '';
    return '\n    Content examples:\n' + examples.join('\n') + guidance;
  }
  Object.keys(byCat).sort().forEach(cat => {
    lines.push('');
    lines.push('-- ' + cat + ' --');
    byCat[cat].forEach(({ id, c }) => {
      const desc = _composeDesc(id, c);
      const states = Array.isArray(c.states) && c.states.length
        ? ' [variants: ' + c.states.join(', ') + ']'
        : ' [variants: default]';
      const tokens = _fmtTokens(c);
      const examples = _fmtTypicalContent(c);
      lines.push('  ' + id + states + tokens + ': ' + desc + examples);
    });
  });
  COMPONENT_DESCRIPTIONS_BLOCK = lines.join('\n');
})();

// ---------------------------------------------------------------------------
//  buildShortlistedVocabBlock(ids)
//  Returns a vocabulary block formatted like COMPONENT_DESCRIPTIONS_BLOCK but
//  containing only the requested IDs, grouped by category. Used by the
//  Stage 3 RAG shortlist path: pass the top-K retrieved IDs (plus mandatory
//  ones) and get a focused block to put in the user message.
//  Falls back to the full block if IDs is empty.
// ---------------------------------------------------------------------------
function buildShortlistedVocabBlock(ids) {
  if (!REGISTRY || !REGISTRY.components || !Array.isArray(ids) || ids.length === 0) {
    return COMPONENT_DESCRIPTIONS_BLOCK;
  }
  const byCat = {};
  ids.forEach(id => {
    const c = REGISTRY.components[id];
    if (!c) return;
    const cat = c.category || 'other';
    (byCat[cat] = byCat[cat] || []).push({ id, c });
  });
  // Same formatters as _buildComponentDescBlock — kept in sync intentionally.
  function _fmtTokens(c) {
    const t = c && c.tokens;
    if (!t || typeof t !== 'object') return '';
    const parts = [];
    if (t.radius)            parts.push('radius=' + t.radius);
    if (t.background)        parts.push('bg=' + t.background);
    if (t.text_style_title)  parts.push('text=' + t.text_style_title);
    if (t.text_style)        parts.push('text=' + t.text_style);
    if (t.gap)               parts.push('gap=' + t.gap);
    if (!parts.length) return '';
    return ' [tokens: ' + parts.join(', ') + ']';
  }
  function _composeDesc(id, c) {
    if (c.description) {
      return c.purpose ? c.description + ' Use when: ' + c.purpose : c.description;
    }
    return COMPONENT_DESCRIPTIONS[id] || _autoDescription(c);
  }
  function _fmtTypicalContent(c) {
    const tc = c && c.typical_content;
    if (!tc || !Array.isArray(tc.examples) || tc.examples.length === 0) return '';
    const examples = tc.examples.slice(0, 3).map(ex => {
      const scn   = ex.scenario ? ex.scenario + ': ' : '';
      const label = ex.label ? '"' + ex.label + '"' : '""';
      const val   = ex.value ? '"' + ex.value + '"' : '""';
      return '    · ' + scn + 'label=' + label + ', value=' + val;
    });
    const guidance = tc.guidance ? '\n    Guidance: ' + tc.guidance : '';
    return '\n    Content examples:\n' + examples.join('\n') + guidance;
  }
  const lines = [
    'COMPONENT VOCABULARY (RAG shortlist — select only from these IDs).',
    'Each entry: id [variants] [tokens]: description.',
    `Shortlist size: ${ids.length} of ${Object.keys(REGISTRY.components).length} registry entries.`
  ];
  Object.keys(byCat).sort().forEach(cat => {
    lines.push('');
    lines.push('-- ' + cat + ' --');
    byCat[cat].forEach(({ id, c }) => {
      const desc = _composeDesc(id, c);
      const states = Array.isArray(c.states) && c.states.length
        ? ' [variants: ' + c.states.join(', ') + ']'
        : ' [variants: default]';
      const tokens = _fmtTokens(c);
      const examples = _fmtTypicalContent(c);
      lines.push('  ' + id + states + tokens + ': ' + desc + examples);
    });
  });
  return lines.join('\n');
}

// Focused variant reference for the composer — only the components actually
// selected by Step 3, with their valid variant set. Keeps the composer
// prompt small while making `invalid_variant` violations physically
// impossible (LLM can't emit a variant outside the closed set if it's
// staring at the closed set).
function buildVariantReference(componentIds) {
  if (!REGISTRY || !REGISTRY.components || !Array.isArray(componentIds)) return '';
  const seen = new Set();
  const lines = [];
  componentIds.forEach(id => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const c = REGISTRY.components[id];
    if (!c) return;
    const states = Array.isArray(c.states) && c.states.length
      ? c.states.join(', ')
      : 'default';
    lines.push('  ' + id + ': [' + states + ']');
  });
  if (!lines.length) return '';
  return 'VALID VARIANTS for the selected components — every children[].variant MUST be one of these (or "default"):\n' + lines.join('\n');
}

// Per-surface mandatory components from generator_memory.json. The LLM
// selector silently drops chrome (#7 "bare lock" → empty layout) because
// nothing in its prompt tells it some components are non-negotiable.
// This block is appended to the selector's user message so it knows what
// it cannot omit.
function buildMandatoryComponentsBlock(uiState) {
  if (!DesignMemory || !DesignMemory.generatorMemory) return '';
  const surface = uiState && uiState.baseSurface;
  if (!surface) return '';
  const screens = DesignMemory.generatorMemory.screens || {};
  const screen  = screens[surface];
  if (!screen) return '';
  const mand = screen.mandatoryComponents
            || screen.mandatory_components
            || [];
  if (!mand.length) return '';
  const lines = [
    'MANDATORY for surface "' + surface + '" — you MUST include each of',
    'these as a requiredComponent with priority 1. Never skip them, even',
    'when the scenario sounds minimal ("bare", "clean", "just the X"):'
  ];
  mand.forEach(id => lines.push('  - ' + id));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
//  CONTEXT TAG VOCABULARY
//  ---------------------------------------------------------------------------
//  Free-form scenario signals the interpreter can emit on uiState.context_tags.
//  Read by generator.js at render time to make scenario-aware variant choices
//  (which Now Bar to surface, whether to show a weather widget, etc.).
//  The list below is the *canonical* vocabulary; the LLM may invent additional
//  tags for unique scenarios — they will pass through normalization unchanged
//  but won't trigger built-in renderer behaviors unless the generator knows
//  about them. Prefix tags with "<feature>:<value>" for explicit overrides.
// ---------------------------------------------------------------------------

const CONTEXT_TAG_VOCABULARY = `## context_tags vocabulary

Emit only the tags the scenario justifies; an empty array is acceptable when
the scenario is generic. Tags are lowercase kebab-case strings. Multiple are
allowed. Format \`<feature>:<value>\` denotes an explicit override; bare tags
denote scenario facts.

Now Bar variant signals (consumed by generator.js for the lock-screen lower cluster):
- now-bar:media       — surface a media-playing Now Bar (album / track / controls)
- now-bar:charging    — surface a charging Now Bar (battery percent)
- now-bar:timer       — surface a timer/stopwatch Now Bar
- now-bar:voice       — surface a voice-friendly single-line variant
- now-bar:delivery    — surface a delivery / ETA tracker
- now-bar:eta         — alias for delivery
- no-now-bar          — explicitly suppress the Now Bar
- bare-lock           — minimal lock screen, suppress all ambient widgets

Activity signals (scenario facts; may also drive Now Bar choice indirectly):
- media-playing, charging, workout, commute, meeting, idle,
  driving, walking, stationary

Guided-task / assistant (in-app scenarios with steps, timers, or voice):
- assistant-task — recipe/cooking assistant, workout coach, tutoring, any multi-step guided flow that needs buttons/chips/toggles
- assistive-session — same family; paired with selector affordance rules
- hands-busy-cooking — messy hands / kitchen context; bias to larger targets + voice (set interaction_mode mixed or minimal-touch when appropriate)
- cooking-session — explicit recipe / stove / prep context
- timer — user tracks countdowns or step durations (add with now-bar:timer on lock/home when relevant)

Time-of-day:
- morning, afternoon, evening, night, dawn, dusk

System state:
- low-battery, dnd, focus-mode, airplane-mode, silent

Lock-screen extras:
- weather                   — surface a weather widget / glance row
- temporal:secondary        — show secondary time / date row
- notifications-pending     — there are pending notifications to surface
- widgets-active            — widget row should be shown

Examples:
- "Show the lock screen with music playing"          → ["media-playing", "now-bar:media"]
- "Lock screen at night, no widgets, just the time"  → ["night", "bare-lock"]
- "Driving navigation lock screen"                   → ["driving", "now-bar:voice"]
- "Workout in progress on lock"                      → ["workout"]
- "Show a clean home screen"                         → []
`;

// ---------------------------------------------------------------------------
//  buildPromptContext(stage, uiState) — returns the KB slice per stage.
//  Stages: 'interpreter' | 'normalizer' | 'selector' | 'composer' | 'explainer'
//  uiState is optional (interpreter doesn't have it yet); when present it
//  enables surface-specific sections (lock/home screen assembly, QS panel).
// ---------------------------------------------------------------------------

function buildPromptContext(stage, uiState) {
  const parts = ['# Design System Context'];
  const surface = uiState && uiState.baseSurface;
  const overlay = uiState && uiState.overlayType;

  const push = (body) => { if (body) parts.push(body); };

  if (stage === 'interpreter') {
    push(_take(GENUI_SECTIONS, 'terminology'));
    push(_take(GENUI_SECTIONS, 'p2_contextual_assembly'));
    push(_take(GENUI_SECTIONS, 'p4_progressive_density'));
    push(_take(GENUI_SECTIONS, 'p10_ambient_reactivity'));
    parts.push(CONTEXT_TAG_VOCABULARY);
  } else if (stage === 'normalizer') {
    push(_take(GENUI_SECTIONS, 'p1_component_role_classification'));
    push(_take(GENUI_SECTIONS, 'p4_progressive_density'));
    push(_take(GENUI_SECTIONS, 'p9_notification_stratification'));
    push(_take(ORCH_SECTIONS,  'vertical_stacking_rules'));
  } else if (stage === 'selector') {
    push(_take(GENUI_SECTIONS, 'component_composition_grammar'));
    push(_take(GENUI_SECTIONS, 'well_formedness_constraints'));
    const relEvolve = EVOLVE_ENTRIES.filter(e =>
      /touch-target|sizing|interaction|radius/.test(e.type || ''));
    if (relEvolve.length) {
      parts.push('## Learned selection rules (evolve.md)\n' +
        relEvolve.map(e => `- [${e.id}] ${e.constraint || e.title}`).join('\n'));
    }
    // Auto-learned constraints from improvement cycles. These are injected
    // at runtime when applyLearnedRule has been called (via Phase C trial)
    // and persisted in figma-refs/learned_rules.json. Filtered to selector-
    // relevant types so the prompt stays focused.
    const relLearned = LEARNED_EVOLVE_ENTRIES.filter(e =>
      /touch-target|sizing|interaction|radius|content|composition/.test(e.type || ''));
    if (relLearned.length) {
      parts.push('## Auto-learned rules (improvement cycles)\n' +
        relLearned.map(e => `- [${e.id}] ${e.constraint}`).join('\n'));
    }
  } else if (stage === 'composer') {
    // ORCHESTRATION rules — the composer's primary reference for HOW to
    // arrange components into surfaces.
    push(_take(ORCH_SECTIONS, 'screen_frame_structure'));
    push(_take(ORCH_SECTIONS, 'vertical_stacking_rules'));
    push(_take(ORCH_SECTIONS, 'horizontal_layout_rules'));
    push(_take(ORCH_SECTIONS, 'container_nesting_rules'));
    if (surface === 'lock') push(_take(ORCH_SECTIONS, 'lock_screen_assembly'));
    if (surface === 'home') push(_take(ORCH_SECTIONS, 'home_screen_assembly'));
    if (overlay === 'quick-settings')
      push(_take(ORCH_SECTIONS, 'quick_settings_panel_assembly'));

    // DESIGN.md token system — previously NOT injected into Path A prompts,
    // so the composer didn't know "Samsung Blue is #0381FE" or "primary CTA
    // radius is 18px". Now the composer reasons against the actual design
    // system tokens. Sections chosen for composer relevance: color palette
    // (semantic roles), typography scale, shape system (radius/morphology),
    // spacing system (grid). Skip "Visual Theme" and "Component Definitions"
    // (already covered by the component vocabulary block in the selector).
    push(_take(DESIGN_SECTIONS, 'color_palette_roles'));
    push(_take(DESIGN_SECTIONS, 'typography'));
    push(_take(DESIGN_SECTIONS, 'shape_system'));
    push(_take(DESIGN_SECTIONS, 'spacing_system'));

    // Compact token reference from design_rules.json — atomic numeric values
    // the composer can reference when picking padding / radius / typography.
    // Complements DESIGN.md's prose with the exact token table.
    parts.push(_buildDesignTokenBlock());

    // Refinement rules from figma-refs/refinement_rules.json — anti-patterns
    // previously observed + their corrections, injected as guidance so the
    // composer produces the right shape from the start instead of relying
    // on post-hoc rule-engine fixes.
    parts.push(_buildRefinementRulesBlock());

    if (EVOLVE_ENTRIES.length) {
      parts.push('## Learned composition rules (evolve.md)\n' +
        EVOLVE_ENTRIES.map(e => `- [${e.id}] ${e.constraint || e.title}`).join('\n'));
    }
    // Auto-learned constraints — composer sees ALL learned types because
    // composition is the cross-cutting stage where sizing/touch-target/
    // content rules all matter.
    if (LEARNED_EVOLVE_ENTRIES.length) {
      parts.push('## Auto-learned rules (improvement cycles)\n' +
        LEARNED_EVOLVE_ENTRIES.map(e => `- [${e.id}] (${e.type}) ${e.constraint}`).join('\n'));
    }
  } else if (stage === 'explainer') {
    parts.push('## Principles the pipeline emphasized\n' +
      '- P1: Component role classification (S vs G)\n' +
      '- P2: Contextual assembly — context drives structure\n' +
      '- P4: Progressive density (expanded → normal → compressed)\n' +
      '- P9: Notification stratification (info / interactive / alert)\n' +
      '- ORCH §2: Vertical stacking gaps (chrome→chrome 0dp, chrome→content 8dp, card→card 12dp)\n' +
      '- evolve.md: touch-target ≥ 48dp, no sub-0.5px borders, grid-snapped spacing');
  }
  return parts.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
//  Pre-filter: single entry point for allowed-component filtering.
//  Called once before Step 4 (layout composer). Uses Generator's surfaceRules
//  + registry.allowedContexts from DesignMemory. Returns filtered refs array.
// ---------------------------------------------------------------------------
function preFilterComponents(componentRefs, uiState) {
  if (!DesignMemory || !DesignMemory.generatorMemory) return componentRefs;
  return Generator.filterAllowedComponents(uiState, componentRefs, DesignMemory);
}

function allowedComponentTypes() {
  if (!REGISTRY) return [];
  return (REGISTRY.vocabulary && REGISTRY.vocabulary.allowed_types) || Object.keys(REGISTRY.components || {});
}

function allowedSemanticComponentTypes() {
  if (!REGISTRY) return [];
  return (REGISTRY.vocabulary && REGISTRY.vocabulary.semantic_allowed_types) || allowedComponentTypes();
}

/**
 * Post-selector: inject hands-on controls only when the scenario domain
 * genuinely needs them. Never match on the bare word "assistant" — that
 * mis-fires on "Flight assistant" and sprays recipe chips onto travel UIs.
 */
function injectTaskAffordances(plan, scenarioText, interpretation) {
  if (!plan || !Array.isArray(plan.requiredComponents)) return false;

  const dom = classifyScenarioDomains(scenarioText, interpretation);
  const { blob, travel, cooking, workout } = dom;

  // Travel / airport flows: no recipe timers or cooking chip rows.
  if (travel && !cooking && !workout) return false;

  const kitchenish =
    cooking ||
    (
      /\b(timer|stopwatch|countdown)\b/i.test(blob) &&
      /\b(recipe|cook|kitchen|prep|step|simmer|bake|boil|chef)\b/i.test(blob)
    );

  if (!kitchenish && !workout) return false;
  const cookingBrowseish =
    kitchenish &&
    /\b(browse|saved|collection|collections|explore|discover|catalog|filter|ingredients?|meal\s*type|diet|cook\s*time|recently\s*viewed)\b/i.test(blob);

  const comps = plan.requiredComponents;
  const actionTypes = new Set(['btn-contained', 'btn-outlined', 'btn-flat', 'fab', 'chip', 'quick_toggle_row', 'action_chip_row']);
  const sessionStrip = new Set(['media_control_bar', 'navigation_turn_card']);

  const hasAction = comps.some(c => actionTypes.has(c.componentType));
  const hasStrip = comps.some(c => sessionStrip.has(c.componentType));
  const hasChipRow = comps.some(c =>
    c.componentType === 'action_chip_row' || c.componentType === 'quick_toggle_row');

  const injected = [];
  const pushComp = (row) => {
    comps.push(row);
    injected.push(row.componentType);
  };

  if (!hasStrip) {
    const timerish = kitchenish
      ? /\b(timer|simmer|countdown|minutes?|hours?|prep|oven|step)\b/i.test(blob)
      : /\b(timer|interval|pace|split)\b/i.test(blob);
    pushComp({
      slot:          'session_timer_strip',
      componentType: 'media_control_bar',
      variantHint:   'default',
      priority:      2,
      role:          'state',
      content:       {
        label: timerish ? (kitchenish ? 'Step timer' : 'Session timer') : 'Live session',
        value: timerish ? '00:05:39 · tap to pause' : 'Swipe for controls',
        icon:  'timer'
      },
      constraints:   [],
      _source:       'affordance-inject'
    });
  }

  if (!hasAction && kitchenish) {
    pushComp({
      slot:          'primary_cta',
      componentType: 'btn-contained',
      variantHint:   'default',
      priority:      2,
      role:          'action',
      content:       {
        label: cookingBrowseish
          ? 'See recipes'
          : (/\brecipe|step|cook\b/i.test(blob) ? 'Next step' : 'Continue'),
        value: cookingBrowseish
          ? 'Open filtered list'
          : (/\brecipe|step/i.test(blob) ? 'Advance instructions' : 'Resume task'),
        icon:  null
      },
      constraints:   [],
      _source:       'affordance-inject'
    });
    if (!cookingBrowseish) {
      pushComp({
        slot:          'secondary_cta',
        componentType: 'btn-outlined',
        variantHint:   'default',
        priority:      3,
        role:          'action',
        content:       {
          label: 'Unit converter',
          value: '',
          icon:  null
        },
        constraints:   [],
        _source:       'affordance-inject'
      });
    }
  } else if (!hasAction && workout) {
    pushComp({
      slot:          'primary_cta_workout',
      componentType: 'btn-contained',
      variantHint:   'default',
      priority:      2,
      role:          'action',
      content:       { label: 'Pause', value: 'Hold to end', icon: null },
      constraints:   [],
      _source:       'affordance-inject'
    });
  }

  if (!hasChipRow && kitchenish) {
    const voice = /\b(voice|hands-?free|bixby|speak)\b/i.test(blob);
    const browseActions = [
      { label: 'Ingredients', kind: 'secondary', icon: 'search' },
      { label: 'Meal type',   kind: 'secondary', icon: 'bookmark' },
      { label: 'Diet',        kind: 'secondary', icon: 'settings' },
      { label: 'Cook time',   kind: 'secondary', icon: 'clock' },
      { label: 'Recently viewed', kind: 'secondary', icon: 'history' }
    ];
    pushComp({
      slot:          'quick_choice_chips',
      componentType: 'action_chip_row',
      variantHint:   'default',
      priority:      3,
      role:          'action',
      content:       {
        label: '',
        value: '',
        icon:  null,
        // Adaptive quick menu:
        // - browse-like cooking => filter chips (can wrap to 2 lines)
        // - assistant-like cooking => compact step-control chips
        maxRows: cookingBrowseish ? 2 : 2,
        actions: cookingBrowseish
          ? browseActions
          : (voice
            ? [
              { label: '15 min timer', kind: 'primary', icon: 'clock' },
              { label: 'Voice tip', kind: 'secondary', icon: 'sound' },
              { label: 'Substitute', kind: 'secondary', icon: 'swap' }
            ]
            : [
              { label: '15 min timer', kind: 'primary', icon: 'clock' },
              { label: 'Ingredients', kind: 'secondary', icon: 'search' },
              { label: 'Scale recipe', kind: 'secondary', icon: 'scale' },
              { label: 'Mark done', kind: 'secondary', icon: 'check' }
            ])
      },
      constraints:   [],
      _source:       'affordance-inject'
    });
  } else if (!hasChipRow && workout) {
    pushComp({
      slot:          'quick_choice_chips_workout',
      componentType: 'action_chip_row',
      variantHint:   'default',
      priority:      3,
      role:          'action',
      content:       {
        label: '',
        value: '',
        icon:  null,
        actions: [
          { label: 'Lap', kind: 'primary' },
          { label: 'Voice cue', kind: 'secondary' },
          { label: 'Lock screen', kind: 'secondary' }
        ]
      },
      constraints:   [],
      _source:       'affordance-inject'
    });
  }

  if (injected.length) {
    plan.plannerNotes = plan.plannerNotes || {};
    plan.plannerNotes.affordanceInjected = injected.slice();
    console.log('[pipeline] runPlan: affordance-inject → ' + injected.join(', '));
    return true;
  }
  return false;
}

/**
 * Capability-driven coverage (non-preset): infer required capabilities from
 * scenario + planning packet and backfill only missing ones.
 * This avoids hardcoded "if scenario == X then component Y" branching.
 */
function enforceAdaptiveScenarioCoverage(plan, scenarioText, interpretation, planningPacket, uiStateForSelector) {
  if (!plan || !Array.isArray(plan.requiredComponents)) return 0;

  const slots = Array.isArray(planningPacket && planningPacket.slotRequirements)
    ? planningPacket.slotRequirements
    : [];
  const tasks = planningPacket && planningPacket.taskGroups
    ? [].concat(
      planningPacket.taskGroups.primary || [],
      planningPacket.taskGroups.secondary || []
    )
    : [];
  const contextTags = Array.isArray(uiStateForSelector && uiStateForSelector.contextTags)
    ? uiStateForSelector.contextTags
    : [];
  const corpus = [
    scenarioText || '',
    interpretation && interpretation.primaryGoal ? interpretation.primaryGoal : '',
    slots.map(s => `${s.slot || ''} ${s.purpose || ''} ${s.contentType || ''} ${s.selectionHint || ''}`).join('\n'),
    tasks.map(t => `${t.type || ''} ${t.contentNeed || ''}`).join('\n'),
    contextTags.join(' ')
  ].join('\n').toLowerCase();

  const hasType = (types) => plan.requiredComponents.some(c => types.includes(c.componentType));
  const hasAnySignal = (res) => res.some(re => re.test(corpus));
  const add = (row) => { plan.requiredComponents.push(row); added += 1; };
  let added = 0;

  const capabilityRules = [
    {
      id: 'navigation',
      need: [/\b(map|route|routing|navigation|gps|turn|directions?|commute|eta|path|arrival)\b/],
      presentTypes: ['eta_card', 'navigation_turn_card'],
      row: {
        slot: 'cap_navigation',
        componentType: 'eta_card',
        variantHint: 'default',
        priority: 2,
        role: 'context',
        content: { label: 'ETA · Destination', value: '18 min · Route updated', icon: null },
        constraints: [],
        _source: 'adaptive-coverage'
      }
    },
    {
      id: 'audio',
      need: [/\b(music|song|playlist|podcast|audio|headphones?|earbuds?|now playing|playback)\b/],
      presentTypes: ['media_control_bar'],
      row: {
        slot: 'cap_audio',
        componentType: 'media_control_bar',
        variantHint: 'default',
        priority: 2,
        role: 'state',
        content: { label: 'Now playing', value: 'Adaptive mix · Tap to control', icon: 'play' },
        constraints: [],
        _source: 'adaptive-coverage'
      }
    },
    {
      id: 'biometric',
      need: [/\b(heart\s*rate|hr\b|bpm|pulse|oxygen|spo2|vo2|max|calorie|kcal|zone)\b/],
      presentTypes: ['input_summary_card', 'reminder_card', 'weather_glance_card'],
      row: {
        slot: 'cap_biometrics',
        componentType: 'input_summary_card',
        variantHint: 'default',
        priority: 2,
        role: 'state',
        content: { label: 'Live stats', value: 'Heart rate 148 bpm · Calories 312', icon: null },
        constraints: [],
        _source: 'adaptive-coverage'
      }
    },
    {
      id: 'timer',
      need: [/\b(timer|interval|lap|split|countdown|pace)\b/],
      presentTypes: ['media_control_bar', 'navigation_turn_card'],
      row: {
        slot: 'cap_timer',
        componentType: 'media_control_bar',
        variantHint: 'default',
        priority: 2,
        role: 'state',
        content: { label: 'Interval timer', value: '00:03:20 · Tap to pause', icon: 'timer' },
        constraints: [],
        _source: 'adaptive-coverage'
      }
    }
  ];

  capabilityRules.forEach(rule => {
    if (!hasAnySignal(rule.need)) return;
    if (hasType(rule.presentTypes)) return;
    add({ ...rule.row });
  });

  if (added) {
    plan.plannerNotes = plan.plannerNotes || {};
    plan.plannerNotes.adaptiveCoverageAdded = added;
    plan.plannerNotes.adaptiveCoverageSurface = (uiStateForSelector && uiStateForSelector.baseSurface) || null;
    console.log('[pipeline] runSelect: adaptive capability coverage injected ' + added + ' row(s)');
  }
  return added;
}

/**
 * Safety net for AI-first mode:
 * keep model freedom, but prevent implausibly sparse plans (e.g. 1 card for
 * an in-app assistant). This enforces minimum role coverage, not fixed presets.
 */
function ensureMinimumRoleCoverage(plan, scenarioText, interpretation, planningPacket, uiStateForSelector) {
  if (!plan || !Array.isArray(plan.requiredComponents)) return 0;
  const ui = uiStateForSelector || {};
  if (ui.baseSurface !== 'app') return 0;

  const rows = plan.requiredComponents;
  const nonChrome = rows.filter(c => c.role !== 'chrome');
  const dom = classifyScenarioDomains(scenarioText, interpretation);
  const goal = (planningPacket && planningPacket.planningSummary && planningPacket.planningSummary.primaryGoal) || '';
  const corpus = `${scenarioText || ''}\n${goal || ''}\n${dom.blob || ''}`.toLowerCase();
  const iotLike = /\b(iot|smart[\s-]?home|device|room|light|lamp|switch|thermostat|scene|automation)\b/i.test(corpus);
  const travelLike = !!(dom.travel && !dom.cooking);
  const tripCity = tripLabelFromScenario(scenarioText);

  // If the model already produced a sufficiently rich app task unit, don't touch it.
  if (nonChrome.length >= 4) return 0;

  const hasRole = (r) => rows.some(c => c.role === r);
  const hasType = (t) => rows.some(c => c.componentType === t);
  let added = 0;
  function push(row) {
    rows.push(row);
    added += 1;
  }

  if (!hasRole('subject')) {
    push({
      slot: 'primary_subject',
      componentType: iotLike ? 'reminder_card' : 'message_summary_card',
      variantHint: 'default',
      priority: 1,
      role: 'subject',
      content: iotLike
        ? { label: 'Device status', value: 'Living room lights on · 22°C', icon: null }
        : { label: 'Now', value: 'Current task overview', icon: null },
      constraints: [],
      _source: 'min-role-coverage'
    });
  }

  if (!hasRole('state')) {
    const useTravelReminder =
      travelLike && !travelScenarioWantsPlaybackStrip(`${scenarioText || ''}\n${goal || ''}`);
    push({
      slot: 'primary_state',
      componentType: iotLike ? 'media_control_bar' : useTravelReminder ? 'reminder_card' : 'media_control_bar',
      variantHint: 'default',
      priority: 2,
      role: 'state',
      content: iotLike
        ? { label: 'Brightness', value: '65% · Auto', icon: 'timer' }
        : useTravelReminder
          ? {
              label: tripCity ? `Today · ${tripCity}` : 'Trip · Today',
              value: tripCity
                ? `Reservations, transit passes, and timed entries for ${tripCity} — confirm local times and addresses.`
                : 'Itinerary status: next booking, travel time, and check-in windows — specific times.',
              icon: 'schedule'
            }
          : { label: 'Live state', value: '00:05:39 · active', icon: 'timer' },
      constraints: [],
      _source: 'min-role-coverage'
    });
  }

  if (!hasRole('context')) {
    push({
      slot: 'support_context',
      componentType: iotLike ? 'input_summary_card' : 'eta_card',
      variantHint: 'default',
      priority: 2,
      role: 'context',
      content: iotLike
        ? { label: 'Environment', value: 'Humidity 58% · Power 57 kWh', icon: null }
        : { label: 'ETA · Destination', value: '12 min · Light traffic', icon: null },
      constraints: [],
      _source: 'min-role-coverage'
    });
  }

  if (!hasRole('action')) {
    push({
      slot: 'primary_action',
      componentType: iotLike ? 'action_chip_row' : 'btn-contained',
      variantHint: 'default',
      priority: 2,
      role: 'action',
      content: iotLike
        ? {
          label: '',
          value: '',
          icon: null,
          maxRows: 2,
          actions: [
            { label: 'Reading', kind: 'primary', icon: 'play' },
            { label: 'Sleep', kind: 'secondary', icon: 'clock' },
            { label: 'All off', kind: 'secondary', icon: 'x' }
          ]
        }
        : { label: 'Continue', value: '', icon: null },
      constraints: [],
      _source: 'min-role-coverage'
    });
  }

  // IoT should expose at least one binary cluster when available.
  if (iotLike && !hasType('quick_toggle_row')) {
    push({
      slot: 'binary_controls',
      componentType: 'quick_toggle_row',
      variantHint: 'default',
      priority: 3,
      role: 'action',
      content: {
        label: 'Controls',
        value: '',
        icon: null,
        actions: [
          { label: 'Auto', on: true },
          { label: 'Eco', on: false },
          { label: 'Motion', on: true }
        ]
      },
      constraints: [],
      _source: 'min-role-coverage'
    });
  }

  if (added) {
    plan.plannerNotes = plan.plannerNotes || {};
    plan.plannerNotes.minRoleCoverageAdded = added;
    console.log('[pipeline] runSelect: min-role coverage injected ' + added + ' row(s)');
  }
  return added;
}

// ---------------------------------------------------------------------------
//  STEP 1 — SCENARIO INTERPRETER
// ---------------------------------------------------------------------------

function buildInterpreterPrompt() {
  return `You are a scenario interpreter for a state-based generative UI system.

You must NOT generate UI.
You must NOT choose components.
You must ONLY convert the scenario into structured intent, context, tasks, constraints, and UI state.

Return STRICT JSON only.

{
  "intent": {
    "primary_goal": "",
    "secondary_goal": null
  },
  "context": {
    "environment": "",
    "attention_mode": "focused | glanceable | distracted",
    "urgency": "low | medium | high",
    "mobility_mode": "stationary | walking | driving | transit",
    "interaction_mode": "touch | voice | mixed | minimal-touch"
  },
  "tasks": [
    {
      "task_id": "",
      "type": "",
      "priority": 1,
      "content_need": ""
    }
  ],
  "constraints": [],
  "ui_state": {
    "base_surface": "lock | home | app",
    "home_substate": "none | launcher | app-drawer | widget-edit",
    "overlay_type": "none | quick-settings | notification-shade | system-dialog",
    "overlay_coverage": "none | partial | full",
    "window_mode": "single | split | floating",
    "attention_mode": "focused | glanceable | distracted",
    "density_mode": "expanded | normal | compressed",
    "interaction_mode": "touch | voice | mixed | minimal-touch",
    "background_policy": "wallpaper | solid-dark | scrim-over-wallpaper | scrim-over-app | dialog-surface",
    "context_tags": ["string", "..."]
  }
}

Rules:
- interpret, do not design
- tasks must be atomic
- priority must be explicit (1 highest)
- constraints must reflect real UX constraints
- ui_state must reflect context, not arbitrary guess
- context_tags should be a list of scenario signals the renderer can act on (see vocabulary in the design-system context block); use [] when the scenario is generic

base_surface CLASSIFICATION (critical — most quality issues trace back to misclassification here):
  * "lock"  — the device's lock screen. Wallpaper visible, clock prominent, no app chrome. Use ONLY when the scenario explicitly takes place on the lock screen.
  * "home"  — the device's home / launcher screen ITSELF: system widgets (weather, calendar, music) on top of the wallpaper, app dock at the bottom. Use ONLY when the scenario is "show the home screen" / "the device home" / "launcher" / etc. The home screen is a CHROME surface, not a content surface.
  * "app"   — INSIDE a specific application. Use this for ANY scenario that describes a task, a tool, a content view, or a specific app — even if the app feels lifestyle-y or "personalized". The app surface gets its own status bar + app-bar + content area. NO wallpaper. NO home dock. NO system widgets.

Decision rule: if the user is asking to DO something or SEE something inside an application (cook, navigate, message, browse, configure, track, learn, shop, watch, play, edit) → "app". If the user is asking to see the device's idle screens themselves → "lock" or "home".

Examples:
  * "Personalized cooking assistant" → app   (cooking is an app, not the home screen)
  * "Driving navigation" → app   (navigation is an app)
  * "Workout tracker showing heart rate" → app   (a fitness app)
  * "Chat thread with photo attachment" → app
  * "Settings page with toggle list" → app
  * "Recipe browser with filters" → app
  * "Show the home screen with weather and music widgets" → home   (explicit home reference)
  * "Lock screen with now-playing media" → lock
  * "Notification shade" → home with overlay_type=notification-shade   (the shade overlays whatever is underneath; default underlying surface is home)
  * "Share sheet", "pick an app to share", "bottom sheet with options", "action sheet", "coordination sheet", "target / option picker" → app with overlay_type=system-dialog, background_policy=dialog-surface, overlay_coverage=partial (unless full-screen modal is explicit)`;
}

// ---------------------------------------------------------------------------
//  STEP 1+2 (MERGED) — INTERPRET + NORMALIZE in a single LLM call
//  ---------------------------------------------------------------------------
//  Speed optimization: Steps 1 and 2 are both "scenario understanding" and
//  share the same uiState; merging them into one model call cuts ~7s off
//  every pipeline run while still letting downstream code consume them as
//  separate canonical objects (normalizeInterpreterOutput +
//  normalizeNormalizerOutput each read their own subset of fields from the
//  same response). Used by runPlan when an llmCallFast is supplied.
// ---------------------------------------------------------------------------

function buildInterpretAndPlanPrompt() {
  return `You are a scenario interpreter AND planning normalizer for a state-based generative UI system. You handle pipeline stages 1 and 2 in a single response.

You must NOT generate UI.
You must NOT choose components.
You must produce a SINGLE strict-JSON object containing BOTH halves:
  (A) interpretation:  intent, context, tasks, constraints, ui_state
  (B) planning packet: planning_summary, task_groups, slot_requirements, selection_constraints

Return STRICT JSON only (no commentary):

{
  "intent": {
    "primary_goal": "",
    "secondary_goal": null
  },
  "context": {
    "environment": "",
    "attention_mode": "focused | glanceable | distracted",
    "urgency": "low | medium | high",
    "mobility_mode": "stationary | walking | driving | transit",
    "interaction_mode": "touch | voice | mixed | minimal-touch"
  },
  "tasks": [
    {
      "task_id": "",
      "type": "",
      "priority": 1,
      "content_need": ""
    }
  ],
  "constraints": [],
  "ui_state": {
    "base_surface": "lock | home | app",
    "home_substate": "none | launcher | app-drawer | widget-edit",
    "overlay_type": "none | quick-settings | notification-shade | system-dialog",
    "overlay_coverage": "none | partial | full",
    "window_mode": "single | split | floating",
    "attention_mode": "focused | glanceable | distracted",
    "density_mode": "expanded | normal | compressed",
    "interaction_mode": "touch | voice | mixed | minimal-touch",
    "background_policy": "wallpaper | solid-dark | scrim-over-wallpaper | scrim-over-app | dialog-surface",
    "context_tags": ["string", "..."]
  },
  "planning_summary": {
    "primary_goal": "",
    "interaction_priority": "",
    "attention_strategy": "",
    "density_strategy": "",
    "background_policy": ""
  },
  "task_groups": {
    "primary": [],
    "secondary": [],
    "optional": []
  },
  "slot_requirements": [
    {
      "slot": "",
      "purpose": "",
      "content_type": "",
      "priority": 1,
      "selection_hint": ""
    }
  ],
  "selection_constraints": {
    "prefer": [],
    "avoid": [],
    "collapse_first": []
  }
}

Rules — interpretation half:
- interpret, do not design
- tasks must be atomic
- priority must be explicit (1 highest)
- constraints must reflect real UX constraints
- ui_state must reflect context, not arbitrary guess
- context_tags should be a list of scenario signals the renderer can act on (see vocabulary in the design-system context block); use [] when the scenario is generic

DENSITY / ATTENTION DEFAULTS (calibrated against real Samsung One UI behavior):
- density_mode: default to "normal". Use "expanded" only when the scenario explicitly emphasizes detail (deep-dive, full-content reading, edit mode). Use "compressed" ONLY when the scenario explicitly says "minimal", "essentials only", "quick glance", "simplified", or "battery saver" — NOT just because the surface is lock or notification.
- attention_mode: default to "focused". Use "glanceable" only for genuinely passive surfaces (always-on display, status-at-a-glance widget). Lock screens with multiple content types (briefing, weather + meetings, notifications + media) are "focused", not glanceable — the user is actively reading multiple cards.
- interaction_mode: default to "touch". Use "minimal-touch" only when scenario context implies hands-busy (driving, cooking with messy hands, exercising) or when the surface is genuinely no-interaction (always-on display).
- A real Samsung lock screen typically shows 6-10 visible elements (status bar, clock, weather, date, widget row, shortcut row, gesture bar, etc.). Do not auto-compress it to 2-3 just because "lock screen sounds minimal".
- Cooking / recipe / workout / running / timer apps: add at least one of context_tags assistant-task, cooking-session, timer, or hands-busy-cooking when the scenario implies step-by-step help, countdowns, or hands-busy use. Prefer interaction_mode "mixed" when voice or hands-free is plausible.

Rules — planning half:
- group tasks into primary / secondary / optional. Top 2 priority=1 tasks → primary; remaining priority-1/2 → secondary; priority-3 → optional
- convert tasks into slot_requirements (slots, NOT component names)
- selection_hint describes BEHAVIOR not a component (e.g. "single-value glance summary", "primary action affordance")
- if attention_mode = glanceable → prefer summary / compact / single-value; mark dense components for collapse_first
- if interaction_mode = minimal-touch → avoid dense interaction clusters
- if urgency = high → primary must reflect urgency
- DO NOT invent component names anywhere

base_surface CLASSIFICATION (critical — most quality issues trace back to misclassification):
  * "lock"  — the device's lock screen. Wallpaper visible, clock prominent, no app chrome. Use ONLY when the scenario explicitly takes place on the lock screen.
  * "home"  — the device's home / launcher screen ITSELF: system widgets on top of the wallpaper, app dock at the bottom. Use ONLY when the scenario is "show the home screen" / "the device home" / "launcher" / etc.
  * "app"   — INSIDE a specific application. Use this for ANY scenario that describes a task, a tool, a content view, or a specific app — even if the app feels lifestyle-y or "personalized". App surface gets its own status bar + app-bar + content area. NO wallpaper. NO home dock. NO system widgets.

Decision rule: if the user is asking to DO or SEE something INSIDE an application (cook, navigate, message, browse, configure, track, learn, shop, watch, play, edit) → "app". If the user is asking to see the device's idle screens themselves → "lock" or "home".

Examples:
  * "Personalized cooking assistant" → app
  * "Driving navigation" → app
  * "Workout tracker showing heart rate" → app
  * "Settings page with toggle list" → app
  * "Show the home screen with weather and music widgets" → home
  * "Lock screen with now-playing media" → lock
  * "Notification shade" → home with overlay_type=notification-shade
  * "Share sheet", "bottom sheet", "pick sharing target", "coordination sheet", "option picker" → app with overlay_type=system-dialog and background_policy=dialog-surface
  * Korean: "바텀시트", "하단 시트/카드", "공유 시트", "옵션 피커", "슬라이드 업", "시트형 카드 UI" → same (system-dialog + dialog-surface); optional context_tags entry bottom_sheet when explicit
  * E-book / reading scenarios that describe **only** a quick control strip or a **peek** panel (e.g. "reading quick bar", "book controls in a bottom sheet", "독서 퀵바만", "전자책 바텀시트로만") → same: system-dialog + dialog-surface; optional context_tags like reader_quick_bar or reading_sheet — the UI need not be a full-page grid of cards
  * "Personal / tailored interface for my New York (or any city) trip" → app; slot_requirements must cover transit ticket/pass, fares & pricing, map/route context, today's timed schedule, and quick trip actions — not a single vague summary card.`;
}

// ---------------------------------------------------------------------------
//  STEP 2 — HANDOFF NORMALIZER (planner preparation)
//  Kept for backward compatibility / debug routes that want the legacy
//  two-call path. The merged buildInterpretAndPlanPrompt is preferred.
// ---------------------------------------------------------------------------

function buildNormalizerPrompt() {
  return `You are a handoff normalizer.

You receive structured scenario JSON from STEP 1.
Your job is to convert it into a component-selection-ready planning packet.

You must NOT:
- generate UI
- invent components
- change ui_state arbitrarily
- reinterpret the scenario creatively

You must:
- group tasks into primary / secondary / optional
- convert tasks into slot requirements
- translate constraints into selection constraints
- prepare a minimal, clean packet for component selection

Return STRICT JSON:

{
  "planning_summary": {
    "primary_goal": "",
    "interaction_priority": "",
    "attention_strategy": "",
    "density_strategy": "",
    "background_policy": ""
  },
  "task_groups": {
    "primary": [],
    "secondary": [],
    "optional": []
  },
  "slot_requirements": [
    {
      "slot": "",
      "purpose": "",
      "content_type": "",
      "priority": 1,
      "selection_hint": ""
    }
  ],
  "selection_constraints": {
    "prefer": [],
    "avoid": [],
    "collapse_first": []
  },
  "ui_state": {}
}

Rules:
- keep only top 2 tasks as primary/secondary if too many
- rest → optional
- convert tasks → slots (NOT components)
- selection_hint must describe behavior, not component name
- if attention_mode = glanceable → prefer summary, compact, single-value
- if minimal-touch → avoid dense interaction clusters
- if urgency high → primary must reflect urgency
- DO NOT invent component names`;
}

// ---------------------------------------------------------------------------
//  STEP 3 — COMPONENT SELECTOR
// ---------------------------------------------------------------------------

function buildPlannerPrompt(vocabOverride) {
  // When called with no argument: bake in the static COMPONENT_DESCRIPTIONS_BLOCK
  // (legacy, RAG-off behavior — vocab lives in the system prompt).
  // When called with a vocab block argument: use that instead (RAG=on path,
  // letting runSelect inject a per-call shortlist).
  const block = (typeof vocabOverride === 'string' && vocabOverride.length)
    ? vocabOverride
    : COMPONENT_DESCRIPTIONS_BLOCK;
  return `You are a component selector.

You receive a planning packet (JSON may use camelCase: slotRequirements,
selectionConstraints, planningSummary, uiState — same meaning as
slot_requirements / selection_constraints / planning_summary / ui_state).
Your job is to select components ONLY from the allowed vocabulary below.
Each entry shows the component's ID, category, and a short description of
its purpose. Match components to slot_requirements based on purpose — not
just on string similarity.

You must NOT:
- reinterpret the scenario
- invent new components
- generate layout or styling

${block}

Return STRICT JSON:

{
  "required_components": [
    {
      "slot": "",
      "component_type": "",
      "variant_hint": "",
      "priority": 1,
      "role": "chrome | subject | state | action | feedback | context | navigation",
      "content": {
        "label": "",
        "value": "",
        "icon": null
      },
      "constraints": []
    }
  ],
  "planner_notes": {
    "kept_primary_tasks": [],
    "collapsed_optional_tasks": [],
    "selection_reasoning": []
  }
}

Rules:
- select components that match slot_requirements
- respect selection_constraints.prefer / avoid
- if conflict → preserve primary tasks
- collapse optional first
- if glanceable → compact or glance variants
- if minimal-touch → larger, simpler components
- content must match content_need

ROLE classification (the most important field for downstream layout coherence):
- chrome     — system-level structural elements: status bars, app bars, gesture bars, nav bars
- subject    — the primary content/artifact the user is interacting with: a recipe step card, a message body, a song/track card, a current notification; one screen typically has ONE subject
- state      — current status display tied to a subject: timer, progress bar, step counter "3 of 5", battery percentage
- action     — user-triggerable controls that operate ON the subject: "Next", "Pause", "Save", "Send"; chips, buttons, FABs
- feedback   — response/confirmation to a recent action: snackbar "Saved", inline success/error message
- context    — supporting info that frames the subject without acting on it: weather card next to lock clock, related recipes, tips, ambient widgets
- navigation — destination switches across screens: bottom nav, tabs, back arrow

Selection guidance:
- Every screen with a clear primary task MUST have at least one subject component.
- **Anti-fragmentation**: On APP / in-app guided flows (cooking, workouts, readers, commutes), do NOT pick only tiny glance tiles (\`widget-small\`, micro \`reminder_card\`, lone chips) with nothing large to anchor the eye. Include **at least one optically heavy subject**: \`recipe_step_card\`, \`media-card\`, rich \`reminder_card\` (hero image + step copy), \`focus-block\`, \`navigation_turn_card\`, a wide \`calendar_event_card\`/\`message_preview_card\` body, etc. Exception: explicit lock-screen / dashboard-only briefs where the packet calls for a 2×2 widget grid and no single hero.
- Inform-only dashboards (analytics readout, passive feed) → avoid fabricated CTAs.
- Guided assistants (cooking/recipe/workout/timer/running/tutoring/maps steps) ALWAYS imply the user acts — ALWAYS include ≥1 actionable primitive from the vocab: btn-contained, btn-outlined, btn-flat, chip, action_chip_row, or quick_toggle_row with concrete labels ("Next step", "Start 15 min timer", "Voice tip", "Mark done").
- Timed / hands-busy flows: ALSO include media_control_bar (timer/session strip semantics) OR pair action_chip_row with timer-flavored chips; do not rely on three passive glance cards alone.
- **Kitchen / recipe step (in-app):** avoid a **mosaic** of many same-scale \`reminder_card\` / \`input_summary_card\` tiles (step + “today” + “up next” + timer each as its own card). Prefer **one** dominant subject step, timer in \`media_control_bar\` / state, and **one** consolidated action row — not four parallel mini-cards.
- When the user controls a task (cook, workout, run, navigate, timer), include at least ONE dedicated action primitive — e.g. btn-contained, btn-outlined, btn-flat, action_chip_row, or chip — with real labels ("Start timer", "Next step", "Done", "Pause run"). Do NOT build the whole screen from passive cards only unless the scenario is read-only.
- Workout / running / health on lock or glance: combine state + context (lock-screen.widget-activity, lock-screen.widget-battery, eta_card, reminder_card) with a now-bar or timer row when appropriate; mix icon chips or actions for start/pause/end.
- Prefer media-card or media_control_bar when playback or a dominant media surface is the subject; use widget-small only for compact glance tiles.
- Dense full-screen tasks (running, cycling, hiking, GPS, maps, workout dashboards): emit at least 4 distinct selected body components (subject + state + context + action) — never settle for two tiny glance cards unless the packet explicitly demands minimal glanceable density.
- **Briefing / dashboard / “at a glance” / home-widget style summaries**: when the user (or planning packet) implies a passive overview, stock-ticker, or multi-metric readout — not a single-task assistant — emit **≥4** body picks from compact glance types: \`weather_glance_card\`, \`calendar_summary_card\`, \`reminder_card\`, \`message_summary_card\`, \`eta_card\`, \`input_summary_card\`, \`widget-small\`. Put **different numbers, names, times, or places** in each \`content.value\`. Keep a separate **action** group for controls unless the scenario is strictly read-only.
- Slot names should be DESCRIPTIVE (e.g. "current_instruction", "save_action", "weather_glance") — they will be carried into the layout for visual grouping.

Content authoring:
- For each requiredComponent you pick, fill content.label and content.value with REAL, scenario-specific text — NOT placeholders.
- The vocabulary block above shows "Content examples" for each component (label / value pairs across diverse scenarios). Use them as a TEMPLATE — match the structure and concreteness, then adapt the wording to the user's scenario.
- NEVER emit content like "Title", "Subtitle", "Item", "Content", "Personalized guidance", "Adaptations based on preferences" — those are bad placeholders.
- Glance / summary / dashboard tiles: each \`content.value\` SHOULD carry **~24+ characters** of concrete detail (counts, times, venue names, flight numbers, temperatures) unless the slot is intentionally empty — ultra-short values read as broken or “autonomy collapsed” UI.
- When two requiredComponents share the same componentType but different slots, their content.label and content.value MUST be DISTINCT and tailored to each slot's purpose.

DIVERSITY RULES (anti-repetition — STRICTLY enforced):
- Pick DIFFERENT componentTypes across slots. The same componentType MUST NOT appear more than TWICE in one plan (excluding chrome like status_bar / app_bar / gesture_bar / bottom_navigation_bar).
- **Exception — briefing / widget-grid / dashboard overview:** you MUST still use **≥3 distinct** componentTypes from the glance list in the briefing bullet above (never 4× one type). Up to **four** such tiles total is encouraged for true 2×2-style home summaries.
- Each requiredComponent MUST have a UNIQUE label string. No two components may share the same label text (case-insensitive, whitespace-insensitive).
- Prefer VARIETY: a screen with weather_card + calendar_event_card + reminder_list_item + message_preview_card is BETTER than 4× input_summary_card. Mix subject + state + context + action types.
- input_summary_card is for FORM SUMMARIES ONLY (search recap, settings recap, completed-form readback). Do NOT use it as a generic content card. If you need a generic info tile, use weather_card / calendar_event_card / reminder_list_item / message_preview_card / eta_card / now_playing_card / shortcut_tile instead.
- If a single concept (e.g. "ingredients ready") would naturally repeat 3+ times, instead express it ONCE in a list/grid component (reminder_list_item or shortcut_tile) — not as 3 separate cards with similar labels.
- When in doubt between two similar componentTypes for the same slot, pick the MORE SPECIFIC one.
- Travel / airport / boarding / flight assistant ONLY: NEVER use media_control_bar for music/podcasts/playback unless the user explicitly mentions audio/headphones/Spotify or a gate/boarding countdown. MUST emit MULTIPLE informational components—not only facet chips—with concrete itinerary text: LOCAL departure/arrival (or boarding opens/closes), gate + terminal, seat row if known, baggage or connection note. ALSO include eta_card (time-to-gate) OR navigation_turn_card (terminal cue) unless the scenario is explicitly read-only. Travel action_chip_row MUST use verbs like Lounge, Directions, Offline pass—not recipe chips. Prefer one subject hero PLUS at least calendar_summary_card OR reminder_card with prose bodies (not blank).
- **City trip + transit pass (metro, OMNY, weekly/unlimited):** Do NOT emit a **second** passive card whose only job is "FARE & PASSES" / payment comparison when the plan already has a pass summary tile — merge into one subject or chips; redundant explainer cards read as clutter.
- Cooking / kitchen / recipe scenarios: do NOT use \`action_chip_row\` for generic gallery-style shortcuts (e.g. "Videos", "Favorites", "Shared albums") unless the scenario is explicitly a media gallery — prefer timers, substitutions, scaling, step actions, or pair chips with the recipe subject. Use btn-contained/btn-outlined for primary/secondary steps ("Start prep", "Save recipe") when actions are implied.`;
}

// ---------------------------------------------------------------------------
//  STEP 7 — EXPLANATION LAYER
// ---------------------------------------------------------------------------

function buildExplanationPrompt() {
  return `You are the EXPLANATION LAYER.

Your inputs are (a) the original scenario_text, (b) the resolved ui_state, (c) required_components, (d) layout_plan, (e) validation_report, (f) planner_notes. You do NOT make new decisions or invent components. You ONLY explain what the pipeline already decided and what the user should know.

Return STRICT JSON only:
{
  "why_this_ui": "string (1–3 sentences, plain language)",
  "what_was_prioritized": ["string", "..."],
  "what_was_removed_or_collapsed": ["string", "..."],
  "what_should_be_fixed": ["string", "..."]
}

RULES
- why_this_ui: cite the strongest ui_state signals (attention_mode, density_mode, mobility_mode, interaction_mode, background_policy) and the top-priority component. Max 3 sentences.
- what_was_prioritized: list component_type + one-line reason for each priority:1 item.
- what_was_removed_or_collapsed: use planner_notes.collapsed_optional_tasks; also list any priority:3 items flagged by layout_overflow_check.
- what_should_be_fixed: ONE line per validation.violations entry (include ruleId + message). If no violations, return [].
- JSON only. No prose. No markdown.`;
}

// ---------------------------------------------------------------------------
//  CANONICAL VIOLATION FACTORY + ID GEN
// ---------------------------------------------------------------------------

function makeIdGen(prefix) {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(3, '0')}`;
}

function buildViolation(fields) {
  const autoFix = fields.autoFix || { possible: false, action: null, value: null };
  const status  = fields.status || 'review-required';
  return {
    id:          fields.id,
    stage:       fields.stage,
    ruleId:      fields.ruleId,
    category:    fields.category,
    severity:    fields.severity,
    status,
    frame:       fields.frame || '(pipeline)',
    element:     fields.element || null,
    nodeId:      fields.nodeId || null,
    property:    fields.property || null,
    actual:      fields.actual   === undefined ? null : fields.actual,
    expected:    fields.expected === undefined ? null : fields.expected,
    delta:       fields.delta    === undefined ? null : fields.delta,
    message:     fields.message || '',
    autoFix,
    needsReview: status !== 'auto-fixable'
  };
}

// ---------------------------------------------------------------------------
//  validatePlan — canonical, camelCase only (stage='plan')
// ---------------------------------------------------------------------------

function validatePlan(plan) {
  // Vocabulary scope tracks RAG mode:
  //   RAG on  → allow all 92 registry types (selector sees a 30-item
  //             shortlist drawn from the full registry)
  //   RAG off → revert to the curated 10-item semantic vocabulary
  //             (selector only ever sees those 10 — strict legacy mode)
  const allowedVocab = new Set(
    RAG_ENABLED ? allowedComponentTypes() : allowedSemanticComponentTypes()
  );
  const components = (plan && plan.requiredComponents) || [];
  const idGen = makeIdGen('plan-v');
  const violations = [];

  components.forEach((c, idx) => {
    const type = c.componentType;
    if (!type) {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'plan',
        ruleId:   'plan_missing_component_type',
        category: 'vocabulary',
        severity: 'high',
        status:   'review-required',
        element:  `requiredComponents[${idx}]`,
        property: 'componentType',
        actual:   null,
        expected: 'non-empty componentType',
        message:  `requiredComponents[${idx}] is missing componentType`
      }));
    } else if (!allowedVocab.has(type) && c._source !== 'mandatory-inject' && c.role !== 'chrome') {
      // Skip the vocabulary check for two cases:
      //  1. _source === 'mandatory-inject' — runPlan() programmatically
      //     injected this from generator_memory.json's mandatoryComponents.
      //  2. role === 'chrome' — the LLM correctly classified this as a
      //     structural chrome element (status bar, app bar, gesture bar).
      //     Chrome IDs (e.g. "container.status-bar-app", "container.header")
      //     live in the registry's `components` map but are intentionally
      //     omitted from `vocabulary.semantic_allowed_types` because we
      //     don't want LLM stages 1–3 selecting them as content. Once the
      //     LLM has labeled an entry role=chrome, the vocabulary scope
      //     no longer applies.
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'plan',
        ruleId:   'plan_vocabulary_violation',
        category: 'vocabulary',
        severity: 'high',
        status:   'review-required',
        element:  type,
        property: 'componentType',
        actual:   type,
        expected: Array.from(allowedVocab),
        message:  `componentType "${type}" is not in the semantic vocabulary`
      }));
    }
    if (c.priority == null || ![1, 2, 3].includes(c.priority)) {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'plan',
        ruleId:   'plan_priority_out_of_range',
        category: 'consistency',
        severity: 'medium',
        status:   'review-required',
        element:  type || `requiredComponents[${idx}]`,
        property: 'priority',
        actual:   c.priority,
        expected: [1, 2, 3],
        message:  `priority must be 1, 2, or 3 (got ${JSON.stringify(c.priority)})`
      }));
    }
  });

  return { violations };
}

// ---------------------------------------------------------------------------
//  STEP 4 — LAYOUT COMPOSER (LLM)
//  ---------------------------------------------------------------------------
//  Turns (normalized planning packet, selected components) into a strict
//  layoutPlan with groups. This is the step that actually *composes* UI —
//  Steps 1–3 narrow semantics; Step 4 produces structure.
// ---------------------------------------------------------------------------

function buildComposerPrompt() {
  return `You are a layout composer for a state-based generative UI system.

You receive:
- a normalized planning packet from STEP 2
- a selected component list from STEP 3

Your job is to produce a strict layout plan.
You must compose, not invent.

You must NOT:
- invent new components
- reinterpret the original scenario
- generate free-form UI prose
- output visual styling commentary
- ignore the uiState
- rename component ids

You must:
- choose a layout container strategy
- assign variants to selected components
- decide ordering, grouping, and placement
- apply spacing and padding decisions
- decide whether lower-priority items should be visible, collapsed, or hidden
- preserve primary tasks first
- produce strict JSON only

Return STRICT JSON with this shape:

{
  "layoutPlan": {
    "container": "vertical-stack | horizontal-stack | grid | overlay-stack",
    "backgroundPolicy": "wallpaper | solid-dark | scrim-over-wallpaper | scrim-over-app | dialog-surface",
    "padding": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
    "gap": 0,
    "groups": [
      {
        "groupId": "",
        "purpose": "",
        "role": "chrome | primary-task | supporting | tertiary | meta",
        "container": "vertical-stack | horizontal-stack | grid",
        "gap": 0,
        "children": [
          {
            "componentId": "",
            "variant": "",
            "slot": "",
            "role": "chrome | subject | state | action | feedback | context | navigation",
            "placement": "top | middle | bottom | leading | trailing | full-width",
            "priority": 1,
            "visibility": "visible | collapsed | hidden"
          }
        ]
      }
    ]
  },
  "composerNotes": {
    "layoutStrategy": "",
    "priorityPreservation": [],
    "collapsedComponents": [],
    "whyThisStructure": []
  }
}

TASK-UNIT THINKING (this is the core composer responsibility):
A "primary-task" group is the screen's main task unit. It bundles together
the components a user looks at and acts on as one logical thing:
  - 1 subject (the artifact: recipe step, message, song)
  - 0..n state (status: timer, progress, step counter, percent)
  - 0..n action (buttons / chips / toggles that operate on the subject)
  - 0..1 feedback (response to a recent action)
A user should look at a primary-task group and feel "these belong together."

Other group roles:
  - chrome      — wraps status bars, app bars, gesture bars (purely structural)
  - supporting  — context cards that frame the primary task (weather next to clock, tip card next to recipe)
  - tertiary    — lower-importance items (badges, secondary notifications)
  - meta        — meta-actions / overflow / settings shortcuts

Carry-over fields from Selected Components:
- children[].slot — copy verbatim from Selected Components. This is how the renderer identifies sibling task-unit members.
- children[].role — copy verbatim from Selected Components, refining ONLY when grouping requires (e.g. an "action" chip placed inside a chrome group becomes "navigation").

Examples of GOOD task units:
  group role=primary-task:
    - subject:    recipe_step_card     (slot=current_instruction)
    - state:      step_progress_bar    (slot=progress_3_of_5)
    - action:     next_button          (slot=advance_step)
  group role=primary-task:
    - subject:    media_card           (slot=now_playing)
    - state:      progress_bar         (slot=playback_position)
    - action:     play_pause_button    (slot=playback_control)

Anti-pattern (do NOT emit):
  group role=supporting:
    - context: action_chip   (action chip in a supporting group is incoherent — actions belong with their subject)
  **Fragmented mosaic / “speckled” UI**: many same-scale small cards floating on wallpaper with **no single dominant block** (e.g. separate tiles for step counter, media strip, section title, recipe tags, hero image, and primary CTA). Merge into **one priority=1 hero** plus supporting column or stack; do not leave six sibling micro-surfaces with equal visual weight.

INFORMATION HIERARCHY (exposure + optical weight — mandatory):
  - Stack vertically so **what must be noticed first** is **closest to the top** after chrome: primary factual/task headline → live/step/timer/state → supporting/recipe meta → actions/chips → tertiary fluff.
  - Within each band use **priority**: numeric **1 = focal hero** (exactly ONE priority=1 body component per primary-task unless scenario genuinely needs twin heroes — rare); **2** secondary readable tiles; **3** collapsible/supplementary only.
  - **Large anchor rule**: That priority=1 body item MUST read as **large on the handset** — not a pill or postage-stamp card. Prefer one tall subject (step + image + headline), one full-width media/recipe surface, or grid row where the **first column is clearly the tall hero** (~58% width) and the other column is compact actions. Cooking / recipe / step flows: combine “tonight’s recipe” + visual + current step into **one** rich subject where the pipeline allows; satellites (music, timers) sit **beside or below** it, not as a fleet of equal islands.
  - Match **size to importance**: the focal component carries the largest titles/step prose permitted by its component pattern (prefer richer reminder/input/message variants over cramped chips for THE answer).
  - Do NOT bury the user’s main instruction below timers or accessory banners unless those timers ARE the headline scenario.

One UI fidelity (mandatory for generated layouts):
  - primary-task **defaults** to vertical-stack with subject → state → actions top-to-bottom, **but** use **grid (2 columns)** or **horizontal-stack** when the task pairs a **tall hero** (recipe/media/focus summary, step card, media strip) with a **compact action column** (Repeat, timers, chips, contained buttons) — same pattern as guided cooking, workouts, and reader apps. Follow the Reference Layout order when it already specifies grid/horizontal-stack.
  - **Bottom-sheet / modal flows** (\`overlayType\` implies system dialog, or \`backgroundPolicy\` is \`dialog-surface\` / \`scrim-over-app\`): treat the body as a **sheet-shaped** stack — full-width rounded cards (design token **dialog** radius ≈36px / One UI squircle), primary CTA anchored **low** in the primary-task group, scrim-dimming implied by policy; avoid scattering tiny floating tiles at the top only.
  - **E-book / reading-status / chapter / bookmark flows** — the surface does **not** have to be a full canvas of balanced 2×2 tiles. Valid patterns include: (a) a normal in-app stack/grid when the scenario is a full "reading status" screen; (b) **sheet-only** chrome — when \`uiState\` uses dialog/bottom-sheet (see \`overlayType\` / \`backgroundPolicy\`), use **one** tight primary-task **vertical-stack** (progress/summary + \`action_chip_row\` / \`media_control_bar\` / page \`btn-contained\`) with **no** mosaic of sibling glance tiles; (c) **quick-bar** style — one **meta** or **supporting** horizontal band (compact stats + \`action_chip_row\`) and **minimal** primary-task (or only chrome + that band) when the scenario implies "peek" / "quick controls". Prefer \`media_control_bar\` or dense chip rows for page/skip/bookmark affordances in (b)–(c).
  - **In-app reader “status” screens** (two glance blocks + bookmark/tools): put **both** \`reminder_card\` / \`input_summary_card\`-style tiles in the **same** \`primary-task\` \`grid\` (\`gridColumns: 2\`) so they sit **side-by-side**; place \`action_chip_row\` (bookmark / typography / search / contents) in a **\`meta\`** band **below** — wide control bar at the bottom, not a third full-width card sandwiched between tiles. Do not leave one tile in \`supporting\` and one in \`primary\` if both are the same scale — one grid group prevents a lopsided left column.
  - On app surfaces, do NOT emit \`quick_toggle_row\` unless the uiState overlay is quick-settings — use \`action_chip_row\` / \`btn-contained\` for Save/Share/Timer-style actions (quick toggles are Quick Settings affordances, not floating app footers).
  - Keep action \`btn-contained\` / chips AFTER chip rows so touch targets do not overlap in the same band.
  - Cooking / recipe: first subject card should be textual step or reminder suitable for a thumbnail (downstream may attach \`content.imageUrl\`). **Maps / commute / running / hiking / trail / GPS**: favor \`navigation_turn_card\`, \`eta_card\`, or a route-style \`reminder_card\`/\`widget-small\`; server post-processing may attach an **OpenStreetMap static preview** to the first eligible card without \`imageUrl\`. You may still set \`content.imageUrl\` to a real https map/hero image when you have one.

PREMIUM DISCOVERY / CATALOG APP (travel · hotels · experiences · food browse · tours — “consumer-grade” density):
  - **Visual hierarchy**: one **hero band** first (priority=1): scenic subject — \`focus-block\` / \`media-card\` / rich \`reminder_card\` with \`content.imageUrl\` when the planner allows imagery — then a **clean vertical-stack** body (not scattered micro-cards repeating the same headline).
  - **Sheet rhythm**: section label (e.g. “Category”) → **pill-tab** / chip filters → **full-width listing cards** with stable proportions (~16:9 hero image feel); overlay location + rating on the image with readable contrast — avoid splitting one destination into three thin rows.
  - **Spacing contract**: set \`layoutPlan.gap\` to **~10** (8–10 clamped in renderer) and \`layoutPlan.padding\` left/right to **20–22** on these flows; keep vertical spacing uniform band-to-band.
  - **Chrome**: when components include \`bottom-navigation\` / \`pill-tab\`, reflect active state and pin navigation per reference layout; search-field / collapsed-app-bar copy should read like product UI (“Where to?”), not scenario prose.

Structured content for dialog registry rows (when these appear in Selected Components, include in each child’s \`content\` in the downstream content-filling stage):
  - \`dialog.icon-grid-box\` → \`content.apps\` or \`content.items\`: [{ "name": "…", "icon": "optional-keyword" }]
  - \`dialog.browser-top-bar\` → \`content.shortcuts\`: [{ "label": "…", "icon": "optional-keyword" }] or label/value lists split on punctuation
  - \`dialog.website-share-header\` → \`content.siteName\` (or label) + \`content.url\` (or value); when you know the site/domain, **always** add \`content.logoUrl\` or \`iconUrl\` (https favicon or CDN logo) so the header tile shows a real image — never rely on the placeholder glyph alone.
  - \`status-bar\` → optional numeric \`content.battery\` (0–100), \`content.wifi\` or \`wifiStrength\` (0–3 bars), \`content.cellular\` (0–4 bars), \`content.carrier\`; the renderer maps these to bundled SVG signal icons.
  - \`action_chip_row\` / buttons → \`content.actions\`: [{ "label": "…", "icon": "keyword | https URL | app-icons/File.png", "iconUrl": "optional alias for raster", "kind": "primary"|"secondary" }]. Use SVG keywords (\`clock\`, \`pin\`, …) or a **real raster**: \`app-icons/Health.png\`, \`assets/figma/...\`, or \`https://…\` — the action-row renderer paints them as 20×20 chips.

## Reference Layout

You will also receive a **Reference Layout** generated deterministically by the
design system engine (generator.js). It encodes One UI design guidelines:
  - Component ordering by weight (chrome → widgets → containers → navigation)
  - Screen-specific anchor positions (clock block, shortcut row, top status)
  - Mandatory components for the screen type
  - Pair-gap rules between adjacent component roles
  - Touch-target minimums and density constraints

**You MUST follow the Reference Layout ordering.** The reference determines:
  1. Which component comes first, second, third, etc.
  2. Which components anchor to fixed positions (top, bottom)
  3. The container strategy and spacing values

You MAY diverge from the reference ONLY when:
  - You need to group components that the reference lists sequentially
    (e.g., wrapping 3 chips into a horizontal-stack group is fine)
  - The reference has no opinion on a component (not listed) — place it
    by priority relative to its neighbors
  - attentionMode or densityMode require collapsing — drop from the
    reference tail first (highest index = lowest priority)

You MUST NOT reorder components against the reference. If the reference says
[status-bar, app-bar, content-card, bottom-nav], your groups[].children[]
must emit them in that exact sequence (possibly across groups).

Navigation components (bottom-nav, pill-tab, tab-bar) with placement "bottom"
in the reference MUST appear in the LAST group with placement: "bottom".

Composition rules:
- respect uiState.attentionMode
- respect uiState.densityMode
- respect uiState.interactionMode

VISIBILITY RULES (strict — over-collapsing is the most common quality regression):
- DEFAULT visibility = "visible" for ALL selected components
- priority=1 components: ALWAYS visible. Never collapse, never hide. Non-negotiable.
- priority=2 components: visible by DEFAULT. Only mark "collapsed" if you have CONCRETE evidence of viewport overflow (e.g. 6+ stacked cards on a 932px lock screen). Do NOT collapse priority-2 just because densityMode is "compressed" — compressed means tighter spacing, not fewer items.
- priority=3 components: visible by default. Mark "collapsed" only when (a) densityMode === "compressed" AND (b) you actually run out of vertical room.
- "hidden" is a last resort — almost never use it.
- If you mark anything as "collapsed", emit a brief one-line justification in composerNotes.collapsedComponents naming the overflow you anticipated.

Layout rules:
- if attentionMode is glanceable, prefer vertical-stack or simple overlay-stack (but glanceable does NOT mean "fewer components" — it means easier-to-scan layout)
- avoid dense multi-column layouts in glanceable mode
- if interactionMode is minimal-touch, prefer larger full-width or simply stacked components
- if overlayType is not none, assume limited usable space
- if backgroundPolicy is solid-dark, do not imply wallpaper-dependent layout logic
- componentId MUST match a componentType from the Selected Components list verbatim
- EVERY entry in Selected Components MUST appear in groups[].children[] at least once — silent omission is a hard error
- layoutPlan.backgroundPolicy MUST equal uiState.backgroundPolicy
- layoutPlan.padding and gap SHOULD match the Reference Layout spacing values
- output composition decisions, not descriptive prose

LAYOUT TEMPLATE INFERENCE (Tier 3 — pick a richer container shape based on the scenario, not always vertical-stack):
- HOME surface with 3+ widget cards (weather/calendar/widget-*) → use a "grid" container for the widget group (2-column). Same for quick-settings overlay (toggle row in grid).
- LOCK surface with media playback active → group should still be vertical-stack but reserve a hero slot for the media-card / now-bar.media-player at the top of primary-task.
- LOCK surface with 4+ small widgets (clock + weather-date + battery + activity + shortcut) → "grid" inside primary-task so they tile 2-up.
- **2×2 / “two rows of two” dashboards** (running summary + weather + filters + today, briefing tiles): put **all** compact glance cards in **one** \`primary-task\` group with \`container: "grid"\`, \`gridColumns: 2\`. This is valid even when \`attentionMode\` is **glanceable** if every child is a dashboard tile (\`reminder_card\`, \`weather_glance_card\`, \`*_summary_card\`, \`eta_card\`, \`input_summary_card\`, \`widget-small\`). Place a wide **action row** (\`action_chip_row\` or several \`btn-*\`) in a **separate** \`meta\` or \`supporting\` group below — full-width pill cluster, not inside the 2×2 unless it is also a button strip spanning the grid width.
- **Avoid a lone full-width glance “banner” under a 2-up grid:** When you already have two (or more) dashboard tiles in a \`primary-task\` **grid**, do **not** park another \`reminder_card\` / summary / \`eta_card\` / \`widget-small\` **alone** in the next \`supporting\` or \`tertiary\` \`vertical-stack\` — it stretches edge-to-edge and wastes horizontal space vs the tiles above. Keep **all** same-class glance peers in that **same** \`grid\` (2×N). Use a follow band only for **actions** (chips, buttons) or for a **different** large hero (e.g. map, media-card). Transit passes / fare summaries / ticket status should **tile**, not span solo under paired widgets.
- **Transit / metro pass / OMNY · MetroCard:** If the hero tile already names the pass (e.g. **7-day unlimited**), do **not** add a second medium **"FARE & PASSES"** / pricing explainer card underneath — fold OMNY vs MetroCard / pay-per-ride into the **same** card, \`action_chip_row\` pills, or **omit**. One pass story → one glance surface; avoid the stacked “medium bar” that only repeats purchase detail.
- APP surface with 1 dominant subject + other supporting cards → still put the subject FIRST with priority=1 hero; use vertical-stack when a single full-width hero must span above accessory rows.
- APP surface with chip rows OR action rows → those go in horizontal-stack groups; the rest stays vertical-stack.
- Food delivery, recipe catalog, takeout, or “order food” flows (when the scenario is NOT flight/travel/airport): structure like a store app — one primary-task group uses **grid** for category/filter tiles (widget-small or compact chips), then ONE large hero subject card beneath (detail + price + quantity + primary CTA). Avoid duplicating the same uppercase section header (“TODAY” / category) across multiple separate cards unless they show genuinely different semantic content.
- Guided cooking / live recipe steps — and **any** hands-busy app step with the same shape: when a tall **subject** card (ingredients, photo, step headline, media summary) and a narrower **action** cluster (Repeat, timer chips, Next, contained buttons) are BOTH primary-task peers, put them **side-by-side** — primary-task **grid** (2 columns, preferred) or **horizontal-stack** with **exactly two** children (hero column + action/timer column). The renderer biases ~58% / ~42% width (hero / actions). Use vertical-stack for extra bands below (full-width prose, bottom rails).
- **Anti-fragmentation — cooking / recipe step / kitchen session:** Do **not** model the screen as many same-scale \`reminder_card\` / \`input_summary_card\` tiles in one \`grid\` (step + “today” peek + “up next” + timer + chips as separate grid cells). That yields a **scattered mosaic**, odd vertical holes, and clipped columns. Instead: **one** dominant current-step card (or step + photo), **one** companion column OR band with timer (\`media_control_bar\` as timer) + optional compact “up next” line **merged into the step card or the column**, then **one** full-width \`action_chip_row\` / \`meta\` strip for Repeat / add time / next / voice — like a single **stove session** surface, not a dashboard of widgets.
- **2×2 (or 3+) control tiles** — Repeat / timer / ingredient shortcuts / quick actions: prefer \`container: "grid"\`, \`gridColumns: 2\`, **group role \`meta\`**, ordered **after** primary-task + supporting + tertiary so the cluster sits **low on the sheet** (just above the wide \`btn-contained\` primary CTA and gesture bar). If you only have \`action_chip_row\`, still use role \`meta\` for that row when it is a dense control strip. Do not park these grids in the middle of the scroll above the hero unless the scenario is a pure control dashboard.
- NOTIFICATION-SHADE overlay → vertical-stack with notif-card / notif-card-ai stacked (no grid).
- Pick container='grid' when groups[].children would otherwise repeat the same component type 3+ times (e.g. 4 toggle chips, 4 widgets) — grid avoids the "wall of identical cards" anti-pattern.

CONTAINER COVERAGE EXPECTATION:
- Don't always pick vertical-stack. A typical good output uses 2-3 different container types across its groups (e.g., chrome=vertical-stack, primary-task=grid for widgets, supporting=vertical-stack for content cards).

CONTENT COHERENCE — avoid overlapping copy and over-splitting:
- NEVER place the same headline/session title on multiple visible tiles (e.g. identical "Morning run" on a glance card, a section-only header, AND a music strip). One semantic fact → one surface.
- Workout / running + playback: put stats in ONE focal card; use **one** media primitive (\`media_control_bar\`, \`now-bar\` with type media, OR \`media-card\`) — not parallel reminder_card / input_summary_card rows that only repeat track or run name.
- Preset components (\`now-bar\`, \`media-card\`, \`media-half\`, \`widget-small\`) ship with fixed proportions — prefer **vertical-stack** (hero → timer pill → media strip → actions) when mixing dense session UI; reserve **grid** for independent tiles (e.g. weather + calendar), not for duplicated left/right copies of the same story.

VIEWPORT FILL (full-frame composition — not a tiny cluster at the top):
- Compose so the PRIMARY-TASK REGION visually dominates the handset: it should occupy most of the vertical space users see between top chrome and gesture area (~70%+ perceived fill). Never output only two short cards pinned to the top with the rest dead black unless attention_mode is glanceable AND the scenario explicitly requests a minimal readout (e.g. single metric).
- For workout, running, fitness, cycling, hiking, GPS, navigation, maps, activity tracking: (1) put a LARGE hero first inside primary-task — prefer navigation_turn_card, media-card, eta_card paired with glance context, reminder_card showing route/stats, or widget-small for distance/heart zone; (2) stack timer / pace / BPM / media as **secondary bands under the hero** (vertical-stack preferred) — avoid 2-column grids that pair duplicate activity + music summaries; (3) MUST include explicit actions (btn-contained / action_chip_row) for Pause, End lap, Lap, Voice cue, Share — not metrics alone.
- If the planner selected fewer than 4 body components for a dense activity scenario, compensate with diversified types (state + subject + context + action) rather than shrinking the canvas footprint — the composer should still structure the PRIMARY group to fill vertical space via a tall dominant slot + spacer-friendly vertical-stack layout.`;

}

// ---------------------------------------------------------------------------
//  STEP 4 — VALIDATION (hard checks)
//  ---------------------------------------------------------------------------
//  Operates on the normalized composer output (camelCase, groups-based).
//  Returns canonical violation rows with stage='layout'.
// ---------------------------------------------------------------------------

function validateLayout(layoutPlan, uiState, plan, referenceLayout) {
  const violations = [];
  const lp     = layoutPlan || {};
  const groups = Array.isArray(lp.groups) ? lp.groups : [];
  const idGen  = makeIdGen('layout-v');

  const selectedTypes = new Set(
    ((plan && plan.requiredComponents) || [])
      .map(c => c.componentType)
      .filter(Boolean)
  );

  const allChildren = [];
  groups.forEach(g => {
    (g.children || []).forEach(ch => {
      allChildren.push({ ...ch, _groupId: g.groupId, _groupContainer: g.container });
    });
  });

  // 1. unknown componentIds
  allChildren.forEach(ch => {
    if (!selectedTypes.has(ch.componentId)) {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'unknown_component_id',
        category: 'consistency',
        severity: 'high',
        status:   'review-required',
        element:  ch.componentId,
        property: 'componentId',
        actual:   ch.componentId,
        expected: Array.from(selectedTypes),
        message:  `componentId "${ch.componentId}" is not in STEP 3 requiredComponents`
      }));
    }
  });

  // 2. invalid variants (registry states)
  allChildren.forEach(ch => {
    if (!REGISTRY || !REGISTRY.components) return;
    const spec = REGISTRY.components[ch.componentId];
    if (!spec) return;
    const states = Array.isArray(spec.states) ? spec.states : [];
    if (!ch.variant || ch.variant === 'default') return;
    if (!states.includes(ch.variant)) {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'invalid_variant',
        category: 'vocabulary',
        severity: 'medium',
        status:   'review-required',
        element:  ch.componentId,
        property: 'variant',
        actual:   ch.variant,
        expected: states,
        message:  `variant "${ch.variant}" not in registry states [${states.join(', ')}] for "${ch.componentId}"`
      }));
    }
  });

  // 3. densityMode === 'compressed' → priority 3 must not remain visible
  if (uiState && uiState.densityMode === 'compressed') {
    allChildren.forEach(ch => {
      if (ch.priority === 3 && ch.visibility === 'visible') {
        violations.push(buildViolation({
          id:       idGen(),
          stage:    'layout',
          ruleId:   'compressed_priority3_visible',
          category: 'layout',
          severity: 'medium',
          status:   'auto-fixable',
          element:  ch.componentId,
          property: 'visibility',
          actual:   'visible',
          expected: 'collapsed|hidden',
          message:  `priority 3 child "${ch.componentId}" must be collapsed or hidden when densityMode=compressed`,
          autoFix:  { possible: true, action: 'setVisibility', value: 'collapsed' }
        }));
      }
    });
  }

  // 4. attentionMode === 'glanceable' → no top-level grid, no grid groups with >2 children
  if (uiState && uiState.attentionMode === 'glanceable') {
    if (lp.container === 'grid') {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'glanceable_forbids_grid_root',
        category: 'layout',
        severity: 'high',
        status:   'review-required',
        element:  'layoutPlan',
        property: 'container',
        actual:   'grid',
        expected: 'vertical-stack|overlay-stack',
        message:  'attentionMode=glanceable forbids grid as top-level container'
      }));
    }
    groups.forEach(g => {
      if (g.container !== 'grid') return;
      const vis = (g.children || []).filter(ch => !ch.visibility || ch.visibility === 'visible');
      if (vis.length <= 2) return;
      const allDashboardTiles = vis.every(ch =>
        DASHBOARD_TILE_COMPONENT_IDS.has(ch.componentId || '')
      );
      if (allDashboardTiles) return; // 2×2 / multi-row compact dashboards (One UI widget grid)
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'glanceable_grid_too_wide',
        category: 'layout',
        severity: 'medium',
        status:   'review-required',
        element:  g.groupId,
        property: 'children.length',
        actual:   vis.length,
        expected: 2,
        delta:    vis.length - 2,
        message:  `attentionMode=glanceable forbids grid groups with >2 visible children unless all are compact dashboard tiles (found ${vis.length})`
      }));
    });
  }

  // 5. interactionMode === 'minimal-touch' → no dense horizontal clusters
  if (uiState && uiState.interactionMode === 'minimal-touch') {
    groups.forEach(g => {
      if (g.container === 'horizontal-stack' && (g.children || []).length > 3) {
        violations.push(buildViolation({
          id:       idGen(),
          stage:    'layout',
          ruleId:   'minimal_touch_dense_cluster',
          category: 'touch-target',
          severity: 'medium',
          status:   'review-required',
          element:  g.groupId,
          property: 'children.length',
          actual:   (g.children || []).length,
          expected: 3,
          delta:    (g.children || []).length - 3,
          message:  `interactionMode=minimal-touch forbids horizontal-stack groups with >3 children (found ${(g.children||[]).length})`
        }));
      }
    });
  }

  // 6. overlayType !== 'none' → at most 2 groups with visible children
  if (uiState && uiState.overlayType && uiState.overlayType !== 'none') {
    const visibleGroups = groups.filter(g => (g.children || []).some(ch => ch.visibility === 'visible'));
    if (visibleGroups.length > 2) {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'overlay_too_many_groups',
        category: 'layout',
        severity: 'medium',
        status:   'review-required',
        element:  'layoutPlan',
        property: 'groups.visibleCount',
        actual:   visibleGroups.length,
        expected: 2,
        delta:    visibleGroups.length - 2,
        message:  `overlayType=${uiState.overlayType} limits visible groups to 2; found ${visibleGroups.length}`
      }));
    }
  }

  // 7. priority 1 must remain visible
  allChildren.forEach(ch => {
    if (ch.priority === 1 && (ch.visibility === 'hidden' || ch.visibility === 'collapsed')) {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'priority1_removed',
        category: 'consistency',
        severity: 'high',
        status:   'review-required',
        element:  ch.componentId,
        property: 'visibility',
        actual:   ch.visibility,
        expected: 'visible',
        message:  `priority 1 component "${ch.componentId}" must not be hidden or collapsed`
      }));
    }
  });

  // 8. backgroundPolicy mismatch
  if (uiState && uiState.backgroundPolicy && lp.backgroundPolicy
      && lp.backgroundPolicy !== uiState.backgroundPolicy) {
    violations.push(buildViolation({
      id:       idGen(),
      stage:    'layout',
      ruleId:   'background_policy_mismatch',
      category: 'context',
      severity: 'high',
      status:   'review-required',
      element:  'layoutPlan',
      property: 'backgroundPolicy',
      actual:   lp.backgroundPolicy,
      expected: uiState.backgroundPolicy,
      message:  `layoutPlan.backgroundPolicy=${lp.backgroundPolicy} must equal uiState.backgroundPolicy=${uiState.backgroundPolicy}`
    }));
  }

  // 9. Reference Layout ordering check
  //    Verify the LLM's output follows the deterministic reference ordering.
  //    Emits medium-severity violations for out-of-order components and
  //    high-severity for navigation components not placed at the bottom.
  if (referenceLayout && Array.isArray(referenceLayout.orderedComponents)) {
    const refOrder = referenceLayout.orderedComponents.map(r => r.componentId);
    // Extract the LLM's actual ordering by walking groups[].children[]
    const actualOrder = [];
    groups.forEach(g => {
      (g.children || []).forEach(ch => {
        if (ch.visibility !== 'hidden') actualOrder.push(ch.componentId);
      });
    });

    // Check pairwise ordering: for any two components A,B where A appears
    // before B in refOrder, A should also appear before B in actualOrder.
    const refIdx = {};
    refOrder.forEach((id, i) => { refIdx[id] = i; });
    for (let i = 0; i < actualOrder.length - 1; i++) {
      const a = actualOrder[i], b = actualOrder[i + 1];
      if (refIdx[a] != null && refIdx[b] != null && refIdx[a] > refIdx[b]) {
        violations.push(buildViolation({
          id:       idGen(),
          stage:    'layout',
          ruleId:   'reference_order_mismatch',
          category: 'ordering',
          severity: 'medium',
          status:   'review-required',
          element:  b,
          property: 'order',
          actual:   `${a} (ref#${refIdx[a]}) before ${b} (ref#${refIdx[b]})`,
          expected: `${b} before ${a} per reference`,
          message:  `"${a}" appears before "${b}" but reference layout expects the opposite order`
        }));
      }
    }

    // Check navigation anchor: nav components must be in the last group
    const navRefEntries = referenceLayout.orderedComponents.filter(r => r.placement === 'bottom');
    const navIds = new Set(navRefEntries.map(r => r.componentId));
    if (navIds.size > 0 && groups.length > 0) {
      const lastGroup = groups[groups.length - 1];
      const lastGroupIds = new Set((lastGroup.children || []).map(ch => ch.componentId));
      navIds.forEach(navId => {
        if (actualOrder.includes(navId) && !lastGroupIds.has(navId)) {
          violations.push(buildViolation({
            id:       idGen(),
            stage:    'layout',
            ruleId:   'nav_not_at_bottom',
            category: 'ordering',
            severity: 'high',
            status:   'review-required',
            element:  navId,
            property: 'placement',
            actual:   'not in last group',
            expected: 'last group (bottom-anchored)',
            message:  `"${navId}" must be in the last layout group (bottom-anchored per One UI guidelines)`
          }));
        }
      });
    }
  }

  // 10. Task-unit coherence: every primary-task group must contain a subject child.
  //     Without a subject, the group has no central artifact for the user to act
  //     on — children become a flat pile rather than a coherent task unit.
  groups.forEach(g => {
    if (g.role !== 'primary-task') return;
    const visibleChildren = (g.children || []).filter(ch => ch.visibility !== 'hidden');
    const hasSubject = visibleChildren.some(ch => ch.role === 'subject');
    if (visibleChildren.length > 0 && !hasSubject) {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'primary_task_missing_subject',
        category: 'composition',
        severity: 'medium',
        status:   'review-required',
        element:  g.groupId,
        property: 'children[].role',
        actual:   visibleChildren.map(c => c.role),
        expected: 'at least one role="subject"',
        message:  `primary-task group "${g.groupId}" has no subject child; a primary task must center on one artifact (use role="subject" on its main component)`
      }));
    }
  });

  // 11. Orphan actions: action children should sit in a primary-task group near
  //     their subject. An action in a chrome / supporting group is usually a
  //     misclassification (e.g. a "Save" button placed in chrome).
  groups.forEach(g => {
    if (g.role !== 'chrome' && g.role !== 'supporting') return;
    const orphans = (g.children || []).filter(ch =>
      ch.role === 'action' && ch.visibility !== 'hidden');
    orphans.forEach(ch => {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'orphan_action',
        category: 'composition',
        severity: 'low',
        status:   'review-required',
        element:  ch.componentId,
        property: 'group.role',
        actual:   g.role,
        expected: 'primary-task',
        message:  `action child "${ch.componentId}" sits in a ${g.role} group; actions should live in a primary-task group near their subject`
      }));
    });
  });

  // 12. Duplicate content across slots — when two requiredComponents share a
  //     componentType, their content.label / content.value must differ. The
  //     selector LLM tends to repeat placeholder text across slots when the
  //     scenario implies the same atomic for multiple purposes (e.g. three
  //     input_summary_cards all saying "Ingredients / Quantities..."). This
  //     catches it programmatically so the user sees a clear violation
  //     instead of silently-bad output.
  const _planComps = ((plan && plan.requiredComponents) || []);
  const _bySharedType = {};
  _planComps.forEach(c => {
    if (!c.componentType) return;
    if (!_bySharedType[c.componentType]) _bySharedType[c.componentType] = [];
    _bySharedType[c.componentType].push(c);
  });
  Object.keys(_bySharedType).forEach(type => {
    const peers = _bySharedType[type];
    if (peers.length < 2) return;
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        const a = peers[i], b = peers[j];
        const aL = (a.content && a.content.label) || '';
        const aV = (a.content && a.content.value) || '';
        const bL = (b.content && b.content.label) || '';
        const bV = (b.content && b.content.value) || '';
        const aSlot = a.slot || '';
        const bSlot = b.slot || '';
        if (aSlot !== bSlot && aL === bL && aV === bV) {
          violations.push(buildViolation({
            id:       idGen(),
            stage:    'layout',
            ruleId:   'duplicate_content_across_slots',
            category: 'content',
            severity: 'medium',
            status:   'review-required',
            element:  type,
            property: 'content',
            actual:   { slotA: aSlot, slotB: bSlot, label: aL, value: aV },
            expected: 'distinct content per slot',
            message:  `"${type}" appears in slots "${aSlot}" and "${bSlot}" with identical content — each slot needs distinct, scenario-specific text`
          }));
        }
      }
    }
  });

  // 13. Subject with generic label — a component with role="subject" is the
  //     screen's primary artifact. Its label should be concrete + scenario-
  //     specific, NOT a generic placeholder ("Item", "Content", "Untitled",
  //     "Label", or empty). Catches cases where the LLM puts a real
  //     componentType in the subject slot but never wrote real label text.
  const _GENERIC_LABEL = /^\s*(item|content|title|untitled|label|value|none|text|placeholder|input|—|-)\s*$/i;
  allChildren.forEach(ch => {
    if (ch.role !== 'subject') return;
    if (ch.visibility === 'hidden') return;
    const planEntry = _planComps.find(p =>
      p.componentType === ch.componentId &&
      (!ch.slot || p.slot === ch.slot)
    );
    if (!planEntry) return;
    const label = (planEntry.content && planEntry.content.label) || '';
    if (!label || _GENERIC_LABEL.test(label)) {
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'subject_generic_label',
        category: 'content',
        severity: 'medium',
        status:   'review-required',
        element:  ch.componentId,
        property: 'content.label',
        actual:   label || '(empty)',
        expected: 'concrete, scenario-specific label',
        message:  `subject "${ch.componentId}" (slot="${ch.slot || planEntry.slot}") has empty/generic label "${label}" — the screen's main artifact must have concrete text`
      }));
    }
  });

  // 14. Action role only when scenario implies action — a child with role
  //     "action" should correspond to a control / edit / configure task,
  //     not to an inform-only scenario. Heuristic: if NONE of the plan's
  //     requiredComponents are tagged action-y in their slot name (e.g.
  //     "save", "submit", "next", "advance", "control", "edit"), and yet
  //     a layout child has role="action", flag it. This is a soft check —
  //     low severity — because the LLM may legitimately add affordances.
  const _actionSlotPattern = /save|submit|next|advance|control|edit|toggle|action|navigate|confirm|primary|cta/i;
  const _planHasActionySlot = _planComps.some(p =>
    p.role === 'action' || _actionSlotPattern.test(p.slot || ''));
  if (!_planHasActionySlot) {
    allChildren.forEach(ch => {
      if (ch.role !== 'action' || ch.visibility === 'hidden') return;
      violations.push(buildViolation({
        id:       idGen(),
        stage:    'layout',
        ruleId:   'action_without_control_task',
        category: 'composition',
        severity: 'low',
        status:   'review-required',
        element:  ch.componentId,
        property: 'role',
        actual:   'action',
        expected: 'context (or downgrade to non-action role)',
        message:  `"${ch.componentId}" is role="action" but the scenario plan has no action-implying tasks (no slot matches save/submit/next/edit/control/toggle) — verify the user can actually act here`
      }));
    });
  }

  return { violations };
}

/**
 * When the composer splits glance/dashboard tiles across several *tile-only*
 * body groups, auto-grid never sees ≥2 siblings in one stack. Merge those
 * tiles into one tile-only group so the existing auto-grid pass can
 * promote a 2-column Samsung-style widget row. Prefer **primary-task** when
 * it already holds tiles so the grid stays in the main band, not supporting.
 */
function coalesceDashboardTilesForWidgetGrid(layoutPlan, planningPacket, scenarioText) {
  if (!layoutPlan || !Array.isArray(layoutPlan.groups)) return 0;

  const ui = (planningPacket && planningPacket.uiState) || {};
  const scen = String(scenarioText || '');
  const tags = Array.isArray(ui.contextTags) ? ui.contextTags.map(String) : [];
  const wantsBrief =
    /\b(brief|briefing|dashboard|widget|glance|at-a-glance|summary|tiles?|2\s*[×x]\s*2|home\s+screen|widget\s+grid|overview)\b/i.test(scen) ||
    /(대시보드|브리핑|요약|한\s*눈|위젯|타일|홈\s*화면)/.test(scen) ||
    /\b(reading|reader|e-?book|ebook|chapter|passage|pages?\s+\d|book\s+progress|novel|audiobook|book\s+reader|reading\s+status)\b/i.test(scen) ||
    /(독서|전자책|책\s*읽기|독서\s*현황|진행\s*률|챕터|책갈피)/.test(scen) ||
    tags.some(t => /briefing|agenda|schedule|dashboard|morning|evening/i.test(t)) ||
    ui.baseSurface === 'home';

  if (!wantsBrief) return 0;

  const isVisible = ch => ch && (!ch.visibility || ch.visibility === 'visible');
  const isTile = ch => ch && DASHBOARD_TILE_COMPONENT_IDS.has(ch.componentId || '');
  const childKey = ch => `${ch.componentId || ''}\t${ch.slot || ''}`;

  const stats = layoutPlan.groups.map(g => {
    if (g.role === 'chrome' || g.container === 'horizontal-stack') {
      return { g, tileCount: 0, hasNonTileVisible: false, skip: true };
    }
    let tileCount = 0;
    let hasNonTileVisible = false;
    (g.children || []).forEach(ch => {
      if (!isVisible(ch)) return;
      if (isTile(ch)) tileCount++;
      else hasNonTileVisible = true;
    });
    return { g, tileCount, hasNonTileVisible, skip: false };
  });

  const tileOnly = stats.filter(s => !s.skip && !s.hasNonTileVisible && s.tileCount > 0);
  if (tileOnly.length < 2) return 0;

  const totalTiles = tileOnly.reduce((a, s) => a + s.tileCount, 0);
  const minTiles = isReadingBriefScenarioText(scen, { uiState: ui }) ? 2 : 3;
  if (totalTiles < minTiles) return 0;

  tileOnly.sort((a, b) => b.tileCount - a.tileCount);
  // Prefer primary-task when it is tile-only so we never drain the main band
  // into supporting (grid ended up in the yellow "supporting" stripe, felt
  // like broken / ambiguous placement).
  const primaryCand = tileOnly.find(s => s.g.role === 'primary-task');
  const target = primaryCand ? primaryCand.g : tileOnly[0].g;
  const seen = new Set();
  (target.children || []).forEach(ch => {
    if (isVisible(ch) && isTile(ch)) seen.add(childKey(ch));
  });

  let moved = 0;
  layoutPlan.groups.forEach(g => {
    if (g === target || g.role === 'chrome' || g.container === 'horizontal-stack') return;
    const next = [];
    (g.children || []).forEach(ch => {
      if (!isVisible(ch) || !isTile(ch)) {
        next.push(ch);
        return;
      }
      const k = childKey(ch);
      if (seen.has(k)) {
        next.push(ch);
        return;
      }
      seen.add(k);
      if (!target.children) target.children = [];
      target.children.push(ch);
      moved++;
    });
    g.children = next;
  });

  return moved;
}

/**
 * When the composer stacks 2+ dashboard tiles and then CTAs in ONE primary
 * vertical-stack, each card stays full-width in a column and reads as a broken
 * "staircase" of half-empty rows. Split into: primary grid (2-up tiles) +
 * trailing meta stack (buttons / chip rows), matching reader / status UIs.
 */
function splitPrimaryMixedStackToGridAndActions(layoutPlan, planningPacket, scenarioText) {
  const ui = planningPacket && planningPacket.uiState;
  if (!ui || ui.baseSurface !== 'app') return 0;
  if (!layoutPlan || !Array.isArray(layoutPlan.groups)) return 0;

  const reading = isReadingBriefScenarioText(scenarioText, planningPacket);
  const isVisible = ch => ch && (!ch.visibility || ch.visibility === 'visible');
  const isTile = ch => DASHBOARD_TILE_COMPONENT_IDS.has((ch && ch.componentId) || '');
  const ACTION_IDS = new Set([
    'action_chip_row',
    'btn-contained',
    'btn-outlined',
    'btn-flat',
    'fab',
    'chip',
    'button.dark',
    'button.light',
    'button.accent',
    'button.galaxy-ai',
    'button.header-small',
    'quick_toggle_row'
  ]);
  const isActionBand = ch => {
    if (!ch) return false;
    if (ch.role === 'action' || ch.role === 'navigation') return true;
    return ACTION_IDS.has(ch.componentId || '');
  };

  let splits = 0;
  const next = [];
  layoutPlan.groups.forEach(g => {
    const bandOk = g.role === 'primary-task' || (reading && g.role === 'supporting');
    if (!bandOk) {
      next.push(g);
      return;
    }
    const cont = g.container || 'vertical-stack';
    if (cont === 'grid' || cont === 'horizontal-stack') {
      next.push(g);
      return;
    }
    const children = (g.children || []).filter(isVisible);
    const baseId = g.groupId || 'primary';
    // Two dashboard tiles alone → 2-column row (reading / status cards).
    if (children.length === 2 && children.every(isTile)) {
      next.push(
        Object.assign({}, g, {
          groupId:     `${baseId}-tiles-2up`,
          container:   'grid',
          gridColumns: 2,
          children:    children.slice()
        })
      );
      splits++;
      return;
    }
    if (children.length < 3) {
      next.push(g);
      return;
    }
    let k = 0;
    while (k < children.length && isTile(children[k])) k++;
    if (k < 2 || k >= children.length) {
      next.push(g);
      return;
    }
    const tail = children.slice(k);
    // Reader / book-status UIs: the composer often adds a bookmark / tools row that
    // is not one of the ACTION_IDS primitives (e.g. custom row). Still split so the
    // leading glance tiles become a 2-up grid; trail becomes meta (wide bar at bottom).
    const splitTailOk =
      tail.some(isActionBand) ||
      (reading && tail.length > 0 && tail.every(ch => !isTile(ch)));
    if (!splitTailOk) {
      next.push(g);
      return;
    }

    const tiles = children.slice(0, k);
    const metaContainer =
      reading &&
      tail.length === 1 &&
      (tail[0] && tail[0].componentId) === 'action_chip_row'
        ? 'horizontal-stack'
        : 'vertical-stack';
    next.push(
      Object.assign({}, g, {
        groupId:     `${baseId}-tiles-2up`,
        container:   'grid',
        gridColumns: 2,
        children:    tiles
      })
    );
    next.push(
      Object.assign({}, g, {
        groupId:     `${baseId}-actions-trail`,
        container:   metaContainer,
        role:        'meta',
        children:    tail
      })
    );
    splits++;
  });

  if (splits > 0) layoutPlan.groups = next;
  return splits;
}

/**
 * When primary-task is already a 2-column tile grid but extra glance cards sit in a
 * following band (supporting / tertiary / meta) as vertical-stack, each renders
 * full-bleed — a "banner" under tight 2-up tiles. If that band is **only** more
 * dashboard tiles, merge into the same grid for a dense 2×N mosaic.
 */
function absorbTileOnlyFollowGroupIntoPrimaryGrid(layoutPlan) {
  if (!layoutPlan || !Array.isArray(layoutPlan.groups)) return 0;
  const ACTION_BAND = new Set([
    'action_chip_row',
    'btn-contained',
    'btn-outlined',
    'btn-flat',
    'fab',
    'chip',
    'button.dark',
    'button.light',
    'button.accent',
    'button.galaxy-ai',
    'button.header-small',
    'quick_toggle_row'
  ]);
  const isVis = ch => ch && (!ch.visibility || ch.visibility === 'visible');
  const isTile = ch => DASHBOARD_TILE_COMPONENT_IDS.has((ch && ch.componentId) || '');
  const isActionBand = ch => {
    if (!ch) return false;
    if (ch.role === 'action' || ch.role === 'navigation') return true;
    return ACTION_BAND.has(ch.componentId || '');
  };
  const followRoles = new Set(['supporting', 'tertiary', 'meta']);
  let absorbed = 0;
  for (let i = 0; i < layoutPlan.groups.length - 1; ) {
    const g0 = layoutPlan.groups[i];
    const g1 = layoutPlan.groups[i + 1];
    if (!g0 || !g1 || g0.role === 'chrome' || g1.role === 'chrome') {
      i++;
      continue;
    }
    if (g0.role !== 'primary-task' || g0.container !== 'grid') {
      i++;
      continue;
    }
    if (!followRoles.has(g1.role || '')) {
      i++;
      continue;
    }
    if (g1.container === 'horizontal-stack' || g1.container === 'grid') {
      i++;
      continue;
    }
    const v0 = (g0.children || []).filter(isVis);
    const v1 = (g1.children || []).filter(isVis);
    if (v0.length < 2 || !v0.every(isTile)) {
      i++;
      continue;
    }
    if (v1.length < 1 || !v1.every(isTile) || v1.some(isActionBand)) {
      i++;
      continue;
    }
    g0.children = (g0.children || []).concat(v1);
    const moved = new Set(v1);
    g1.children = (g1.children || []).filter(ch => !moved.has(ch));
    const restVis = (g1.children || []).filter(isVis);
    if (restVis.length === 0) {
      layoutPlan.groups.splice(i + 1, 1);
    } else {
      i++;
    }
    absorbed++;
  }
  return absorbed;
}

/** Resolve plan content by layout child slot / componentId (same idea as scenes.js). */
function _planContentResolver(plan) {
  const bySlot = new Map();
  const byTypeQueue = new Map();
  (plan && plan.requiredComponents ? plan.requiredComponents : []).forEach(c => {
    const slot = c.slot || '';
    const type = c.componentType || '';
    const content = c.content || {};
    if (slot) bySlot.set(slot, content);
    if (type) {
      if (!byTypeQueue.has(type)) byTypeQueue.set(type, []);
      byTypeQueue.get(type).push(content);
    }
  });
  return function resolveContent(ch) {
    if (ch && ch.slot && bySlot.has(ch.slot)) return bySlot.get(ch.slot);
    const t = ch && ch.componentId;
    if (t && byTypeQueue.has(t)) {
      const q = byTypeQueue.get(t);
      return q.length ? q[0] : {};
    }
    return {};
  };
}

/**
 * Transit / metro pass UIs often get a compact pass tile plus a redundant
 * "FARE & PASSES" explainer card — same story, awkward mid-size strip. Drop
 * the second when copy clearly elaborates pricing/payment vs the first tile.
 */
function suppressRedundantTransitFarePassCard(layoutPlan, plan, scenarioText, planningPacket) {
  const ui = planningPacket && planningPacket.uiState;
  if (!ui || ui.baseSurface !== 'app') return 0;
  if (!layoutPlan || !Array.isArray(layoutPlan.groups)) return 0;

  const scen = String(scenarioText || '');
  const transitPass =
    /\b(metro|subway|transit|omny|metrocard|mta|commuter|unlimited|7-?\s*day|weekly\s+pass|fare\s*pass|rail\s*pass|tap-?to-?pay|pay-?per-?ride)\b/i.test(
      scen
    ) ||
    (/\b(new\s+york|nyc|manhattan)\b/i.test(scen) && /\b(trip|travel|visit|getaway)\b/i.test(scen));

  if (!transitPass) return 0;

  const resolve = _planContentResolver(plan);
  const isVis = ch => ch && (!ch.visibility || ch.visibility === 'visible');
  const isTile = ch => DASHBOARD_TILE_COMPONENT_IDS.has((ch && ch.componentId) || '');

  const blob = c => String(((c && c.label) || '') + ' ' + ((c && c.value) || '')).toLowerCase();

  const isFarePassExplainer = c => {
    const b = blob(c);
    return (
      (/\bfare\b/.test(b) && /\bpass(es)?\b/.test(b)) ||
      /\bfare\s*[&+]?\s*pass(es)?\b/.test(b) ||
      (/\bomny\b/.test(b) && /\bmetrocard\b/.test(b)) ||
      /\bpay-?per-?ride\b/.test(b) ||
      (/\btap-?to-?pay\b/.test(b) && /\bmetro|\bomny\b/.test(b)) ||
      /\bmetrocard\b/.test(b) && /\bvs\.?\b/.test(b) && /\b(ride|fare)\b/.test(b)
    );
  };

  const isPassProductSummary = c => {
    const b = blob(c);
    return (
      (/\b(unlimited|7\s*[-–]?\s*day|weekly|monthly)\b/.test(b) &&
        /\b(pass|metrocard|omny|ride)\b/.test(b)) ||
      /\b7\s*[-–]?\s*day\b/.test(b) ||
      /\bmetrocard\b/.test(b) ||
      /\bomny\b/.test(b)
    );
  };

  let removed = 0;

  const hideSecondTileInGroup = g => {
    if (!g || g.container === 'grid' || g.container === 'horizontal-stack') return;
    const visTiles = (g.children || []).filter(ch => isVis(ch) && isTile(ch));
    if (visTiles.length < 2) return;
    const c0 = resolve(visTiles[0]);
    const c1 = resolve(visTiles[1]);
    if (!isPassProductSummary(c0) || !isFarePassExplainer(c1)) return;
    visTiles[1].visibility = 'hidden';
    visTiles[1]._suppressReason = 'redundant-fare-pass-explainer';
    removed++;
  };

  layoutPlan.groups.forEach(hideSecondTileInGroup);

  for (let i = 0; i < layoutPlan.groups.length - 1; i++) {
    const g0 = layoutPlan.groups[i];
    const g1 = layoutPlan.groups[i + 1];
    if (!g0 || !g1 || g0.role === 'chrome' || g1.role === 'chrome') continue;
    if (g0.role !== 'primary-task') continue;
    if (!['supporting', 'tertiary', 'meta'].includes(g1.role || '')) continue;

    const v0 = (g0.children || []).filter(isVis);
    const v1 = (g1.children || []).filter(isVis);
    if (v0.length !== 1 || v1.length !== 1) continue;
    if (!isTile(v0[0]) || !isTile(v1[0])) continue;

    const c0 = resolve(v0[0]);
    const c1 = resolve(v1[0]);
    if (!isPassProductSummary(c0) || !isFarePassExplainer(c1)) continue;

    v1[0].visibility = 'hidden';
    v1[0]._suppressReason = 'redundant-fare-pass-explainer';
    removed++;
    if (!(g1.children || []).some(isVis)) {
      layoutPlan.groups.splice(i + 1, 1);
      i--;
    }
  }

  if (removed) {
    layoutPlan.groups = layoutPlan.groups.filter(g => {
      if (g.role === 'chrome') return true;
      return (g.children || []).some(ch => isVis(ch));
    });
  }

  return removed;
}

/**
 * Dense 2×2-style control clusters (all actions in a grid, or a lone action_chip_row)
 * read better pinned just above the final CTA / gesture bar. Promote to role=meta and
 * append after other body groups (cooking / workout / hands-busy patterns).
 */
function pinDenseActionGridsToBottom(layoutPlan, planningPacket) {
  if (!layoutPlan || !Array.isArray(layoutPlan.groups)) return 0;
  const ui = planningPacket && planningPacket.uiState;
  if (!ui || ui.baseSurface !== 'app') return 0;

  const ACTION_IDS = new Set([
    'action_chip_row',
    'btn-contained',
    'btn-outlined',
    'btn-flat',
    'fab',
    'chip',
    'button.dark',
    'button.light',
    'button.accent',
    'button.galaxy-ai',
    'button.header-small',
    'quick_toggle_row'
  ]);
  const isVisible = ch => ch && (!ch.visibility || ch.visibility === 'visible');
  const visKids = g => (g.children || []).filter(isVisible);
  const isActionish = ch => {
    const id = (ch && ch.componentId) || '';
    const r = (ch && ch.role) || '';
    return ACTION_IDS.has(id) || r === 'action';
  };
  const subjectish = ch => {
    if (!ch || (ch.visibility && ch.visibility !== 'visible')) return false;
    if (ch.role === 'subject' || ch.role === 'state' || ch.role === 'context') return true;
    const id = ch.componentId || '';
    return /reminder_card|input_summary|message_summary|calendar_summary|eta_card|weather_glance|navigation_turn|media_control|now-bar|media-card|widget-small/i.test(
      id
    );
  };

  /** @type {typeof layoutPlan.groups} */
  const groups = layoutPlan.groups;
  const body = groups.filter(g => g.role !== 'chrome');
  const anySubjectOutside = exclude =>
    body.some(g => {
      if (g === exclude) return false;
      return (g.children || []).some(subjectish);
    });

  const isPinCandidate = g => {
    if (g.role === 'chrome') return false;
    const v = visKids(g);
    if (!v.length) return false;
    if (g.container === 'grid' && v.length >= 3 && v.every(isActionish)) return true;
    if (
      (g.container === 'vertical-stack' || !g.container) &&
      v.length === 1 &&
      v[0].componentId === 'action_chip_row'
    ) {
      return true;
    }
    return false;
  };

  const pins = body.filter(isPinCandidate);
  if (!pins.length) return 0;

  const liftable = pins.filter(g => {
    if (g.role === 'supporting' || g.role === 'tertiary' || g.role === 'meta') return true;
    if (g.role === 'primary-task' && anySubjectOutside(g)) return true;
    return false;
  });
  if (!liftable.length) return 0;

  liftable.forEach(g => {
    if (g.role !== 'meta') g.role = 'meta';
  });

  const chrome = groups.filter(g => g.role === 'chrome');
  const pinSet = new Set(liftable);
  const nonPinBody = body.filter(g => !pinSet.has(g));
  const byIdx = new Map(groups.map((g, i) => [g, i]));
  const BAND = {
    'primary-task': 1,
    supporting: 2,
    tertiary: 3,
    meta: 4
  };
  nonPinBody.sort((a, b) => {
    const ba = BAND[a.role] != null ? BAND[a.role] : 15;
    const bb = BAND[b.role] != null ? BAND[b.role] : 15;
    if (ba !== bb) return ba - bb;
    return byIdx.get(a) - byIdx.get(b);
  });
  const pinOrdered = liftable.slice().sort((a, b) => byIdx.get(a) - byIdx.get(b));
  layoutPlan.groups = chrome.concat(nonPinBody).concat(pinOrdered);

  if (liftable.length) {
    console.log(
      '[pipeline] composer post-fix: pinned ' +
        liftable.length +
        ' dense control group(s) to bottom band (meta)'
    );
  }
  return liftable.length;
}

// ---------------------------------------------------------------------------
//  STEP 4 — RUNNER
//  ---------------------------------------------------------------------------
//  LLM composer → normalize → validateLayout + context/overflow validators.
//  Returns the canonical composed output and the merged layout-stage
//  violations (still canonical rows; rollup happens at the orchestrator).
// ---------------------------------------------------------------------------

async function runComposeLayout({ planningPacket, plan, llmCall, viewport, scenarioText, fastMode }) {
  if (!llmCall)        throw new Error('runComposeLayout requires llmCall(systemPrompt, userMessage)');
  if (!planningPacket) throw new Error('runComposeLayout requires planningPacket');
  if (!plan)           throw new Error('runComposeLayout requires plan');
  const scenario = scenarioText || '';

  // --- Pre-filter: single-point component filtering via Generator rules ---
  //
  // NON-MUTATING: earlier revisions did `plan.requiredComponents = plan...
  // .filter(...)` which mutated the caller's plan object. When the
  // streaming endpoint sent `step_done.plan` (still holding the full
  // list) and then the final `done` event (observing the post-filter
  // list), the two payloads disagreed — looked like data was being
  // wiped. We now build a local filtered copy without touching the
  // shared plan.
  const uiStatePre = planningPacket.uiState;
  let filteredPlan = plan;
  if (plan && Array.isArray(plan.requiredComponents)) {
    const ids = plan.requiredComponents.map(c => c.componentType).filter(Boolean);
    const allowed = preFilterComponents(ids, uiStatePre);
    const allowedSet = new Set(allowed);
    filteredPlan = Object.assign({}, plan, {
      requiredComponents: plan.requiredComponents.filter(
        c => !c.componentType || allowedSet.has(c.componentType)
      )
    });
  }
  // For the rest of this function, use `filteredPlan` instead of `plan`.
  plan = filteredPlan;

  // --- Reference Layout: deterministic order + positions from generator.js ---
  // This gives the LLM a design-system-grounded ordering to follow rather than
  // inventing its own sequence. Generator.resolveOrder applies weight-based
  // sorting (chrome→widgets→containers→navigation→gesture), mandatory component
  // injection, collapse rules, and screen-specific anchors.
  let referenceLayout = null;
  try {
    const refIds = (plan.requiredComponents || [])
      .map(c => c.componentType).filter(Boolean);
    const uiStateRef = planningPacket.uiState || {};
    const ordered   = Generator.resolveOrder(uiStateRef, refIds, DesignMemory, { skipCollapse: true });
    const positions = Generator.resolvePositions(uiStateRef, ordered, DesignMemory);
    const spacing   = Generator.resolveSpacing(uiStateRef, DesignMemory);

    referenceLayout = {
      _note: 'Deterministic reference from One UI design system rules. Follow this ordering.',
      container: spacing ? spacing.container : 'vertical-stack',
      padding:   spacing ? spacing.outerPadding : { top: 16, right: 22, bottom: 12, left: 22 },
      gap:       spacing ? spacing.gap : 8,
      orderedComponents: positions.map(function (pos, idx) {
        return {
          index:     idx,
          componentId: pos.id,
          role:      pos.role,
          placement: (pos.top != null && pos.top <= 30) ? 'top'
                   : (pos.id && (pos.id.includes('nav') || pos.id.includes('pill-tab') || pos.id.includes('gesture'))) ? 'bottom'
                   : 'middle',
          anchorFixed: !!(pos.top != null && pos.top <= 30) ||
                       !!(pos.id && (pos.id.includes('nav') || pos.id.includes('pill-tab') || pos.id.includes('gesture'))),
          position:  { top: pos.top, left: pos.left, width: pos.width, height: pos.height }
        };
      })
    };
  } catch (e) {
    console.warn('[pipeline] Reference layout generation failed (non-fatal):', e.message);
  }

  const refSection = referenceLayout
    ? `\n\nReference Layout (from design system rules — follow this ordering):\n${JSON.stringify(referenceLayout, null, 2)}`
    : '';

  // Surface-specific KB context: ORCH frame/stacking/nesting plus the
  // assembly chapter for this base surface (lock / home / QS overlay),
  // plus all evolve.md lessons. Also re-inject scenarioText so the
  // composer can account for intent nuance lost in Step 1→2→3 paraphrasing.
  const kbContext = buildPromptContext('composer', planningPacket.uiState);

  // Focused variant reference: the composer's invalid_variant violations
  // dominated the violation log (26/37 across a 10-scenario test). Showing
  // the closed variant set per selected component makes that physically
  // impossible to repeat.
  const selectedIds = (plan.requiredComponents || []).map(c => c.componentType);
  const variantRef  = buildVariantReference(selectedIds);

  // Original prompt structure restored — moving kbContext + closed-world
  // rule into the system prompt regressed UI quality (the LLM lost the
  // "Selected Components above" anchor and emitted shallower layouts with
  // fewer components per group).
  const userMessage =
    kbContext + '\n\n---\n\n' +
    (variantRef ? variantRef + '\n\n---\n\n' : '') +
    (scenario ? `User Scenario:\n${scenario}\n\n` : '') +
    `Normalized Planning Packet:\n${JSON.stringify(planningPacket)}\n\n` +
    `Selected Components:\n${JSON.stringify(plan)}\n\n` +
    `IMPORTANT — closed-world rule:\n` +
    `1. groups[].children[].componentId MUST come ONLY from the componentType field of the entries in Selected Components above. Never introduce IDs that are not in that list, even if the surface "feels" incomplete.\n` +
    `2. EVERY entry in Selected Components MUST appear at least once in groups[].children[]. Silent omission is a hard error.\n` +
    `3. DEFAULT visibility for every child is "visible". Mark a child "collapsed" only if it is priority=3 AND densityMode is "compressed" AND you genuinely lack vertical room. Never collapse priority=1 or priority=2 by default — the user explicitly asked for them.` +
    refSection;

  const FAST_HINT_C = '\n\n[FAST MODE] Keep response MINIMAL. composerNotes.whyThisStructure[] must have at most 2 entries. priorityPreservation[] at most 2 entries. collapsedComponents[] at most 1 entry. Keep layoutPlan complete and accurate — do NOT trim groups or children.';
  const sysComp  = buildComposerPrompt() + (fastMode ? FAST_HINT_C : '');
  const raw      = await llmCall(sysComp, userMessage);
  const composed = normalizeComposerOutput(raw);
  const uiState  = planningPacket.uiState;

  // ── Post-composer chrome enforcement ──────────────────────────────
  // The composer LLM occasionally places content components inside the
  // chrome group when their slot name looks chrome-flavored (e.g.
  // "content-input_summary_card", "container-area"). This produces the
  // exact misplaced-widget symptom my Stage 3 chrome-role correction
  // tried to prevent — but at a different layer. Here we sweep the
  // composed layout: any non-chrome child sitting in a chrome group
  // gets migrated to a content group (supporting if it exists, else
  // a new primary-task slot at the end).
  if (composed.layoutPlan && Array.isArray(composed.layoutPlan.groups)) {
    const planRoleByType = {};
    (plan.requiredComponents || []).forEach(c => {
      if (c.componentType && !planRoleByType[c.componentType]) {
        planRoleByType[c.componentType] = c.role;
      }
    });
    let migrated = 0;
    const movingChildren = [];
    composed.layoutPlan.groups.forEach(g => {
      if (g.role !== 'chrome') return;
      const stayingChildren = [];
      (g.children || []).forEach(ch => {
        // Keep: explicit chrome role OR plan said chrome (mandatory-inject)
        if (ch.role === 'chrome' || planRoleByType[ch.componentId] === 'chrome') {
          stayingChildren.push(ch);
        } else {
          movingChildren.push(ch);
          migrated++;
        }
      });
      g.children = stayingChildren;
    });
    if (movingChildren.length) {
      // Find or create a destination group for migrated children.
      let dest = composed.layoutPlan.groups.find(g => g.role === 'supporting');
      if (!dest) dest = composed.layoutPlan.groups.find(g => g.role === 'primary-task');
      if (!dest) {
        dest = {
          groupId:    'group_misplaced_chrome',
          purpose:    'Components migrated out of chrome (composer misplacement)',
          role:       'supporting',
          container:  'vertical-stack',
          gap:        10,
          children:   []
        };
        composed.layoutPlan.groups.push(dest);
      }
      dest.children = (dest.children || []).concat(movingChildren);
      composed.composerNotes = composed.composerNotes || {};
      composed.composerNotes.chromeMigrated = migrated;
      console.log('[pipeline] composer post-fix: migrated ' + migrated + ' non-chrome child(ren) out of chrome groups → ' + dest.groupId);
    }
  }

  // overlay-stack is for system-dialog style surfaces; the composer
  // sometimes emits it for plain app screens, which makes flex children
  // read as stacked layers and overlap. Coerce to vertical flow.
  if (composed.layoutPlan && Array.isArray(composed.layoutPlan.groups)) {
    const ui = planningPacket && planningPacket.uiState;
    const surf = ui && ui.baseSurface;
    const ov = (ui && ui.overlayType) || 'none';
    if (surf === 'app' && ov === 'none') {
      let coerced = 0;
      composed.layoutPlan.groups.forEach(g => {
        if (g.role === 'chrome') return;
        if (g.container === 'overlay-stack') {
          g.container = 'vertical-stack';
          coerced += 1;
        }
      });
      if (coerced) {
        composed.composerNotes = composed.composerNotes || {};
        composed.composerNotes.overlayStackCoerced = coerced;
        console.log('[pipeline] composer post-fix: overlay-stack → vertical-stack on app shell (' + coerced + ' group(s))');
      }
    }
  }

  // ── Role-based child ordering (One UI canonical sequence) ─────────
  // Samsung One UI groups read top-to-bottom in this order regardless
  // of priority numeric:
  //   subject → state → context → action → feedback → navigation
  // Without this pass, the LLM sometimes places an action chip ABOVE
  // its subject card (because priority=1 was on the action) — feels
  // backwards. Within a group, this stable-sorts children by role rank.
  // Chrome group is exempt (chrome has its own structural ordering
  // driven by the reference layout: status-bar → header → gesture-bar).
  if (composed.layoutPlan && Array.isArray(composed.layoutPlan.groups)) {
    const ROLE_RANK = { subject: 1, state: 2, context: 3, action: 4, feedback: 5, navigation: 6 };
    let reordered = 0;
    composed.layoutPlan.groups.forEach(g => {
      if (g.role === 'chrome') return;
      if (!Array.isArray(g.children) || g.children.length < 2) return;
      // Pair each child with its original index for stable sort.
      const indexed = g.children.map((c, i) => ({ c, i }));
      const beforeOrder = indexed.map(x => x.c.componentId).join(',');
      indexed.sort((a, b) => {
        const ra = ROLE_RANK[a.c.role] != null ? ROLE_RANK[a.c.role] : 99;
        const rb = ROLE_RANK[b.c.role] != null ? ROLE_RANK[b.c.role] : 99;
        if (ra !== rb) return ra - rb;
        const pa = a.c.priority != null ? +a.c.priority : 2;
        const pb = b.c.priority != null ? +b.c.priority : 2;
        if (pa !== pb) return pa - pb;
        // Same role + priority → keep original order (stable)
        return a.i - b.i;
      });
      g.children = indexed.map(x => x.c);
      const afterOrder = g.children.map(c => c.componentId).join(',');
      if (beforeOrder !== afterOrder) reordered += 1;
    });
    if (reordered) {
      composed.composerNotes = composed.composerNotes || {};
      composed.composerNotes.roleReordered = reordered;
      console.log('[pipeline] composer post-fix: role-reordered ' + reordered + ' group(s) (subject→…→navigation, tie-break priority)');
    }
  }

  // ── Group band ordering — focal primary-task stack above peripheral ────
  if (composed.layoutPlan && Array.isArray(composed.layoutPlan.groups) && composed.layoutPlan.groups.length >= 2) {
    const BAND = {
      chrome: 0,
      'primary-task': 1,
      supporting: 2,
      tertiary: 3,
      meta: 4
    };
    const tagged = composed.layoutPlan.groups.map((g, i) => ({ g, i }));
    tagged.sort((a, b) => {
      const ba = BAND[a.g.role] != null ? BAND[a.g.role] : 15;
      const bb = BAND[b.g.role] != null ? BAND[b.g.role] : 15;
      if (ba !== bb) return ba - bb;
      return a.i - b.i;
    });
    composed.layoutPlan.groups = tagged.map(x => x.g);
  }

  // Split mixed stacks **before** coalescing so primary becomes a tile-only grid band;
  // otherwise a stray tile in `supporting` never merges into a mixed primary stack.
  const splitMixed = splitPrimaryMixedStackToGridAndActions(composed.layoutPlan, planningPacket, scenario);
  if (splitMixed > 0) {
    composed.composerNotes = composed.composerNotes || {};
    composed.composerNotes.primaryTileActionSplit = splitMixed;
    console.log(
      '[pipeline] composer post-fix: split ' + splitMixed + ' mixed primary stack(s) → 2-up grid + action trail'
    );
  }

  const dashCoalesced = coalesceDashboardTilesForWidgetGrid(
    composed.layoutPlan,
    planningPacket,
    scenario
  );
  if (dashCoalesced > 0) {
    composed.composerNotes = composed.composerNotes || {};
    composed.composerNotes.dashboardTilesCoalesced = dashCoalesced;
    console.log('[pipeline] composer post-fix: coalesced ' + dashCoalesced + ' dashboard tile(s) into one tile-only group for 2-col grid');
  }

  if ((splitMixed > 0 || dashCoalesced > 0) && composed.layoutPlan && Array.isArray(composed.layoutPlan.groups)) {
    const BAND = { chrome: 0, 'primary-task': 1, supporting: 2, tertiary: 3, meta: 4 };
    const tagged = composed.layoutPlan.groups.map((g, i) => ({ g, i }));
    tagged.sort((a, b) => {
      const ba = BAND[a.g.role] != null ? BAND[a.g.role] : 15;
      const bb = BAND[b.g.role] != null ? BAND[b.g.role] : 15;
      if (ba !== bb) return ba - bb;
      return a.i - b.i;
    });
    composed.layoutPlan.groups = tagged.map(x => x.g);
  }

  // ── Auto-grid: mixed glance cards + repeated tile-safe types ──────
  // Promote vertical-stack → 2-column grid when (a) every visible child is a
  // compact glance/info card (Samsung-style 2-up widget row), or (b) 2+
  // visible children share the same dominant type from GRID_FRIENDLY_IDS.
  // glanceable attentionMode: multi-child grid only when every child is a
  // compact dashboard tile (see DASHBOARD_TILE_COMPONENT_IDS + validateLayout).
  // Hero column + action column (2-up) — any hands-busy / step / media task, not only cooking.
  const SIDE_BY_SIDE_HERO_IDS = new Set([
    'reminder_card',
    'input_summary_card',
    'weather_glance_card',
    'calendar_summary_card',
    'message_summary_card',
    'eta_card',
    'media-card',
    'widget-small',
    'navigation_turn_card',
    'media_control_bar',
    'now-bar.media-player',
    'now-bar.dual-line',
    'now-bar.single-line',
    'now-bar.charging'
  ]);
  const SIDE_BY_SIDE_ACTION_IDS = new Set([
    'action_chip_row',
    'btn-contained',
    'btn-outlined',
    'btn-flat',
    'fab',
    'chip',
    'button.dark',
    'button.light',
    'button.accent',
    'button.galaxy-ai',
    'button.header-small',
    'quick_toggle_row'
  ]);
  const GRID_FRIENDLY_IDS = new Set([
    'weather_glance_card',
    'reminder_card',
    'message_summary_card',
    'calendar_summary_card',
    'eta_card',
    'input_summary_card',
    'qs-toggle',
    'quick_toggle_row',
    'shortcut',
    'shortcut_tile',
    'lock-screen.shortcut-circle',
    'widget-small',
    'badge',
    'btn-contained',
    'btn-outlined',
    'btn-flat',
    'fab',
    'chip'
  ]);
  if (composed.layoutPlan && Array.isArray(composed.layoutPlan.groups)) {
    const uiGrid = planningPacket && planningPacket.uiState;
    const glanceLimited = uiGrid && uiGrid.attentionMode === 'glanceable';
    let gridded = 0;
    composed.layoutPlan.groups.forEach(g => {
      if (g.role === 'chrome') return;
      if (g.container === 'grid' || g.container === 'horizontal-stack') return;
      const rawKids = g.children || [];
      const children = rawKids.filter(c => {
        const v = c && c.visibility;
        return !v || v === 'visible';
      });
      if (children.length < 2) return;
      if (glanceLimited && children.length > 2) {
        const allDashboardTiles = children.every(ch =>
          DASHBOARD_TILE_COMPONENT_IDS.has((ch && ch.componentId) || '')
        );
        if (!allDashboardTiles && !isReadingBriefScenarioText(scenario, planningPacket)) return;
      }

      // Cooking / hands-busy kitchen: never promote a mixed primary stack to a 2×N
      // auto-grid (many equal-weight glance cards + timer + chips) — reads as a
      // scattered mosaic and clips on narrow rails. Keep vertical-stack for composer /
      // split heuristics; pure dashboard-tile grids are still allowed.
      if (
        isGuidedCookingWorkflowScenario(scenario, planningPacket) &&
        g.role === 'primary-task' &&
        children.length >= 3
      ) {
        const allDashCook = children.every(c =>
          DASHBOARD_TILE_COMPONENT_IDS.has((c && c.componentId) || '')
        );
        if (!allDashCook) return;
      }

      const subjectActionSideBySide =
        planningPacket &&
        planningPacket.uiState &&
        planningPacket.uiState.baseSurface === 'app' &&
        g.role === 'primary-task' &&
        children.length === 2;
      if (subjectActionSideBySide) {
        const ch0 = children[0];
        const ch1 = children[1];
        const r0 = (ch0 && ch0.role) || '';
        const r1 = (ch1 && ch1.role) || '';
        const rolePair =
          (r0 === 'subject' && r1 === 'action') ||
          (r0 === 'action' && r1 === 'subject');
        const id0 = (ch0 && ch0.componentId) || '';
        const id1 = (ch1 && ch1.componentId) || '';
        const idPair =
          (SIDE_BY_SIDE_HERO_IDS.has(id0) && SIDE_BY_SIDE_ACTION_IDS.has(id1)) ||
          (SIDE_BY_SIDE_HERO_IDS.has(id1) && SIDE_BY_SIDE_ACTION_IDS.has(id0));
        if (rolePair || idPair) {
          g.container = 'grid';
          g.gridColumns = 2;
          gridded += 1;
          return;
        }
      }

      const allDashboardTiles = children.every(c =>
        DASHBOARD_TILE_COMPONENT_IDS.has(c.componentId || '')
      );
      if (allDashboardTiles) {
        g.container = 'grid';
        g.gridColumns = 2;
        gridded += 1;
        return;
      }

      const byType = {};
      children.forEach(c => {
        const t = c.componentId || '';
        byType[t] = (byType[t] || 0) + 1;
      });
      let dominant = null;
      let dominantCount = 0;
      Object.keys(byType).forEach(t => {
        if (byType[t] > dominantCount) {
          dominant = t;
          dominantCount = byType[t];
        }
      });
      if (dominantCount < 2) return;
      if (!GRID_FRIENDLY_IDS.has(dominant)) return;
      g.container = 'grid';
      g.gridColumns = 2;
      gridded += 1;
    });
    if (gridded) {
      composed.composerNotes = composed.composerNotes || {};
      composed.composerNotes.autoGridded = gridded;
      console.log('[pipeline] composer post-fix: auto-grid promoted ' + gridded + ' group(s) (glance cards / 2+ tile-friendly types)');
    }
  }

  const tileBandAbsorb = absorbTileOnlyFollowGroupIntoPrimaryGrid(composed.layoutPlan);
  if (tileBandAbsorb > 0) {
    composed.composerNotes = composed.composerNotes || {};
    composed.composerNotes.tileBandAbsorbedIntoPrimaryGrid = tileBandAbsorb;
    console.log(
      '[pipeline] composer post-fix: absorbed ' + tileBandAbsorb + ' tile-only follow band(s) into primary grid (avoid full-width glance strip)'
    );
  }

  const farePassDupDrop = suppressRedundantTransitFarePassCard(
    composed.layoutPlan,
    plan,
    scenario,
    planningPacket
  );
  if (farePassDupDrop > 0) {
    composed.composerNotes = composed.composerNotes || {};
    composed.composerNotes.redundantFarePassCardDropped = farePassDupDrop;
    console.log(
      '[pipeline] composer post-fix: hid ' + farePassDupDrop + ' redundant transit fare/pass explainer card(s)'
    );
  }

  const bottomPins = pinDenseActionGridsToBottom(composed.layoutPlan, planningPacket);
  if (bottomPins > 0) {
    composed.composerNotes = composed.composerNotes || {};
    composed.composerNotes.bottomPinnedControlGrids = bottomPins;
  }

  // Programmatic backfill: the composer LLM frequently drops Selected
  // Components silently — the closed-world rule in the prompt is advisory
  // and gets ignored under cognitive load (long prompt, many components).
  // Verified across multiple test scenarios: 7-pick plans coming back as
  // 4-child layouts. Here we deterministically append any missing plan
  // entries to an appropriate group with visibility="visible", so the
  // layout always reflects the selector's full intent.
  if (composed.layoutPlan && Array.isArray(composed.layoutPlan.groups)) {
    const groups = composed.layoutPlan.groups;
    const presentIds = new Set();
    groups.forEach(g => {
      (g.children || []).forEach(ch => {
        if (ch && ch.componentId) presentIds.add(ch.componentId);
      });
    });
    const planComps = (plan && plan.requiredComponents) || [];
    const missing = planComps.filter(c => c.componentType && !presentIds.has(c.componentType));
    if (missing.length) {
      // Bucketize by role: chrome → chrome group; everything else → primary
      // task group (or first non-chrome group; or create one).
      const findGroup = (predicate, fallbackRole) => {
        let g = groups.find(predicate);
        if (g) return g;
        // Create a new group at the appropriate position.
        g = {
          groupId:    `group_backfill_${fallbackRole}`,
          purpose:    `Backfilled missing ${fallbackRole} components`,
          role:       fallbackRole,
          container:  'vertical-stack',
          gap:        10,
          children:   []
        };
        groups.push(g);
        return g;
      };
      const backfilled = [];
      missing.forEach(comp => {
        const isChrome = comp.role === 'chrome' || comp._source === 'mandatory-inject';
        const target = isChrome
          ? findGroup(g => g.role === 'chrome', 'chrome')
          : findGroup(g => g.role === 'primary-task' || g.role === 'supporting', 'primary-task');
        target.children.push({
          componentId: comp.componentType,
          variant:     comp.variantHint || 'default',
          slot:        comp.slot || '',
          role:        comp.role || (isChrome ? 'chrome' : 'subject'),
          placement:   isChrome ? 'top' : 'middle',
          priority:    comp.priority || 2,
          visibility:  'visible',
          _source:     'composer-backfill'
        });
        backfilled.push(comp.componentType);
      });
      composed.composerNotes = composed.composerNotes || {};
      composed.composerNotes.backfilled = backfilled;
      console.log(`[pipeline] composer backfill: appended ${backfilled.length} missing component(s) to layout: ${backfilled.join(', ')}`);
    }
  }

  const hardChecks = validateLayout(composed.layoutPlan, uiState, plan, referenceLayout);

  const ctxIdGen  = makeIdGen('layout-c');
  const ovfIdGen  = makeIdGen('layout-o');
  const ctxViolations = validateContextComponentMatch(composed.layoutPlan, uiState, plan, ctxIdGen);
  const ovfViolations = validateLayoutOverflow(composed.layoutPlan, uiState, viewport, ovfIdGen);

  const violations = [].concat(hardChecks.violations, ctxViolations, ovfViolations);
  return { composed, violations, referenceLayout };
}

// ---------------------------------------------------------------------------
//  STAGE 1+2 (MERGED) — runInterpretAndNormalize
//  Single LLM call producing both interpretation + planning packet. Exposed
//  separately so the streaming endpoint can emit a step_done event after it
//  completes (enabling progressive UI rendering on the client). The non-
//  streaming runPlan composes this with runSelect for a single-call API.
// ---------------------------------------------------------------------------

async function runInterpretAndNormalize({ scenarioText, llmCall, llmCallFast, fastMode }) {
  if (!llmCall) throw new Error('runInterpretAndNormalize requires llmCall');
  const scenario = scenarioText || '';
  const fastCall = llmCallFast || llmCall;

  // fastMode hint — appended to the system prompt to tell the LLM to
  // emit minimal arrays. This actually reduces generation time (which
  // post-process trimming on the server does not). The LLM still emits
  // the structural fields (uiState, slot_requirements, etc.) — only
  // the verbose paraphrase arrays shrink.
  const FAST_HINT_BASE = '\n\n[FAST MODE] Keep response MINIMAL. Emit:\n- tasks[] with at most 3 entries\n- slot_requirements[] with at most 3 entries\n- constraints[] with at most 2 entries\n- selection_constraints arrays with at most 2 entries each\nKeep all structural fields (intent, ui_state, planning_summary) intact. Do NOT add commentary or extra verbose paraphrases.';
  const cookFastEsc = fastMode && likelyGuidedCookingAssistantScenarioText(scenario);
  const FAST_HINT = FAST_HINT_BASE + (
    cookFastEsc ? GUIDED_FAST_PLANNING_ESCAPE_HINT : ''
  ) + (
    fastMode && !cookFastEsc && likelyFlightTravelScenarioText(scenario)
      ? GUIDED_FAST_FLIGHT_ESCAPE_HINT
      : ''
  ) + (
    fastMode && likelyIoTAssistantScenarioText(scenario)
      ? GUIDED_FAST_IOT_ESCAPE_HINT
      : ''
  );

  // Original (pre-cache-reorder) prompt structure restored — empirically
  // moving KB into the system prompt regressed UI quality across stages,
  // even though it improved cache hit rates.
  const sysPrompt = buildInterpretAndPlanPrompt() + (fastMode ? FAST_HINT : '');
  const combinedRaw = await fastCall(
    sysPrompt,
    buildPromptContext('interpreter', null) + '\n\n---\n\n' +
    buildPromptContext('normalizer', null) + '\n\n---\n\n' +
    `User Scenario:\n${scenario}`
  );
  const interpretation = normalizeInterpreterOutput(combinedRaw);
  const planningPacket = normalizeNormalizerOutput(combinedRaw);

  // Safety merge: backfill context_tags into planningPacket.uiState if the
  // merged response only put them at the top-level ui_state.
  if (planningPacket.uiState
      && (!planningPacket.uiState.contextTags
          || planningPacket.uiState.contextTags.length === 0)
      && interpretation.uiState
      && Array.isArray(interpretation.uiState.contextTags)
      && interpretation.uiState.contextTags.length > 0) {
    planningPacket.uiState.contextTags = interpretation.uiState.contextTags.slice();
  }

  applyDialogSurfaceHeuristic(planningPacket, scenario, interpretation);

  // Trip / flight — always merge slot blueprint + strip assistant-task / music defaults
  // (not only when PIPELINE_HEAVY_RULES=on); otherwise "New York trip" stays sparse
  // with a media strip + one CTA and never gets itinerary slots.
  enrichPlanningPacketForFlightTravel(planningPacket, scenario, interpretation);
  stripCookingSignalsFromTravelUiState(planningPacket, interpretation, scenario);
  attachPersonalTravelInterfaceContract(planningPacket, scenario, interpretation);

  // Light rail: high-autonomy runs skip HEAVY_RULES enrich*, but dashboard/briefing
  // scenarios still benefit from the deterministic briefing tag so Stage 3 injects
  // calendar/reminder/message tiles (see CONTEXT_INJECTION_RULES).
  if (!HEAVY_RULES && planningPacket && planningPacket.uiState) {
    const s = scenario || '';
    const looksBrief =
      /\b(dashboard|briefing|widget\s+grid|at-a-glance|multi-tile|home\s+summary)\b/i.test(s) ||
      /(대시보드|브리핑|한\s*눈에|위젯|요약\s*화면|홈\s*요약)/.test(s);
    if (looksBrief) {
      const ui = planningPacket.uiState;
      const tags = Array.isArray(ui.contextTags) ? ui.contextTags.map(String) : [];
      if (!tags.some(t => /^briefing$/i.test(t))) {
        ui.contextTags = tags.concat(['briefing']);
      }
    }
  }

  if (HEAVY_RULES) {
    enrichPlanningPacketForGuidedCookingAssistant(planningPacket, scenario, interpretation);
    enrichPlanningPacketForIoTAssistant(planningPacket, scenario, interpretation);
  }

  return {
    interpretation,
    planningPacket,
    rawCombined: combinedRaw
  };
}

// ---------------------------------------------------------------------------
//  STAGE 3 — runSelect (component selector + mandatory injection + validation)
// ---------------------------------------------------------------------------

async function runSelect({ scenarioText, interpretation, planningPacket, rawCombined, llmCall, embedCall, fastMode }) {
  if (!llmCall) throw new Error('runSelect requires llmCall');
  const scenario = scenarioText || '';
  // Always use normalized planningPacket for the selector user message so
  // server-side enrichments (guided assist slot blueprint, tags) apply.
  // rawCombined is kept for API/debug compatibility but must not shadow fixes.
  const planningPacketRaw = planningPacket || {};
  /* rawCombined kept on the signature for older callers; selector uses the
     normalized packet so server enrichments (guided slots) reach the model. */

  const uiStateForSelector = planningPacket.uiState || interpretation.uiState;
  const mandatoryBlock = buildMandatoryComponentsBlock(uiStateForSelector);

  // RAG SHORTLIST (Stage 3 vocabulary expansion):
  // The full registry has 92 components but pasting all of them into every
  // prompt is wasteful. Embed the scenario, retrieve top-K by cosine
  // similarity, and feed only that shortlist to the planner. Mandatory
  // components for the surface are always appended so the chrome contract
  // can be satisfied even when the embeddings rank them low.
  // If the embed call or embeddings index is unavailable, we silently fall
  // back to COMPONENT_DESCRIPTIONS_BLOCK (the legacy 10-item set).
  const SHORTLIST_K = parseInt(process.env.PIPELINE_RAG_K || '30', 10);
  let vocabOverride = null;
  let shortlistInfo = null;
  // Kill switch: when RAG is disabled (default), skip the embedding fetch
  // entirely (~400ms saved) and use the curated 10-item vocab block baked
  // into buildPlannerPrompt(). When enabled, retrieve a per-call shortlist
  // and pass it to buildPlannerPrompt() as an override — vocab still ends
  // up in the SYSTEM prompt (preserves the legacy attention pattern that
  // produces healthy UI output).
  if (RAG_ENABLED && embedCall && COMPONENT_EMBEDDINGS) {
    try {
      const ui = uiStateForSelector || {};
      const queryParts = [
        scenario || '',
        ui.baseSurface ? `surface: ${ui.baseSurface}` : '',
        ui.urgency    ? `urgency: ${ui.urgency}`     : '',
        ui.attentionMode ? `attention: ${ui.attentionMode}` : '',
        Array.isArray(ui.contextTags) && ui.contextTags.length
          ? 'context: ' + ui.contextTags.slice(0, 8).join(', ')
          : '',
        interpretation && interpretation.primaryGoal ? `goal: ${interpretation.primaryGoal}` : ''
      ].filter(Boolean);
      const queryText = queryParts.join('\n');
      const t0 = Date.now();
      const queryEmbedding = await embedCall(queryText);
      const topIds = retrieveTopKComponentIds(queryEmbedding, SHORTLIST_K);
      const mandatoryIds = (DesignMemory && DesignMemory.generatorMemory
        && DesignMemory.generatorMemory.screens
        && DesignMemory.generatorMemory.screens[(uiStateForSelector || {}).baseSurface]
        && (DesignMemory.generatorMemory.screens[uiStateForSelector.baseSurface].mandatoryComponents
          || DesignMemory.generatorMemory.screens[uiStateForSelector.baseSurface].mandatory_components))
        || [];
      const finalIds = topIds.slice();
      mandatoryIds.forEach(id => { if (!finalIds.includes(id)) finalIds.push(id); });
      vocabOverride = buildShortlistedVocabBlock(finalIds);
      const elapsed = Date.now() - t0;
      shortlistInfo = { k: SHORTLIST_K, retrieved: topIds.length, finalSize: finalIds.length, elapsedMs: elapsed };
      console.log(`[pipeline] RAG shortlist: ${finalIds.length} ids (top-${topIds.length} + ${mandatoryIds.length} mandatory) in ${elapsed}ms`);
    } catch (e) {
      console.warn('[pipeline] RAG shortlist failed, using full vocab:', e.message);
    }
  }

  // Original prompt structure (KB + mandatory in user message, vocab inside
  // buildPlannerPrompt's system prompt). Restored after the cache-friendly
  // reorder regressed UI quality (fewer components, broken layouts).
  const FAST_HINT = '\n\n[FAST MODE] Keep response MINIMAL. plannerNotes.selectionReasoning[] must have at most 2 entries (or empty). Other plannerNotes arrays at most 1 entry. Keep requiredComponents[] complete and accurate — do NOT trim it.';
  const sysPlanner = buildPlannerPrompt(vocabOverride) + (fastMode ? FAST_HINT : '');
  const guidedContract = HEAVY_RULES
    ? buildGuidedCookingAssistantSelectorContract(scenario, planningPacket, interpretation)
    : '';
  const flightContract = buildFlightTravelSelectorContract(scenario, planningPacket, interpretation);
  const personalIfaceContract = buildPersonalTravelInterfaceSelectorContract(
    scenario,
    planningPacket,
    interpretation
  );
  const iotContract = HEAVY_RULES
    ? buildIoTAssistantSelectorContract(scenario, planningPacket, interpretation)
    : '';
  const planRaw = await llmCall(
    sysPlanner,
    buildPromptContext('selector', uiStateForSelector) + '\n\n---\n\n' +
    (mandatoryBlock ? mandatoryBlock + '\n\n---\n\n' : '') +
    (guidedContract ? guidedContract + '\n---\n\n' : '') +
    (flightContract ? flightContract + '\n---\n\n' : '') +
    (personalIfaceContract ? personalIfaceContract + '\n---\n\n' : '') +
    (iotContract ? iotContract + '\n---\n\n' : '') +
    `User Scenario:\n${scenario}\n\n` +
    `Planning Packet:\n${JSON.stringify(planningPacketRaw)}`
  );
  const plan = normalizeSelectorOutput(planRaw);
  if (shortlistInfo && plan && plan.plannerNotes) {
    plan.plannerNotes.ragShortlist = shortlistInfo;
  }

  // Programmatic mandatory-component enforcement.
  // The mandatoryBlock in the selector's user message is advisory; verified
  // across the 10-scenario test, the LLM sometimes ignores it (e.g. the
  // "bare lock" run picked calendar_summary_card instead of the required
  // status-bar+clock). Here we backfill the missing mandatories so the
  // contract "surface S always has components M[]" is satisfied
  // deterministically rather than depending on prompt obedience.
  // ── Chrome-role correction ─────────────────────────────────────────
  // The LLM occasionally tags content components (quick_toggle_row,
  // input_summary_card, action_chip_row, etc.) as role=chrome — putting
  // them in the chrome group where they render as misplaced widgets
  // (e.g. a quick_toggle_row labeled "Status" rendered as a blue circle
  // beside the app header). Here we detect this misuse: if a component
  // has role=chrome but its componentType is NOT a registered chrome
  // primitive, demote it to its semantic-correct role (action / feedback
  // / context). Mandatory-injected ones are exempt.
  const CHROME_ROLE_ALLOWED_IDS = new Set([
    'status-bar', 'status-bar.default', 'status-bar.live-activity-chip',
    'container.header', 'container.status-bar-app',
    'container.app-shell-dark', 'container.app-shell-light',
    'container.content-area',
    'container.nav-buttons-light', 'container.nav-gestures-dark',
    'lock-screen.clock', 'lock-screen.weather-date', 'lock-screen.shortcut-circle',
    'gesture-bar', 'appbar', 'bottomnav', 'pill-tab', 'tab-bar',
    'keyboard'
  ]);
  // Two patterns the LLM uses when (mistakenly) trying to satisfy a
  // "system status" placeholder for an app surface:
  //   1) label is a generic status word ("Status", "System status", …)
  //   2) value is status-bar-like (time + wifi/bluetooth/battery)
  // Either pattern, combined with chrome-role misuse, means the LLM was
  // duplicating the chrome status-bar (which is already mandatory-injected
  // as container.status-bar-app). These should be DROPPED, not demoted —
  // demoting just re-emits the same junk as content. Without this, the
  // user sees a stray "Status" card with a sound/wifi icon awkwardly
  // placed between the header and the real content.
  const STATUS_LIKE_LABELS = /^(status|system\s+status|app\s+status|device\s+status|connection\s+status|safe\s+area|chrome)\s*$/i;
  // Drops when chrome-misused content's value reads like a status-bar
  // string. Includes:
  //   • Wi-Fi / Bluetooth / battery / cellular / signal — connectivity
  //   • "safe area" — synthetic chrome placeholder
  //   • clock-like time tokens (7:42 PM, 14:30, etc.) — LLM trying to
  //     duplicate the system clock
  const STATUS_BAR_VALUE_PATTERNS = /\b(wi-?fi|bluetooth|battery|cellular|signal|safe\s+area|\d{1,2}:\d{2}(?:\s*(?:am|pm))?)\b/i;
  if (Array.isArray(plan.requiredComponents)) {
    let demoted = 0;
    let dropped = 0;
    const survivors = [];
    plan.requiredComponents.forEach(c => {
      // Pass-through: not a misuse case
      if (c.role !== 'chrome' || c._source === 'mandatory-inject' || CHROME_ROLE_ALLOWED_IDS.has(c.componentType)) {
        survivors.push(c);
        return;
      }
      // Drop heuristic: chrome misuse + status-bar duplication
      const lbl = (c.content && c.content.label) || '';
      const val = (c.content && c.content.value) || '';
      const labelIsGenericStatus  = STATUS_LIKE_LABELS.test(lbl.trim());
      const valueIsStatusBarLike  = STATUS_BAR_VALUE_PATTERNS.test(val);
      if (labelIsGenericStatus || valueIsStatusBarLike) {
        dropped += 1;
        return;  // skip — not added to survivors
      }
      // Otherwise demote (preserve content but reclassify)
      const t = c.componentType || '';
      let newRole = 'context';
      if (/action|chip|button|cta/i.test(t))         newRole = 'action';
      else if (/notif/i.test(t))                     newRole = 'feedback';
      else if (/toggle|switch/i.test(t))             newRole = 'action';
      else if (/progress|state|status/i.test(t))     newRole = 'state';
      c._roleDemotedFrom = c.role;
      c.role = newRole;
      if (c.slot && /^(chrome|container\.|status-bar|header|gesture)/i.test(c.slot)) {
        c.slot = 'content-' + (c.componentType || 'unknown').replace(/[^a-z0-9]/gi, '_').toLowerCase();
      }
      demoted += 1;
      survivors.push(c);
    });
    if (dropped || demoted) {
      plan.requiredComponents = survivors;
      plan.plannerNotes = plan.plannerNotes || {};
      if (demoted) plan.plannerNotes.chromeRoleDemoted    = demoted;
      if (dropped) plan.plannerNotes.chromeRoleDropped    = dropped;
      console.log('[pipeline] runPlan: chrome-role correction — demoted=' + demoted + ' dropped=' + dropped);
    }
  }

  // ── Same-label dedup ───────────────────────────────────────────────
  // The selector LLM repeatedly picks the same widget type with
  // nominally different but practically-identical content — e.g.,
  // 4 "INGREDIENTS READY" cards each listing the same chips with
  // tiny prefix/separator variations. Earlier we deduped on
  // (componentType + label + value) but the value differences (a
  // "Ingredients:" prefix, comma vs ·) defeated it.
  //
  // The user-perceived duplicate is the LABEL — when 4 cards share
  // the same section header, they read as the same widget repeated
  // regardless of whether the values are byte-identical. So dedup is
  // now on (componentType + normalized label) with empty-label cards
  // exempt (mandatory chrome). This is more aggressive: 2 cards with
  // the same label but legitimately different values WILL get
  // deduped — but in practice repeated labels signal LLM duplication
  // intent rather than legit variety.
  // Two normalizers:
  //   _normalizeForDedup   — light: lowercase + collapse punctuation runs.
  //                          Used by primary+secondary sigs.
  //   _alphanumOnly        — heavy: strip everything non-alphanumeric.
  //                          Used by the tertiary sig to catch subtle
  //                          differences like trailing dots, parens,
  //                          ellipses, em/en dashes that the lighter
  //                          normalizer leaves intact.
  function _normalizeForDedup(s) {
    return String(s || '').toLowerCase().replace(/[\s·•|,;:!?-]+/g, ' ').trim();
  }
  function _alphanumOnly(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  if (Array.isArray(plan.requiredComponents)) {
    const seenSig = new Set();
    const seenAlnumSig = new Set();
    const dedupSurvivors = [];
    let dupDropped = 0;
    plan.requiredComponents.forEach(c => {
      const lbl = (c.content && c.content.label) || '';
      const val = (c.content && c.content.value) || '';
      if (!lbl.trim() && !val.trim()) {
        dedupSurvivors.push(c);
        return;
      }
      // PRIMARY signature: componentType + normalized label. Catches
      // the "same section header repeated" pattern.
      const labelSig = (c.componentType || '') + '||' + _normalizeForDedup(lbl);
      if (lbl.trim() && seenSig.has(labelSig)) {
        dupDropped += 1;
        return;
      }
      // SECONDARY signature: full content (label + value). Catches
      // cases with empty label but identical body text.
      const fullSig = labelSig + '||' + _normalizeForDedup(val);
      if (seenSig.has(fullSig)) {
        dupDropped += 1;
        return;
      }
      // TERTIARY signature: alphanumeric-only of the FULL content.
      // Catches subtle differences in punctuation/separators that
      // the lighter normalizer doesn't strip — e.g. "Step 2 of 6"
      // vs "Step 2 of 6." vs "STEP 2/6" all collapse to "step2of6".
      const alnumSig = (c.componentType || '') + '||' + _alphanumOnly(lbl) + '||' + _alphanumOnly(val);
      if (seenAlnumSig.has(alnumSig)) {
        dupDropped += 1;
        return;
      }
      // QUATERNARY signature: alphanumeric-only of label/value alone,
      // CROSS-TYPE. Catches "same content, different componentType"
      // duplicates such as the LLM emitting both `btn-contained` and
      // `action_chip_row` with label "Coupang cart" — two visual buttons
      // for the same action. Trigger only if the alphanumeric label is
      // ≥ 3 chars, so we don't false-positive on short shared labels
      // like "Hi" or numeric counters.
      const labelAlnum = _alphanumOnly(lbl);
      const valueAlnum = _alphanumOnly(val);
      if (labelAlnum.length >= 3 && seenAlnumSig.has('xtype||' + labelAlnum)) {
        dupDropped += 1;
        return;
      }
      if (valueAlnum.length >= 8 && seenAlnumSig.has('xtype||' + valueAlnum)) {
        dupDropped += 1;
        return;
      }
      if (lbl.trim()) seenSig.add(labelSig);
      seenSig.add(fullSig);
      seenAlnumSig.add(alnumSig);
      // Cross-type sentinels — see QUATERNARY check above.
      if (labelAlnum.length >= 3) seenAlnumSig.add('xtype||' + labelAlnum);
      if (valueAlnum.length >= 8) seenAlnumSig.add('xtype||' + valueAlnum);
      dedupSurvivors.push(c);
    });
    if (dupDropped) {
      plan.requiredComponents = dedupSurvivors;
      plan.plannerNotes = plan.plannerNotes || {};
      plan.plannerNotes.duplicatesDropped = dupDropped;
      console.log('[pipeline] runPlan: dedup — dropped ' + dupDropped + ' duplicate-labeled component(s)');
    }
  }

  // ── Cooking domain: de-prioritize gallery-style action_chip_row (soft) ──
  const goalAndScenario = `${scenario}\n${interpretation && interpretation.primaryGoal ? interpretation.primaryGoal : ''}`;
  const COOKING_DOMAIN_RE = /\b(cooking|kitchen|recipe|chef)\b/i;
  const GALLERY_CHIP_RE = /\b(videos|favorites|recent|locations|shared\s+albums|go\s+to\s+studio|clean\s+out)\b/i;
  if (HEAVY_RULES && COOKING_DOMAIN_RE.test(goalAndScenario) && Array.isArray(plan.requiredComponents)) {
    let nudge = 0;
    let pruned = 0;
    plan.requiredComponents.forEach(c => {
      if (c.componentType !== 'action_chip_row') return;
      const lbl = String((c.content && c.content.label) || '');
      const val = String((c.content && c.content.value) || '');
      const blob = `${lbl} ${val}`;
      if (GALLERY_CHIP_RE.test(blob)) {
        const p = typeof c.priority === 'number' ? c.priority : 2;
        if (p < 4) {
          c.priority = Math.min(4, p + 1);
          nudge += 1;
        }
      }
      const acts = Array.isArray(c.content && c.content.actions) ? c.content.actions : [];
      if (acts.length) {
        const browseMode = /\b(browse|saved|collection|explore|filter|diet|ingredient|meal\s*type|cook\s*time)\b/i.test(goalAndScenario);
        const allowBrowse = /\b(ingredients?|meal\s*type|diet|cook\s*time|recent|newest|popular|bookmarks?|saved)\b/i;
        const allowAssist = /\b(timer|voice|substitut|scale|mark\s*done|next|continue|converter)\b/i;
        const keepRe = browseMode ? allowBrowse : allowAssist;
        const nextActs = acts.filter(a => keepRe.test(String((a && a.label) || '')));
        if (nextActs.length && nextActs.length !== acts.length) {
          c.content.actions = nextActs.slice(0, browseMode ? 6 : 4);
          pruned += (acts.length - c.content.actions.length);
        }
      }
    });
    if (nudge || pruned) {
      plan.plannerNotes = plan.plannerNotes || {};
      if (nudge) plan.plannerNotes.cookingGalleryChipNudged = nudge;
      if (pruned) plan.plannerNotes.cookingQuickMenuPruned = pruned;
      console.log('[pipeline] runSelect: cooking quick menu tuned (nudge=' + nudge + ', pruned=' + pruned + ')');
    }
  }

  if (DesignMemory && DesignMemory.generatorMemory && uiStateForSelector) {
    const screens = DesignMemory.generatorMemory.screens || {};
    const screen  = screens[uiStateForSelector.baseSurface] || {};
    const mandatoryIds = screen.mandatoryComponents
                      || screen.mandatory_components
                      || [];
    if (mandatoryIds.length) {
      if (!Array.isArray(plan.requiredComponents)) plan.requiredComponents = [];
      const have = new Set(plan.requiredComponents.map(c => c.componentType).filter(Boolean));
      const injected = [];
      mandatoryIds.forEach(id => {
        if (!have.has(id)) {
          plan.requiredComponents.unshift({
            slot:          'chrome',
            componentType: id,
            variantHint:   'default',
            priority:      1,
            // Surface-mandatory components are by definition chrome — they
            // hold the screen's structural frame. Naming the role here
            // (a) keeps downstream layout reasoning correct (chrome groups,
            // not primary-task groups), and (b) qualifies for the
            // role==='chrome' vocabulary-skip path in validatePlan().
            role:          'chrome',
            content:       { label: '', value: '', icon: null },
            constraints:   [],
            // Marker: validatePlan() skips the semantic-vocabulary check on
            // these because the IDs come from generator_memory.json (which
            // is the source of truth for what's mandatory per surface) and
            // are guaranteed to be valid registry entries — even if they
            // happen not to appear in vocabulary.semantic_allowed_types.
            _source:       'mandatory-inject'
          });
          injected.push(id);
        }
      });
      if (injected.length) {
        plan.plannerNotes = plan.plannerNotes || {};
        plan.plannerNotes.mandatoryInjected = injected;
        console.log('[pipeline] runPlan: injected ' + injected.length +
          ' mandatory component(s) for surface "' +
          uiStateForSelector.baseSurface + '": ' + injected.join(', '));
      }
    }
  }

  // ── Context-aware injection ─────────────────────────────────────────
  // Beyond the surface-mandatory chrome, broaden the selection based on
  // contextTags. The interpreter already identifies signals like "morning",
  // "briefing", "driving" — we use those to inject related rich content
  // cards (calendar_summary_card for morning, navigation_turn_card for
  // driving, etc.) when the LLM's narrower task→slot mapping would
  // otherwise miss them. Each injection is gated on the component being
  // (a) not already picked, and (b) in the active semantic vocabulary.
  //
  // Runs even when PIPELINE_HEAVY_RULES=off — otherwise AI-first mode never
  // receives tag-driven tiles and briefings collapse to 1–2 empty cards.
  if (uiStateForSelector && Array.isArray(uiStateForSelector.contextTags) && uiStateForSelector.contextTags.length) {
    if (!Array.isArray(plan.requiredComponents)) plan.requiredComponents = [];
    const havePicked = new Set(plan.requiredComponents.map(c => c.componentType).filter(Boolean));
    const allowedVocab = new Set(allowedSemanticComponentTypes());
    const suggestions = new Set();
    uiStateForSelector.contextTags.forEach(tag => {
      const t = String(tag).toLowerCase();
      const baseIds    = CONTEXT_INJECTION_RULES[t]      || [];
      const learnedIds = LEARNED_CONTEXT_INJECTIONS[t]   || [];
      baseIds.forEach(id    => suggestions.add(id));
      learnedIds.forEach(id => suggestions.add(id));
    });
    const ctxInjected = [];
    const injDom = classifyScenarioDomains(scenario, interpretation);
    suggestions.forEach(id => {
      if (injDom.travel && !injDom.cooking && id === 'media_control_bar'
          && !travelScenarioWantsPlaybackStrip(injDom.blob)) {
        return;
      }
      if (id === 'quick_toggle_row') {
        const surf = uiStateForSelector.baseSurface;
        const ov = (uiStateForSelector.overlayType || 'none');
        if (surf === 'app' && ov !== 'quick-settings') return;
      }
      if (havePicked.has(id) || !allowedVocab.has(id)) return;
      const placeholder = CONTEXT_INJECTION_PLACEHOLDERS[id] || { label: '', value: '' };
      plan.requiredComponents.push({
        slot:          'context-' + id.replace(/[^a-z0-9]/gi, '_').toLowerCase(),
        componentType: id,
        variantHint:   'default',
        priority:      2,   // contextual, not critical
        role:          'context',
        // Pre-filled with reasonable sample content so the per-component
        // visual treatment (calendar layout, reminder layout, etc.) has
        // something to render instead of empty fields. The LLM may
        // override this if it picks the same component organically.
        content:       { label: placeholder.label, value: placeholder.value, icon: null },
        constraints:   [],
        _source:       'context-inject'
      });
      ctxInjected.push(id);
    });
    if (ctxInjected.length) {
      plan.plannerNotes = plan.plannerNotes || {};
      plan.plannerNotes.contextInjected = ctxInjected;
      console.log('[pipeline] runPlan: context-injected ' + ctxInjected.length +
        ' component(s) from tags [' +
        uiStateForSelector.contextTags.slice(0, 8).join(',') + ']: ' +
        ctxInjected.join(', '));
    }
  }

  if (HEAVY_RULES) {
    injectTaskAffordances(plan, scenario, interpretation);
    enforceAdaptiveScenarioCoverage(plan, scenario, interpretation, planningPacket, uiStateForSelector);
    stripCrossDomainPlanClutter(plan, scenario, interpretation);
  }
  // Always keep a minimal app task structure even in AI-first mode.
  ensureMinimumRoleCoverage(plan, scenario, interpretation, planningPacket, uiStateForSelector);

  ensureTravelTripPlanDensity(plan, scenario, interpretation, planningPacketRaw);

  // ── Per-type cap (after all injections) ────────────────────────────
  // Even after label-dedup, the selector + context/affordance injects can
  // still stack identical strip types. App shell: at most one timer/session
  // strip and one nav-turn card. Other surfaces: max 3 per type.
  if (Array.isArray(plan.requiredComponents)) {
    const SURF = (uiStateForSelector && uiStateForSelector.baseSurface) || '';
    const APP_LIKE = SURF === 'app';
    const TYPE_CAP_DEFAULT = 3;
    const TYPE_LIMIT = {
      media_control_bar:     APP_LIKE ? 1 : TYPE_CAP_DEFAULT,
      navigation_turn_card: APP_LIKE ? 1 : TYPE_CAP_DEFAULT
    };
    const counts = {};
    const capSurvivors = [];
    let capDropped = 0;
    plan.requiredComponents.forEach(c => {
      const t = c.componentType || '';
      const lbl = (c.content && c.content.label) || '';
      const val = (c.content && c.content.value) || '';
      if (!lbl.trim() && !val.trim()) {
        capSurvivors.push(c);
        return;
      }
      const lim = TYPE_LIMIT[t] != null ? TYPE_LIMIT[t] : TYPE_CAP_DEFAULT;
      counts[t] = (counts[t] || 0) + 1;
      if (counts[t] > lim) {
        capDropped += 1;
        return;
      }
      capSurvivors.push(c);
    });
    if (capDropped) {
      plan.requiredComponents = capSurvivors;
      plan.plannerNotes = plan.plannerNotes || {};
      plan.plannerNotes.typeCapDropped = (plan.plannerNotes.typeCapDropped || 0) + capDropped;
      console.log('[pipeline] runSelect: type-cap — dropped ' + capDropped + ' excess row(s) (limits per type)');
    }
  }

  // Identical twin timer strips (same label/value text) → keep first only.
  if (Array.isArray(plan.requiredComponents)) {
    const seenSig = new Set();
    let twinDrop = 0;
    plan.requiredComponents = plan.requiredComponents.filter(c => {
      if (c.componentType !== 'media_control_bar') return true;
      const lbl = String((c.content && c.content.label) || '').trim().toLowerCase();
      const val = String((c.content && c.content.value) || '').trim().toLowerCase();
      const sig = `${lbl}|${val}`.replace(/\s+/g, ' ');
      if (seenSig.has(sig)) {
        twinDrop += 1;
        return false;
      }
      seenSig.add(sig);
      return true;
    });
    if (twinDrop) {
      plan.plannerNotes = plan.plannerNotes || {};
      plan.plannerNotes.duplicateTimerStripDropped =
        (plan.plannerNotes.duplicateTimerStripDropped || 0) + twinDrop;
      console.log('[pipeline] runSelect: deduped ' + twinDrop + ' duplicate media_control_bar row(s)');
    }
  }

  if (Array.isArray(plan.requiredComponents)) {
    const uiSt = uiStateForSelector || {};
    if (uiSt.baseSurface === 'app' && (uiSt.overlayType || 'none') !== 'quick-settings') {
      let qtStrip = 0;
      plan.requiredComponents = plan.requiredComponents.filter(c => {
        if (c.componentType !== 'quick_toggle_row') return true;
        qtStrip += 1;
        return false;
      });
      if (qtStrip) {
        plan.plannerNotes = plan.plannerNotes || {};
        plan.plannerNotes.systemQuickToggleStripped = qtStrip;
        console.log('[pipeline] runPlan: stripped ' + qtStrip + ' quick_toggle_row from app shell (One UI rule)');
      }
    }
  }

  // Cooking app surfaces: reduce "all-buttons" feel by limiting action
  // primitives and preserving at least one informational subject card.
  if (Array.isArray(plan.requiredComponents)) {
    const uiSt = uiStateForSelector || {};
    const dom = classifyScenarioDomains(scenario, interpretation);
    if (uiSt.baseSurface === 'app' && dom.cooking && !dom.travel) {
      const ACTION_TYPES = new Set([
        'btn-contained', 'btn-outlined', 'btn-flat', 'fab', 'chip', 'action_chip_row', 'quick_toggle_row'
      ]);
      const INFO_TYPES = new Set([
        'reminder_card', 'calendar_summary_card', 'message_summary_card',
        'weather_glance_card', 'eta_card', 'navigation_turn_card', 'input_summary_card'
      ]);
      const actionRows = [];
      const survivors = [];
      plan.requiredComponents.forEach((c, idx) => {
        if (ACTION_TYPES.has(c.componentType)) actionRows.push({ c, idx });
        else survivors.push(c);
      });

      const scoreAction = (row) => {
        const t = row.c.componentType || '';
        const p = (typeof row.c.priority === 'number' ? row.c.priority : 3);
        const role = String(row.c.role || '');
        let base = 0;
        if (t === 'btn-contained') base = 40;
        else if (t === 'action_chip_row') base = 32;
        else if (t === 'btn-outlined') base = 18;
        else if (t === 'chip') base = 10;
        else base = 4;
        if (role === 'action') base += 3;
        base += Math.max(0, 6 - p);
        return base;
      };

      actionRows.sort((a, b) => scoreAction(b) - scoreAction(a));
      const keptActions = [];
      const seenActionSig = new Set();
      actionRows.forEach(({ c }) => {
        if (keptActions.length >= 2) return;
        const lbl = String((c.content && c.content.label) || '').toLowerCase();
        const val = String((c.content && c.content.value) || '').toLowerCase();
        const sig = (lbl || val || c.componentType || '').replace(/\s+/g, ' ').trim();
        if (!sig) return;
        if (seenActionSig.has(sig)) return;
        // Cooking cards already expose chip semantics; keep one concise CTA/chip row pair.
        if (c.componentType === 'btn-outlined' && /\b(voice|guidance|converter|substitute)\b/i.test(sig)) return;
        seenActionSig.add(sig);
        keptActions.push(c);
      });

      const infoCount = survivors.filter(c => INFO_TYPES.has(c.componentType)).length;
      if (infoCount === 0) {
        survivors.unshift({
          slot:          'cooking_subject',
          componentType: 'reminder_card',
          variantHint:   'default',
          priority:      1,
          role:          'subject',
          content:       {
            label: "Today's step",
            value: 'Continue current recipe step with timing and ingredients',
            icon:  null
          },
          constraints:   [],
          _source:       'cooking-balance'
        });
      }

      const beforeCount = plan.requiredComponents.length;
      plan.requiredComponents = survivors.concat(keptActions);
      const dropped = beforeCount - plan.requiredComponents.length;
      if (dropped > 0) {
        plan.plannerNotes = plan.plannerNotes || {};
        plan.plannerNotes.cookingActionOverloadDropped = dropped;
        console.log('[pipeline] runSelect: cooking-balance — dropped ' + dropped + ' action-heavy row(s)');
      }
    }
  }

  const contractViolations = enforcePersonalTravelInterfaceContract(
    plan,
    planningPacketRaw,
    scenario,
    interpretation
  );

  const { violations } = validatePlan(plan);

  return {
    plan,
    planViolations: violations.concat(contractViolations)
  };
}

// ---------------------------------------------------------------------------
//  STAGE 3.5 — runContentBag (parallel content enrichment)
//
//  Fired in parallel with runSelect (Promise.all). The selector picks
//  componentTypes + initial content; the content bag runs alongside it on
//  a cheap mini model and emits a rich, varied fact bundle keyed by
//  componentType. After both resolve, applyContentSwap() fills in empty /
//  duplicated slots in the selector plan with bag entries — defeating the
//  "4× INGREDIENTS READY with identical chips" failure mode without any
//  extra latency on the critical path.
// ---------------------------------------------------------------------------

function buildContentBagPrompt() {
  return `You are a CONTENT FRAGMENT GENERATOR for a Samsung One UI screen.

You will receive a user scenario plus a short uiState. Your job is to emit a
COMPACT bag of REAL, scenario-grounded content fragments that DIFFERENT
component types could display. You are NOT picking components or designing a
screen — you are ONLY producing text/data fragments that can be plugged into
whatever the selector picked.

Return STRICT JSON shaped EXACTLY like this (no extra keys, no commentary):

{
  "weather":  { "label": "string", "value": "string", "icon": "string|null" },
  "calendar": [
    { "label": "string", "value": "string", "icon": "string|null" }
  ],
  "reminder": [
    { "label": "string", "value": "string", "icon": "string|null" }
  ],
  "message": [
    { "label": "string", "value": "string", "icon": "string|null" }
  ],
  "eta":      { "label": "string", "value": "string", "icon": "string|null" },
  "navigation": { "label": "string", "value": "string", "icon": "string|null" },
  "now_playing": { "label": "string", "value": "string", "icon": "string|null" },
  "shortcut": [
    { "label": "string", "value": "string", "icon": "string|null" }
  ],
  "input_summary": [
    { "label": "string", "value": "string", "icon": "string|null" }
  ],
  "primary_subject": { "label": "string", "value": "string", "icon": "string|null" },
  "primary_state":   { "label": "string", "value": "string", "icon": "string|null" },
  "primary_action":  { "label": "string", "value": "string", "icon": "string|null" }
}

Rules:
- Every label MUST be UNIQUE across the entire bag (case-insensitive). No two
  entries — across keys or within array fields — may share the same label.
- Arrays must contain 3 DIFFERENT entries (varied subjects, different verbs,
  different specifics).  Each entry is a complete tile, NOT a placeholder.
- label is a short uppercase or sentence-case heading (≤ 28 chars, no emoji).
- value is the actual scenario-grounded body content (≤ 80 chars, concrete
  nouns / numbers / times / names — NOT "data here", NOT "TBD").
- icon is OPTIONAL — null is fine. If you set one, use a single Material-style
  symbol name (e.g. "schedule", "bolt", "wifi") — never an emoji.
- Use the SCENARIO to populate everything. If the scenario is cooking, the
  reminders should be cooking-specific (different ingredients), the messages
  should be plausible cooking-context messages (e.g. "Sarah" asking about
  dinner), the calendar entries should be cooking-context times (prep,
  simmer, plate). The bag must feel coherent with the user's actual task.
- If the scenario is TRAVEL / FLIGHT / AIRPORT / BOARDING only (with NO
  cooking, recipe, food delivery, or restaurant ordering), NEVER emit reminders
  about ingredients, calories, substitutions, diets, recipes, meal prep timers
  (kitchen), or similar — use gate times, boarding, baggage, seat, itinerary
  details only. Same labels must stay unique.
- When TRAVEL-only: primary_subject MUST be a headline itinerary fragment (flight # or city pair + one time/gate/boarding detail). primary_state SHOULD be boarding / ETA / delay status — not passive music playback unless listening is explicitly in the scenario (never invent "Playing Smooth Jazz").
- primary_subject / primary_state / primary_action ALSO describe the SCREEN's
  central concept (1 each) so the selector's chosen subject / state / action
  components can be enriched with on-task content if they were left generic.
- DO NOT repeat literal phrases between entries. "Pasta water boiling" /
  "Sauce reducing" / "Garlic toasting" — three DIFFERENT cooking states, NOT
  three near-identical "ingredients ready" lines.
- Keep total output small — JSON only, no markdown.`;
}

async function runContentBag({ scenarioText, planningPacket, interpretation, llmCall, fastMode }) {
  if (!llmCall) return null;             // optional stage — never throws
  const scenario = scenarioText || '';
  const ui = (planningPacket && planningPacket.uiState)
          || (interpretation && interpretation.uiState)
          || {};
  // Minimal user message — the bag prompt is self-contained, we just hand
  // it the scenario plus a tiny uiState slice for grounding.
  const uiHint = {
    baseSurface:   ui.baseSurface   || null,
    attentionMode: ui.attentionMode || null,
    densityMode:   ui.densityMode   || null,
    contextTags:   Array.isArray(ui.contextTags) ? ui.contextTags.slice(0, 8) : []
  };
  const userMsg = `Scenario:\n${scenario}\n\nuiState (hint, do not echo):\n${JSON.stringify(uiHint)}`;
  try {
    const t0 = Date.now();
    const raw = await llmCall(buildContentBagPrompt(), userMsg);
    const elapsed = Date.now() - t0;
    console.log(`[pipeline] content bag generated in ${elapsed}ms`);
    return _normalizeContentBag(raw);
  } catch (e) {
    console.warn('[pipeline] runContentBag failed (non-fatal):', e.message);
    return null;
  }
}

// Defensive normalization — the bag is best-effort; never let a malformed
// response take down the pipeline. Always return the canonical shape with
// unknown keys dropped and missing keys defaulted.
function _normalizeContentBag(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const oneOrNull = (v) => {
    if (!v || typeof v !== 'object') return null;
    const label = String(v.label || '').trim();
    const value = String(v.value || '').trim();
    if (!label && !value) return null;
    return { label, value, icon: v.icon || null };
  };
  const arrOf = (v) => {
    if (!Array.isArray(v)) return [];
    return v.map(oneOrNull).filter(Boolean);
  };
  return {
    weather:         oneOrNull(raw.weather),
    calendar:        arrOf(raw.calendar),
    reminder:        arrOf(raw.reminder),
    message:         arrOf(raw.message),
    eta:             oneOrNull(raw.eta),
    navigation:      oneOrNull(raw.navigation),
    now_playing:     oneOrNull(raw.now_playing),
    shortcut:        arrOf(raw.shortcut),
    input_summary:   arrOf(raw.input_summary),
    primary_subject: oneOrNull(raw.primary_subject),
    primary_state:   oneOrNull(raw.primary_state),
    primary_action:  oneOrNull(raw.primary_action)
  };
}

// Maps a planner componentType → the bag key that holds matching content.
// Multiple componentTypes can route to the same bag key (e.g. several
// reminder-style components all pull from bag.reminder). Returns null
// when no swap is appropriate (chrome, action chips with their own copy).
function _bagKeyForComponentType(componentType) {
  if (!componentType) return null;
  const t = String(componentType).toLowerCase();
  if (t.includes('weather'))               return 'weather';
  if (t.includes('calendar') || t.includes('event'))           return 'calendar';
  if (t.includes('reminder') || t.includes('todo') || t.includes('task_list')) return 'reminder';
  if (t.includes('message')  || t.includes('chat')  || t.includes('conversation')) return 'message';
  if (t.includes('eta')      || t.includes('arrival'))         return 'eta';
  if (t.includes('navigation') && !t.includes('bar'))          return 'navigation';
  if (t.includes('now_playing') || t.includes('media') || t.includes('track'))   return 'now_playing';
  if (t.includes('shortcut') || t.includes('tile'))            return 'shortcut';
  if (t.includes('input_summary') || t.includes('form'))       return 'input_summary';
  return null;
}

// ---------------------------------------------------------------------------
//  applyContentSwap — fill empty / duplicated slots from the content bag
//
//  Runs after runSelect + runContentBag both resolve. Walks the plan's
//  requiredComponents and for each component:
//    1. If content.label is missing/generic, pull a fresh entry from the
//       matching bag bucket.
//    2. If multiple components of the same componentType collide on the
//       same label, distribute distinct bag entries across the duplicates.
//    3. If the screen's primary subject/state/action components have
//       generic content, replace them with bag.primary_*.
//  Bag entries are consumed (popped) so each is used at most once across the
//  plan — guaranteeing label uniqueness without rerunning dedup.
// ---------------------------------------------------------------------------

const _GENERIC_LABEL_PATTERNS = [
  /^title$/i, /^subtitle$/i, /^item$/i, /^content$/i,
  /^card$/i,  /^info$/i,    /^data$/i, /^placeholder$/i,
  /^personalized\s+guidance$/i, /^adaptations\s+based\s+on\s+preferences$/i,
  /^.{0,2}$/   // 0–2 chars is functionally empty
];

function _isGenericLabel(label) {
  const s = String(label || '').trim();
  if (!s) return true;
  return _GENERIC_LABEL_PATTERNS.some(rx => rx.test(s));
}

function _normLabelForCompare(s) {
  return String(s || '').toLowerCase().replace(/[\s·•|,;:!?-]+/g, ' ').trim();
}

function applyContentSwap(plan, bag) {
  if (!plan || !Array.isArray(plan.requiredComponents) || !bag) return plan;
  const components = plan.requiredComponents;

  // Build per-bucket consumable queues so each entry is used at most once.
  const queues = {
    weather:       bag.weather       ? [bag.weather]       : [],
    calendar:      Array.isArray(bag.calendar)      ? bag.calendar.slice()      : [],
    reminder:      Array.isArray(bag.reminder)      ? bag.reminder.slice()      : [],
    message:       Array.isArray(bag.message)       ? bag.message.slice()       : [],
    eta:           bag.eta           ? [bag.eta]           : [],
    navigation:    bag.navigation    ? [bag.navigation]    : [],
    now_playing:   bag.now_playing   ? [bag.now_playing]   : [],
    shortcut:      Array.isArray(bag.shortcut)      ? bag.shortcut.slice()      : [],
    input_summary: Array.isArray(bag.input_summary) ? bag.input_summary.slice() : []
  };

  // Track labels already in use so we don't introduce a duplicate when
  // pulling from a queue.
  const usedLabels = new Set();
  components.forEach(c => {
    const lbl = (c && c.content && c.content.label) || '';
    if (lbl) usedLabels.add(_normLabelForCompare(lbl));
  });

  const popUnique = (key) => {
    const q = queues[key];
    if (!q || !q.length) return null;
    while (q.length) {
      const next = q.shift();
      if (!next) continue;
      const norm = _normLabelForCompare(next.label);
      if (!norm || usedLabels.has(norm)) continue;
      usedLabels.add(norm);
      return next;
    }
    return null;
  };

  // Pass 1 — count collisions per (componentType + normalized label) so we
  // can target the duplicates for swap (keep the first occurrence, swap the
  // rest with bag entries).
  const seenSig = new Map();   // sig → count
  components.forEach(c => {
    if (!c || c.role === 'chrome') return;
    const t = c.componentType || '';
    const lbl = (c.content && c.content.label) || '';
    const sig = t + '||' + _normLabelForCompare(lbl);
    seenSig.set(sig, (seenSig.get(sig) || 0) + 1);
  });

  let swaps = 0;
  components.forEach((c, idx) => {
    if (!c || c.role === 'chrome') return;
    if (!c.content) c.content = { label: '', value: '', icon: null };
    const t = c.componentType || '';
    const lbl = c.content.label || '';
    const norm = _normLabelForCompare(lbl);

    // (a) Primary slot enrichment — if this is the screen's subject/state/
    //     action and its content is generic, reach for bag.primary_*.
    if (_isGenericLabel(lbl)) {
      let primary = null;
      if (c.role === 'subject' && bag.primary_subject) primary = bag.primary_subject;
      else if (c.role === 'state' && bag.primary_state)   primary = bag.primary_state;
      else if (c.role === 'action' && bag.primary_action) primary = bag.primary_action;
      if (primary && !usedLabels.has(_normLabelForCompare(primary.label))) {
        c.content.label = primary.label;
        c.content.value = primary.value || c.content.value || '';
        if (primary.icon && !c.content.icon) c.content.icon = primary.icon;
        usedLabels.add(_normLabelForCompare(primary.label));
        swaps += 1;
        return;
      }
    }

    // (b) Bucket swap — for content components, route by componentType.
    const bagKey = _bagKeyForComponentType(t);
    if (!bagKey) return;
    const sig = t + '||' + norm;
    const isDupe = (seenSig.get(sig) || 0) > 1;
    const isEmpty = _isGenericLabel(lbl);
    if (!isDupe && !isEmpty) return;     // first occurrence with real content stays

    const fresh = popUnique(bagKey);
    if (!fresh) return;

    // For dupes, we leave the FIRST occurrence alone and swap subsequent
    // matches. Decrement the seen counter as we swap so we only target the
    // 2nd / 3rd / nth occurrences (not the first).
    if (isDupe && !isEmpty) {
      // Find this component's ordinal position among same-sig entries; if
      // it's the first one we encounter (count still equals total), skip.
      // Otherwise consume the queue.
      const remaining = seenSig.get(sig);
      if (remaining === seenSig.get(sig) && idx === components.findIndex(x =>
          x && x.componentType === t &&
          _normLabelForCompare((x.content && x.content.label) || '') === norm)) {
        // first occurrence — keep, but don't decrement queue
        // (the popUnique call already drained the queue once; we re-push.)
        queues[bagKey].unshift(fresh);
        usedLabels.delete(_normLabelForCompare(fresh.label));
        return;
      }
    }

    c.content.label = fresh.label;
    c.content.value = fresh.value || c.content.value || '';
    if (fresh.icon && !c.content.icon) c.content.icon = fresh.icon;
    swaps += 1;
  });

  if (swaps > 0) {
    console.log(`[pipeline] applyContentSwap: filled ${swaps} slot(s) from content bag`);
  }
  return plan;
}

/** Safe top-level keys on layoutPlan the client may override post-compose. */
const USER_LAYOUT_PLAN_KEYS = [
  ['floatingSheetTheme', ['floatingSheetTheme', 'floating_sheet_theme']],
  ['backgroundPolicy', ['backgroundPolicy', 'background_policy']],
  ['gap', ['gap']],
  ['padding', ['padding']],
  ['pipelineFillViewport', ['pipelineFillViewport', 'pipeline_fill_viewport']]
];

/**
 * After compose: merge whitelisted layout hints (bottom-sheet theme, gap, …).
 * Does not replace groups[] — only scalar hints the renderer reads.
 */
function applyUserLayoutPlanHints(layoutPlan, hints) {
  if (!layoutPlan || !hints || typeof hints !== 'object') return;
  for (let i = 0; i < USER_LAYOUT_PLAN_KEYS.length; i++) {
    const dest = USER_LAYOUT_PLAN_KEYS[i][0];
    const keys = USER_LAYOUT_PLAN_KEYS[i][1];
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      if (hints[k] != null) {
        layoutPlan[dest] = hints[k];
        break;
      }
    }
  }
}

/**
 * Merge explicit user data after content-bag swap / before imagery finalize.
 * Accept POST field `userSupplements` or `user_data` (same shape).
 *
 * Supported keys:
 * - uiState — shallow-merged into planningPacket.uiState + interpretation.uiState
 * - contentBySlot — { slotId: { label, value, … } } merged into matching plan row.content
 * - patchComponents — [{ componentType, content?, variant? }] first matching row each
 * - nowPlaying | now_playing | music — convenience for media_control_bar (title/artist/label/value/imageUrl)
 * - mediaCard — merged into first media-card row
 * - layoutPlan — only used if server calls applyUserLayoutPlanHints after compose (see stream handler)
 */
function applyUserSupplements(planningPacket, interpretation, plan, supplements) {
  if (!supplements || typeof supplements !== 'object') return;
  const supp = supplements;

  const ui = supp.uiState || supp.ui_state;
  if (ui && typeof ui === 'object') {
    if (planningPacket) {
      planningPacket.uiState = Object.assign({}, planningPacket.uiState || {}, ui);
    }
    if (interpretation) {
      interpretation.uiState = Object.assign({}, interpretation.uiState || {}, ui);
    }
  }

  const rows = plan && Array.isArray(plan.requiredComponents) ? plan.requiredComponents : null;
  if (!rows) return;

  const bySlot = supp.contentBySlot || supp.content_by_slot;
  if (bySlot && typeof bySlot === 'object') {
    Object.keys(bySlot).forEach(function slotMerge(slot) {
      const patch = bySlot[slot];
      if (!patch || typeof patch !== 'object') return;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row.slot === slot) {
          row.content = Object.assign({}, row.content || {}, patch);
          break;
        }
      }
    });
  }

  const patches = supp.patchComponents || supp.patch_components;
  if (Array.isArray(patches)) {
    for (let pi = 0; pi < patches.length; pi++) {
      const p = patches[pi];
      if (!p || !p.componentType) continue;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row.componentType === p.componentType) {
          if (p.content && typeof p.content === 'object') {
            row.content = Object.assign({}, row.content || {}, p.content);
          }
          if (p.variant && typeof p.variant === 'object') {
            row.variant = Object.assign({}, row.variant || {}, p.variant);
          }
          break;
        }
      }
    }
  }

  const np = supp.nowPlaying || supp.now_playing || supp.music;
  if (np) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.componentType !== 'media_control_bar') continue;
      row.content = row.content || {};
      if (typeof np === 'string') {
        row.content.label = np;
      } else if (typeof np === 'object') {
        if (np.title != null) row.content.label = String(np.title);
        if (np.label != null) row.content.label = String(np.label);
        if (np.artist != null) row.content.value = String(np.artist);
        if (np.value != null && (row.content.value == null || row.content.value === '')) {
          row.content.value = String(np.value);
        }
        const art = np.imageUrl || np.coverUrl || np.albumArt;
        if (art) row.content.imageUrl = String(art);
      }
      break;
    }
  }

  const mc = supp.mediaCard || supp.media_card;
  if (mc && typeof mc === 'object') {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row && row.componentType === 'media-card') {
        row.content = Object.assign({}, row.content || {}, mc);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  ORCHESTRATOR — runPlan = runInterpretAndNormalize + (runSelect ‖ runContentBag)
//  Composition wrapper for non-streaming consumers (/api/pipeline/full,
//  /api/pipeline/plan). Streaming consumers should call the two halves
//  separately so each emits its own step_done event for progressive UI.
// ---------------------------------------------------------------------------

async function runPlan({
  scenarioText,
  llmCall,
  llmCallFast,
  llmCallContentBag,
  embedCall,
  fastMode,
  userSupplements
}) {
  const ipn = await runInterpretAndNormalize({ scenarioText, llmCall, llmCallFast, fastMode });

  // Stages 3 (select) and 3.5 (content bag) fire in PARALLEL so the bag
  // adds zero critical-path latency. Stage 3 typically takes ~3–6 s on
  // gpt-5.4; the mini model bag returns in ~1–2 s, well inside that window.
  const bagCall = llmCallContentBag || llmCallFast || llmCall;
  const [sel, bag] = await Promise.all([
    runSelect({
      scenarioText,
      interpretation:  ipn.interpretation,
      planningPacket:  ipn.planningPacket,
      rawCombined:     ipn.rawCombined,
      llmCall,
      embedCall,
      fastMode
    }),
    runContentBag({
      scenarioText,
      planningPacket:  ipn.planningPacket,
      interpretation:  ipn.interpretation,
      llmCall:         bagCall,
      fastMode
    })
  ]);

  // Swap is best-effort — runs after both calls resolve, before validation.
  if (bag) applyContentSwap(sel.plan, bag);
  applyUserSupplements(ipn.planningPacket, ipn.interpretation, sel.plan, userSupplements);

  try {
    await finalizeAssistantPlanPostProcess(scenarioText, ipn.planningPacket, sel.plan);
  } catch (e) {
    console.warn('[pipeline] runPlan: imagery finalize (non-fatal):', e.message);
  }

  const uiState = ipn.planningPacket.uiState || ipn.interpretation.uiState;
  return {
    interpretation:  ipn.interpretation,
    planningPacket:  ipn.planningPacket,
    plan:            sel.plan,
    uiState,
    planViolations:  sel.planViolations,
    contentBag:      bag
  };
}

// ---------------------------------------------------------------------------
//  VALIDATION ROLLUP — single canonical report
// ---------------------------------------------------------------------------

function rollupValidationResults({ planViolations, layoutViolations }) {
  const violations = [].concat(planViolations || [], layoutViolations || []);
  const summary = {
    total:          violations.length,
    high:           violations.filter(v => v.severity === 'high').length,
    medium:         violations.filter(v => v.severity === 'medium').length,
    low:            violations.filter(v => v.severity === 'low').length,
    autoFixable:    violations.filter(v => v.status === 'auto-fixable').length,
    reviewRequired: violations.filter(v => v.status === 'review-required').length
  };
  return { summary, violations };
}

// ---------------------------------------------------------------------------
//  Post-process: attach public imagery (recipe thumbs, commute maps) after
//  selector + content bag. Best-effort; failures are swallowed by server.
// ---------------------------------------------------------------------------

const _MEALDB_BASE = 'https://www.themealdb.com/api/json/v1/1';

async function _finalizeFetchJson(url, init) {
  const res = await fetch(url, {
    ...(init || {}),
    headers: { Accept: 'application/json', ...((init && init.headers) || {}) }
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function _mealDbSearchQueryFromScenario(scenarioText, plan) {
  const s = scenarioText || '';
  const make = s.match(/\b(?:make|cook|bake|prep(?:are)?)\s+([^.!?\n]{3,56})/i);
  if (make) return make[1].trim().split(/[,;]/)[0].trim();
  // Korean: "김치찌개 만들기", "라자냐 레시피"
  const makeKo = s.match(/([가-힣]{2,14})\s*(?:만들|레시피|조리)\w*/);
  if (makeKo && makeKo[1]) return makeKo[1].trim();
  const rows = (plan && plan.requiredComponents) || [];
  const reminder = rows.find(r =>
    r.componentType === 'reminder_card' &&
    String((r.content && r.content.value) || '').length > 8
  );
  if (reminder) {
    const v = String(reminder.content.value || '');
    const words = v.replace(/[^a-z0-9\s]/gi, ' ').split(/\s+/).filter(w => w.length > 3);
    const skip = /^(until|brown|golden|finely|chopped|minced|minute|minutes|hour|heat|oil|salt|pepper)$/i;
    const foodish = words.find(w => !skip.test(w));
    if (foodish) return foodish;
  }
  const g = s.match(/\b(chicken|beef|pork|salad|pasta|soup|rice|curry|pizza|sandwich|stew|tacos?)\b/i);
  return g ? g[1] : 'pasta';
}

async function _mealDbThumbForQuery(q) {
  const term = String(q || '').trim();
  if (term.length < 2) return '';
  try {
    const j = await _finalizeFetchJson(_MEALDB_BASE + '/search.php?s=' + encodeURIComponent(term));
    const m0 = j && Array.isArray(j.meals) && j.meals[0];
    if (m0 && m0.strMealThumb) return m0.strMealThumb;
  } catch (_) { /* ignore */ }
  try {
    const j2 = await _finalizeFetchJson(_MEALDB_BASE + '/filter.php?i=' + encodeURIComponent(term));
    const m1 = j2 && Array.isArray(j2.meals) && j2.meals[0];
    if (m1 && m1.strMealThumb) return m1.strMealThumb;
  } catch (_) { /* ignore */ }
  return '';
}

function _inferMapQueryFromPlan(plan, scenarioText) {
  const rows = (plan && plan.requiredComponents) || [];
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const ct = c.componentType || '';
    if (!['eta_card', 'navigation_turn_card', 'reminder_card', 'widget-small', 'input_summary_card'].includes(ct)) continue;
    const label = String((c.content && c.content.label) || '');
    const value = String((c.content && c.content.value) || '');
    const dest = label.match(/(?:ETA|Arrival|To|Going to|Heading to)[\s·]+(.+?)$/i);
    if (dest && dest[1].trim()) return dest[1].trim();
    if (/\b(home|office|work|airport)\b/i.test(label)) return label.trim();
    const via = value.match(/\bvia\s+([^.·\n]+)/i);
    if (via) return via[1].trim();
    // Route / loop copy ("5 km loop", "Central Park loop")
    const loopM = (label + ' ' + value).match(/\b(\d+(?:\.\d+)?\s*(?:km|mi|m)\s+loop)\b/i);
    if (loopM) {
      const s2 = scenarioText || '';
      const place = s2.match(/\b(?:at|in|near|around)\s+([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\s-]{2,40})/i);
      if (place && place[1]) return place[1].trim().split(/[.,]/)[0].trim();
    }
    if (/route|overview|trail|lap|course/i.test(label) && (label + value).length > 3) {
      const s2 = scenarioText || '';
      const place = s2.match(/\b(?:at|in|near|around|through)\s+([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\s-]{2,40})/i);
      if (place && place[1]) return place[1].trim().split(/[.,]/)[0].trim();
    }
  }
  const s = scenarioText || '';
  const toM = s.match(/\b(?:to|toward(?:s)?)\s+([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\s,.-]{2,42})/);
  return toM ? toM[1].trim().split(/[.,]/)[0].trim() : '';
}

async function _nominatimLatLon(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return null;
  const url =
    'https://nominatim.openstreetmap.org/search?q=' +
    encodeURIComponent(q) +
    '&format=json&limit=1';
  try {
    const res = await fetch(url, {
      headers: {
        Accept:       'application/json',
        'User-Agent': 'SamsungOneUIDesignDemo/1.0 (local design preview)'
      }
    });
    if (!res.ok) return null;
    const arr = await res.json();
    const hit = Array.isArray(arr) && arr[0];
    if (!hit || hit.lat == null || hit.lon == null) return null;
    const lat = parseFloat(hit.lat);
    const lon = parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch (_) {
    return null;
  }
}

function _osmStaticMapUrl(lat, lon, zoom) {
  const zIn = Number.isFinite(zoom) ? Math.floor(zoom) : 13;
  const z = Math.min(19, Math.max(0, zIn));
  const lonClamped = Math.max(-180, Math.min(180, lon));
  const latClamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const n = Math.pow(2, z);
  const x = Math.floor(n * ((lonClamped + 180) / 360));
  const latRad = latClamped * Math.PI / 180;
  const y = Math.floor(
    (n * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI)) / 2
  );
  // Official OSM raster tiles (staticmap.openstreetmap.de is often unreachable).
  // Light demo use per https://operations.osmfoundation.org/policies/tiles/
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function _fallbackMapLatLon(query) {
  const q = String(query || '').toLowerCase();
  if (/\b(seoul|korea|gangnam|jamsil|hongdae)\b/.test(q) || /(서울|강남|잠실|홍대|한강)/.test(query || '')) return { lat: 37.5665, lon: 126.9780 };
  if (/\b(tokyo|japan|shibuya|shinjuku)\b/.test(q)) return { lat: 35.6762, lon: 139.6503 };
  if (/\b(new york|nyc|manhattan)\b/.test(q)) return { lat: 40.7128, lon: -74.0060 };
  if (/\b(london|uk)\b/.test(q)) return { lat: 51.5074, lon: -0.1278 };
  // Safe default center if geocoding fails.
  return { lat: 37.5665, lon: 126.9780 };
}

/** Non-empty raster URL suitable for hero/map thumbnails (allow same-origin assets). */
function _hasUsableHeroImage(content) {
  const c = content || {};
  const a = String((c.imageUrl != null ? c.imageUrl : '') || (c.image != null ? c.image : '') || '').trim();
  if (!a) return false;
  if (/^https?:\/\//i.test(a)) return true;
  if (/^\/(?!\/)/.test(a)) return true;
  if (/^(app-icons|assets)\//i.test(a)) return true;
  return false;
}

/** True if we should attach a fetched preview (MealDB / OSM): missing URL or obvious placeholder. */
function _shouldAttachMapRaster(content) {
  const c = content || {};
  const raw = String((c.imageUrl != null ? c.imageUrl : '') || (c.image != null ? c.image : '') || '').trim();
  if (!raw) return true;
  if (/^\/(?!\/)/.test(raw) || /^(app-icons|assets)\//i.test(raw)) return false;
  if (!/^https?:\/\//i.test(raw)) return true;
  const u = raw.toLowerCase();
  if (/placeholder|picsum|dummyimage|fakeimg|lorempixel|placekitten|via\.placeholder|fill\.murray|example\.com|gravatar\.com\/avatar\?/.test(u)) {
    return true;
  }
  if (/^https?:\/\/[^/]+\/?(\?.*)?$/.test(raw)) return true;
  return false;
}

/**
 * Runs server-side after runSelect + runContentBag.merge.
 * - Cooking: first eligible summary/focus row without a real hero image gets a TheMealDB thumbnail
 *   (reminder_card, message_summary_card, input_summary_card, widget-small, semantic tiles, focus-block raw).
 * - Commute/travel/navigation/running: first map-eligible card gets `GENUI_DUMMY_MAP_PREVIEW_URL` by default (bundled PNG); set `PIPELINE_MAP_DUMMY=off` for live OSM tiles.
 */
async function finalizeAssistantPlanPostProcess(scenarioText, planningPacket, plan) {
  if (!plan || !Array.isArray(plan.requiredComponents)) return;

  const goal =
    planningPacket &&
    planningPacket.planningSummary &&
    String(planningPacket.planningSummary.primaryGoal || '').trim();
  const interpStub = goal ? { intent: { primaryGoal: goal } } : null;
  const dom = classifyScenarioDomains(scenarioText || '', interpStub);
  const mapBlob = `${scenarioText || ''}\n${goal}\n${dom.blob}`;

  const mapMotion =
    /\b(driv(?:e|ing)|commute|maps?|map\b|traffic|navigation|navigator|routes?|gps|directions|\beta\b|flight|airport|transit|itinerary|destination|layover|sightseeing|tour|hotel)\b/i.test(mapBlob) ||
    /(내비|지도|교통|항공|공항|여행|관광|호텔|숙소|환승|출국|입국|탑승)/i.test(mapBlob);
  const mapRunHike =
    /\b(running|runner|run\b|jog|jogging|marathon|5k|10k|5\s*k\b|10\s*k\b|half\s*marathon|ultra|trail|trails|hike|hiking|trek|walk(?:ing)?|nordic\s*walk|cycling|cyclist|bicycle|bike\b|spin|workout|lap|laps|splits?\b|pace|strava|orienteering|gps\s*watch|gps\s*track|course\b|track\b|parkrun)\b/i.test(mapBlob) ||
    /(달리기|조깅|러닝|마라톤|등산|트레일|하이킹|산책|자전거|싸이클|운동|트랙|랩|페이스|코스|공원\s*런)/i.test(mapBlob);
  const mapContext = dom.travel || mapMotion || mapRunHike ||
    (dom.workout && /(러닝|달리기|조깅|트레일|트랙|야외|공원\s*런|running|jog|trail|gps|route|5k|10k|marathon)/i.test(mapBlob));

  // Recipe thumbnails: selector often places the hero on reminder_card, but
  // guided cooking slots may use message_summary_card / input_summary_card /
  // raw focus-block — previously only reminder_card + widget-small got MealDB.
  const cookingAttach =
    dom.cooking &&
    (!dom.travel ||
      /\b(recipe|kitchen|cook|chef|meal|ingredient|pasta|simmer|restaurant|dining|food\b|요리|레시피|요리법|재료|찌개|볶음|맛집|식당)\b/i.test(
        mapBlob
      ));
  if (cookingAttach) {
    const q = _mealDbSearchQueryFromScenario(scenarioText, plan);
    const url = await _mealDbThumbForQuery(q);
    // Only attach food thumbnails from TheMealDB — generic placeholders like picsum
    // seeds produced unrelated wildlife/scenery photos ("deer on cooking screen").
    if (url) {
      const COOK_ATTACH_TYPES = [
        'reminder_card',
        'message_summary_card',
        'input_summary_card',
        'widget-small',
        'contextual_summary_card',
        'information_glance_tile',
        'focus-block'
      ];
      let row = null;
      for (let ci = 0; ci < COOK_ATTACH_TYPES.length; ci++) {
        const wantT = COOK_ATTACH_TYPES[ci];
        row = plan.requiredComponents.find(rc => rc.componentType === wantT && _shouldAttachMapRaster(rc.content));
        if (row) break;
      }
      if (row) {
        row.content = row.content || {};
        row.content.imageUrl = url;
      }
    }
  }

  if (!mapContext) return;

  let mapUrl;
  if (USE_DUMMY_MAP_PREVIEW) {
    mapUrl = GENUI_DUMMY_MAP_PREVIEW_URL;
  } else {
    const query =
      _inferMapQueryFromPlan(plan, scenarioText) ||
      (mapRunHike ? 'Olympic Park running trail Seoul' : '');
    const queryForGeo = String(query || '').trim() ||
      String(scenarioText || '').trim().slice(0, 160) ||
      (mapRunHike ? 'city park running' : 'city center');
    const ll =
      (await _nominatimLatLon(queryForGeo)) ||
      _fallbackMapLatLon(queryForGeo + ' ' + (scenarioText || ''));
    mapUrl = _osmStaticMapUrl(ll.lat, ll.lon, mapRunHike ? 14 : 13);
  }

  const MAP_ATTACH_TYPES = [
    'eta_card',
    'navigation_turn_card',
    'calendar_summary_card',
    'reminder_card',
    'widget-small',
    'input_summary_card',
    'message_summary_card'
  ];
  let mapTarget = null;
  for (let ti = 0; ti < MAP_ATTACH_TYPES.length; ti++) {
    const wantT = MAP_ATTACH_TYPES[ti];
    mapTarget = plan.requiredComponents.find(rc => rc.componentType === wantT && _shouldAttachMapRaster(rc.content));
    if (mapTarget) break;
  }
  if (!mapTarget && mapContext) {
    const cityHint = tripLabelFromScenario(scenarioText);
    plan.requiredComponents.push({
      slot:          'map_preview_auto',
      componentType: 'eta_card',
      variantHint:   'default',
      priority:      1,
      role:          'subject',
      content:       {
        label: cityHint ? `Map · ${cityHint}` : (mapRunHike ? 'Run · Route map' : 'Map · Preview'),
        value: cityHint
          ? `Route and places near ${cityHint} — preview above; open full map for navigation.`
          : (mapRunHike
            ? 'GPS track, distance, and pace along your route — map preview above.'
            : 'Directions and area context — map preview above.'),
        icon: null
      },
      constraints:   [],
      _source:       'map-preview-fallback'
    });
    mapTarget = plan.requiredComponents[plan.requiredComponents.length - 1];
  }
  if (mapTarget) {
    mapTarget.content = mapTarget.content || {};
    mapTarget.content.imageUrl = mapUrl;
  }
}

// ---------------------------------------------------------------------------
//  STEP 7 — EXPLANATION (canonical camelCase input)
// ---------------------------------------------------------------------------

async function runExplain({ scenarioText, uiState, plan, layoutPlan, validationReport, llmCall }) {
  if (!llmCall) throw new Error('runExplain requires llmCall(systemPrompt, userMessage)');
  const payload = {
    scenarioText,
    uiState,
    requiredComponents: (plan && plan.requiredComponents) || [],
    plannerNotes:       (plan && plan.plannerNotes)       || null,
    layoutPlan,
    validationReport
  };
  // Original prompt structure restored — KB context stays at the head of
  // the user message so the explainer can cite principle names (P1, P2,
  // etc.) when justifying the design.
  const userMessage =
    buildPromptContext('explainer', uiState) + '\n\n---\n\n' +
    JSON.stringify(payload);
  return llmCall(buildExplanationPrompt(), userMessage);
}

module.exports = {
  // KB helpers
  buildPromptContext,
  getComponentDescriptionsBlock: () => COMPONENT_DESCRIPTIONS_BLOCK,
  buildShortlistedVocabBlock,
  buildVariantReference,
  buildMandatoryComponentsBlock,
  retrieveTopKComponentIds,
  isRenderableComponentId,
  RENDERABLE_COMPONENT_IDS,
  // Phase C runtime hooks for the self-improving system
  addLearnedRule,
  removeLearnedRule,
  listLearnedRules,
  // prompts
  buildInterpreterPrompt,
  buildNormalizerPrompt,
  buildInterpretAndPlanPrompt,
  buildPlannerPrompt,
  buildComposerPrompt,
  buildExplanationPrompt,
  // validators (canonical, camelCase)
  validatePlan,
  validateLayout,
  rollupValidationResults,
  // orchestrators
  runPlan,
  runInterpretAndNormalize,
  runSelect,
  runContentBag,
  applyContentSwap,
  applyUserSupplements,
  applyUserLayoutPlanHints,
  runComposeLayout,
  runExplain,
  finalizeAssistantPlanPostProcess,
  // prompts (content bag)
  buildContentBagPrompt,
  // vocabulary introspection
  allowedComponentTypes,
  allowedSemanticComponentTypes,
  REGISTRY_PATH,
  // schema-normalizer re-exports
  normalizeInterpreterOutput,
  normalizeNormalizerOutput,
  normalizeSelectorOutput,
  normalizeComposerOutput
};
