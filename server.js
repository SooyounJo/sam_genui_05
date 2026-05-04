const http = require('http');
const fs = require('fs');
const path = require('path');
const pipeline = require('./pipeline');           // genui_pipeline_v1 step_1 + step_3
const normalizer = require('./schema_normalizer'); // for fallback telemetry (getFallbackStats, withCollector)
const improvementEngine = require('./improvement_engine'); // self-improving system: test suite + scoring + (Phase B/C/D wip)
const UIState = require('./ui-state.js') || (global.UIState);  // step_2 resolver (Node CJS export)
// layout_composer is consumed indirectly by pipeline.runComposeLayout

// --- Load .env ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
  });
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
// Per-stage model selection. Each stage has different reasoning needs, so
// we route each to a model matched to its job:
//   OPENAI_MODEL          → select (Step 3) — vocabulary + constraint
//                                              reasoning + content authoring
//   OPENAI_MODEL_FAST     → merged interpret+normalize (Steps 1+2)
//                                            — simple JSON extraction
//   OPENAI_MODEL_COMPOSE  → compose (Step 4) — most complex stage,
//                                              spatial+structural+token
//                                              reasoning. Often deserves
//                                              the strongest model.
//   OPENAI_MODEL_EXPLAIN  → explain (Step 7) — light paraphrasing,
//                                              fastest mini works.
// All three default to OPENAI_MODEL when unset, so behavior is unchanged
// for users who haven't configured per-stage models.
const OPENAI_MODEL_FAST    = process.env.OPENAI_MODEL_FAST    || OPENAI_MODEL;
const OPENAI_MODEL_COMPOSE = process.env.OPENAI_MODEL_COMPOSE || OPENAI_MODEL;
const OPENAI_MODEL_EXPLAIN = process.env.OPENAI_MODEL_EXPLAIN || OPENAI_MODEL_FAST;
// Phase-1 parallel content bag (Stage 3.5). Runs in parallel with the
// selector to materialize rich, varied content fragments (weather facts,
// reminder list, message previews, calendar entries, etc.) so the swap
// pass can fill empty / duplicated slots in the plan with diverse text.
// Cheap mini model is fine — this is enrichment, not selection.
const OPENAI_MODEL_CONTENT_BAG = process.env.OPENAI_MODEL_CONTENT_BAG || OPENAI_MODEL_EXPLAIN;
const PORT = parseInt(process.env.PORT) || 3000;
// Host-bind: loopback-only by default so the API key + static files are not
// reachable from other devices on the network. Override with BIND_HOST=0.0.0.0
// only if you know what you are doing (no auth / CORS on these endpoints).
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
// Static-file containment root. Resolved once at boot; every request's
// resolved path must remain under this prefix (see static-file handler).
const SAFE_ROOT = path.resolve(__dirname) + path.sep;
// Request body cap — protects against malicious/accidental giant POSTs
// that would otherwise accumulate in memory. 1 MiB covers any reasonable
// scenario_text; raise via env if you have a real use case.
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES) || 1048576;  // 1 MiB
// LLM concurrency + rate limits — bound runaway clients so a looping
// browser tab can't drain the OpenAI budget. Applied to any endpoint
// that invokes callOpenAI[Stream]. Tune per your plan.
const MAX_CONCURRENT_LLM = parseInt(process.env.MAX_CONCURRENT_LLM) || 4;
const MAX_LLM_PER_MIN    = parseInt(process.env.MAX_LLM_PER_MIN)    || 60;

if (!OPENAI_API_KEY) {
  console.error('\x1b[31m[ERROR]\x1b[0m OPENAI_API_KEY not set in .env file');
  console.log('  → Open .env and paste your key: OPENAI_API_KEY=sk-...');
  process.exit(1);
}

// --- MIME types for static files ---
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// ============================================================================
// DESIGN KNOWLEDGE BASE — Constraint Extraction Pipeline
// ============================================================================
// DESIGN.md is parsed into indexed sections at startup.
// It is NEVER sent as raw payload. Instead, only relevant constraints
// are extracted per scenario (~2-3KB vs 25KB full document).
// ============================================================================

const designMdPath = path.join(__dirname, 'DESIGN.md');
const genuiMdPath = path.join(__dirname, 'GENUI-PRINCIPLES.md');
const orchMdPath = path.join(__dirname, 'ORCHESTRATION.md');
const evolveMdPath = path.join(__dirname, 'evolve.md');
const DESIGN_MD_RAW = fs.existsSync(designMdPath) ? fs.readFileSync(designMdPath, 'utf8') : '';
const GENUI_MD_RAW = fs.existsSync(genuiMdPath) ? fs.readFileSync(genuiMdPath, 'utf8') : '';
const ORCH_MD_RAW = fs.existsSync(orchMdPath) ? fs.readFileSync(orchMdPath, 'utf8') : '';

// --- Structured design-rules JSON (typography scale, glass tiers,
//     radius ladder, spacing grid, touch target minimums). These were
//     previously gated behind keyword triggers in extractConstraints()
//     which meant the AI only saw them when the prompt literally said
//     "glass" / "typography" / etc. Now loaded once at startup and
//     always included in the generate user prompt (see
//     buildDesignRulesBrief below). Kept compact — the full files are
//     ~4KB combined, easy to carry per request.
const designRulesPath = path.join(__dirname, 'figma-refs/design_rules.json');
const globalRulesPath = path.join(__dirname, 'figma-refs/global_rules.json');
let DESIGN_RULES = null;
let GLOBAL_RULES = null;
try {
  if (fs.existsSync(designRulesPath)) DESIGN_RULES = JSON.parse(fs.readFileSync(designRulesPath, 'utf8'));
} catch (e) { console.warn('  design_rules.json parse failed:', e.message); }
try {
  if (fs.existsSync(globalRulesPath)) GLOBAL_RULES = JSON.parse(fs.readFileSync(globalRulesPath, 'utf8'));
} catch (e) { console.warn('  global_rules.json parse failed:', e.message); }

// --- Parse markdown documents into indexed sections ---
function parseSections(raw, regex) {
  if (!raw) return {};
  const sections = {};
  const matches = [...raw.matchAll(regex)];
  for (let i = 0; i < matches.length; i++) {
    const key = (matches[i][2] || matches[i][1]).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    sections[key] = raw.substring(start, end).trim();
  }
  return sections;
}

// --- Evolve.md: parse entries into constraint list ---
function parseEvolveEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const entries = [];
  const entryRegex = /### E(\d+):\s*(.+)\n([\s\S]*?)(?=\n### E\d+:|\n---|\n<!-- |$)/g;
  let match;
  while ((match = entryRegex.exec(raw)) !== null) {
    const body = match[3];
    const extract = (key) => {
      const m = body.match(new RegExp(`\\*\\*${key}\\*\\*:\\s*(.+)`, 'i'));
      return m ? m[1].trim() : '';
    };
    entries.push({
      id: 'E' + match[1],
      title: match[2].trim(),
      type: extract('Type'),
      severity: extract('Severity'),
      scenario: extract('Scenario'),
      issue: extract('Issue'),
      fix: extract('Fix'),
      constraint: extract('Constraint'),
      date: extract('Date')
    });
  }
  return entries;
}

function loadEvolveConstraints() {
  const entries = parseEvolveEntries(evolveMdPath);
  if (entries.length === 0) return null;
  // Compress entries to actionable constraints only
  return entries.map(e => ({
    id: e.id,
    type: e.type,
    scenario: e.scenario,
    constraint: e.constraint
  })).filter(e => e.constraint); // only entries with a constraint
}

function appendEvolveEntry(entry) {
  let raw = fs.existsSync(evolveMdPath) ? fs.readFileSync(evolveMdPath, 'utf8') : '';
  // Find next entry number
  const nums = [...raw.matchAll(/### E(\d+):/g)].map(m => parseInt(m[1]));
  const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  const today = new Date().toISOString().split('T')[0];

  const md = `
### E${nextNum}: ${entry.title || 'Untitled issue'}
- **Type**: ${entry.type || 'consistency'}
- **Severity**: ${entry.severity || 'medium'}
- **Scenario**: ${entry.scenario || 'general'}
- **Issue**: ${entry.issue || ''}
- **Fix**: ${entry.fix || ''}
- **Constraint**: ${entry.constraint || ''}
- **Date**: ${today}
`;

  // Append before the closing comment or at end
  if (raw.includes('<!-- New entries')) {
    raw = raw.replace('<!-- New entries are appended here by the refinement system -->', md.trim() + '\n\n<!-- New entries are appended here by the refinement system -->');
  } else {
    raw += '\n' + md;
  }
  fs.writeFileSync(evolveMdPath, raw, 'utf8');
  return { id: `E${nextNum}`, success: true };
}

const DESIGN_SECTIONS = parseSections(DESIGN_MD_RAW, /^## (\d+)\. (.+)$/gm);
const GENUI_SECTIONS = parseSections(GENUI_MD_RAW, /^## (\d+)\. (.+)$/gm);
const ORCH_SECTIONS = parseSections(ORCH_MD_RAW, /^## (\d+)\. (.+)$/gm);
let EVOLVE_CONSTRAINTS = loadEvolveConstraints();

const totalRawKB = ((DESIGN_MD_RAW.length + GENUI_MD_RAW.length + ORCH_MD_RAW.length) / 1024).toFixed(1);
console.log(`  \x1b[32m✓\x1b[0m DESIGN.md    ${DESIGN_MD_RAW ? (DESIGN_MD_RAW.length / 1024).toFixed(1) + 'KB → ' + Object.keys(DESIGN_SECTIONS).length + ' sections' : 'NOT FOUND'}`);
console.log(`  \x1b[32m✓\x1b[0m GENUI.md     ${GENUI_MD_RAW ? (GENUI_MD_RAW.length / 1024).toFixed(1) + 'KB → ' + Object.keys(GENUI_SECTIONS).length + ' sections' : 'NOT FOUND'}`);
console.log(`  \x1b[32m✓\x1b[0m ORCH.md      ${ORCH_MD_RAW ? (ORCH_MD_RAW.length / 1024).toFixed(1) + 'KB → ' + Object.keys(ORCH_SECTIONS).length + ' sections' : 'NOT FOUND'}`);
console.log(`  \x1b[32m✓\x1b[0m design_rules.json  ${DESIGN_RULES ? Object.keys(DESIGN_RULES).length + ' token families' : 'NOT FOUND'}`);
console.log(`  \x1b[32m✓\x1b[0m global_rules.json  ${GLOBAL_RULES ? (GLOBAL_RULES.rules || []).length + ' rules' : 'NOT FOUND'}`);
console.log(`  \x1b[32m✓\x1b[0m evolve.md    ${EVOLVE_CONSTRAINTS ? EVOLVE_CONSTRAINTS.length + ' learned constraints' : '0 entries (will grow from refinement)'}`);
console.log(`  \x1b[32m✓\x1b[0m Total raw    ${totalRawKB}KB (never sent to API)`);

// --- Pre-compressed constraint fragments (extracted from DESIGN.md at parse time) ---
// These are the minimal, actionable rules — NOT raw markdown copies.

const CONSTRAINT_FRAGMENTS = {

  // Core tokens always included (~600 bytes)
  core: {
    spacing: { base: 8, scale: [4, 8, 12, 16, 24, 32, 48], unit: 'dp' },
    radius: { micro: 4, standard: 11, large: 20, card: 26, pill: 999, button: 18, circle: '50%' },
    typography: {
      display: { family: 'SamsungSharpSans', weight: 700 },
      body: { family: 'SamsungOne', weights: [400, 500, 600, 700] },
      scale: { caption: 11, body: 13, subtitle: 15, title: 20, headline: 28, hero: 36 }
    },
    motion: {
      static: { easing: 'cubic-bezier(0.22,0.25,0,1)', duration: '200-300ms' },
      gen: { easing: 'cubic-bezier(0.05,0.7,0.1,1.0)', duration: '300-500ms' },
      spring: { stiffness: 300, damping: 25 }
    }
  },

  // Color tokens (~400 bytes)
  colors_dark: {
    base: '#171717', surface: 'rgba(255,255,255,0.06)', surface2: 'rgba(255,255,255,0.1)',
    text: '#FFFFFF', text2: 'rgba(255,255,255,0.7)', text3: 'rgba(255,255,255,0.45)',
    primary: '#3388E9', brand: '#1428A0', divider: 'rgba(255,255,255,0.08)',
    error: '#FF453A', glass_bg: 'rgba(255,255,255,0.08)', glass_border: 'rgba(255,255,255,0.12)'
  },
  colors_light: {
    base: '#FCFCFC', surface: '#F7F7F7', surface2: '#F0F0F0',
    text: '#1D1D1F', text2: '#313131', text3: '#6E6E73',
    primary: '#1428A0', brand: '#1428A0', divider: '#EAEAEA',
    error: '#FF3B30', glass_bg: 'rgba(0,0,0,0.04)', glass_border: 'rgba(0,0,0,0.08)'
  },
  semantic_colors: {
    connectivity: '#4A90D9', accessibility: '#4CAF50', ai: '#9C27B0',
    health: '#E91E63', battery: '#FF9800', system: '#009688', communication: '#FF5252'
  },

  // Glass UI system (~300 bytes)
  glass: {
    levels: {
      G0: { opacity: '5-15%', blur: 40 },
      G1: { opacity: '15-30%', blur: 24 },
      G2: { opacity: '30-50%', blur: 16 },
      G3: { opacity: '50-70%', blur: 12 }
    },
    border: '1px solid rgba(255,255,255,0.12)',
    rule: 'all glass surfaces have thin outline border + wallpaper-reactive tint'
  },

  // Component behaviors (~900 bytes — expanded for quality)
  components: {
    button_primary: { height: 48, padding: '6px 24px', radius: 36, font: '14px/700', bg: 'var(--primary)', color: '#fff' },
    button_outlined: { height: 48, padding: '6px 24px', radius: 36, font: '14px/600', bg: 'transparent', border: '1px solid var(--divider)' },
    button_flat: { height: 48, padding: '6px 16px', font: '14px/500', bg: 'transparent', color: 'var(--primary)' },
    card: { radius: 26, padding: '16px', bg: 'var(--surface)', border: '1px solid var(--divider)' },
    input: { height: 48, radius: 18, padding: '12px 16px', border: '1px solid rgba(255,255,255,0.15)', bg: 'var(--surface)', label_above: true },
    search: { height: 44, radius: 999, padding: '10px 16px', position: 'bottom of screen for reachability', icon: 'left' },
    appbar: { height: 56, back_arrow: 'left', title: 'center or left', overflow: 'right', behavior: 'fades during scroll' },
    pill_tab: { height: 46, radius: 999, bg: 'frosted semi-transparent', border: '1px solid rgba(255,255,255,0.2)', active: 'circular highlight' },
    bottomnav: { height: 56, items: '4-5 icon+label', style: 'pill-shaped floating, glass bg', active_color: 'var(--primary)' },
    now_bar: { position: 'bottom of lock screen', shape: 'pill(999px)', bg: 'tinted glass', states: 'media|timer|delivery|charging' },
    dialog: { radius: 26, padding: '24px', max_width: 320, button_pair: 'Cancel(flat) + Confirm(contained)' },
    chip: { height: 32, radius: 999, padding: '0 12px', font: '13px/500' },
    switch_toggle: { width: 52, height: 32, radius: 999, active_color: 'var(--primary)' },
    list_item: { min_height: 56, padding: '12px 16px', icon_left: '40x40 circle', chevron_right: true, divider: '1px bottom' },
    notification_card: { radius: 999, material: 'glass G1', structure: 'icon+appName+content+timestamp+actions' },
    media_card: { radius: 26, structure: 'albumArt+title+artist+progress+controls', bg: 'extracted palette' },
    status_bar: { height: 24, layout: 'time(left) notif-pill(center) system-icons(right)' },
    fab: { size: 56, radius: '50%', bg: '#FF5252', shadow: '0 4px 12px rgba(0,0,0,0.3)', position: 'bottom-right' }
  },

  // Layout rules (~300 bytes)
  layout: {
    mobile_width: 360, tablet_width: 692, desktop_width: 988,
    mobile_padding: 24, grid_base: 8,
    density: {
      lock_screen: '3-5 components', notification: '10-15',
      qs_expanded: '30-40', full_app: '50+'
    },
    pill_morphology: {
      pill: '999px — Now Bar, chips, tabs',
      squircle: '26px — cards, widgets, dialogs',
      circle: '50% — toggles, FABs',
      rounded_rect: '18px — buttons, inputs'
    }
  },

  // Depth system (~200 bytes)
  depth: {
    blur: 'emphasis on foreground — primary depth tool in 8.5',
    dim: 'clarifies hierarchy — rgba(0,0,0,0.65) for modals',
    shadow: 'soft connection between layers — never combine with dim',
    rule: 'pick ONE of dim or shadow per layer, never both'
  },

  // Do/Don't rules (~400 bytes)
  rules: [
    'SamsungSharpSans=headlines ONLY, SamsungOne=body/UI ONLY — never mix roles',
    'No font weight 300 — system starts at 400, peaks at 700',
    'Never combine Dim+Shadow on same element',
    'Samsung Blue (#1428A0) is accent only — never use as bg fill',
    'No sharp corners (0px radius) on cards — rounded/pill is 8.5 signature',
    'Nav must fade during scroll (Ambient Design)',
    'Body text left-aligned — only hero headlines center',
    'Search bars at bottom for reachability',
    'Glass UI required for floating system elements — no opaque bgs',
    'Dark mode: #171717 base, glass materials, white text',
    'Light mode: #FCFCFC base, opaque fills, dark text'
  ],

  // ========================================================================
  // GENUI PRINCIPLES — extracted from GENUI-PRINCIPLES.md (48KB → ~1.5KB)
  // ========================================================================

  // P1-P2: Component classification & contextual assembly (~300 bytes)
  genui_classification: {
    model: 'Static (S) vs Generative (G) — binary classification for every element',
    renderOrder: 'Render S (chrome) first to establish frame, then G (content) into slots',
    rule: 'S elements must NEVER be displaced by G elements',
    contextVector: 'C = {time, activity, services, deviceState, notifications}',
    assembly: 'Each Gen slot has selection function f(C) → Component|null'
  },

  // P3: Semantic colors (already in semantic_colors fragment above)

  // P4: Progressive density (~200 bytes)
  genui_density: {
    D1_lockScreen: { components: '3-5', info: 'time, date, Now Bar, 1-2 widgets' },
    D2_notifShade: { components: '10-15', info: 'D1 + notif cards (top 3-5) + 6 QS toggles' },
    D3_qsExpanded: { components: '30-40', info: 'D2 + full QS grid (6x4) + brightness + media' },
    D4_fullApp: { components: '50+', info: 'app-specific content, full nav, all interactive' },
    rule: 'Density increases monotonically. Each layer D_n contains all of D_{n-1} plus more.'
  },

  // P5: Glass hierarchy (already in glass fragment above, enriched here)

  // P6: Pill morphology (~200 bytes)
  genui_shapes: {
    pill_999: 'Now Bar, notification pill, chips, Connected Tab, slide nav buttons',
    squircle_26: 'Cards, widgets, media player, dialogs, image containers',
    circle_50: 'QS toggle icons, browser top bar icons, FAB, page indicator dots',
    rounded_18: 'Contained buttons, text fields, snackbar actions',
    rule: 'Never use sharp corners (0px) on Gen components'
  },

  // P7: Grid quantization (~200 bytes)
  genui_grid: {
    base: '8dp',
    spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
    widgetSizes: {
      compact: '2x1 (176x80dp)', standard: '2x2 (176x176dp)',
      wide: '4x2 (368x176dp)', full: '4x4 (368x368dp)'
    },
    rule: 'All spacing must be from {4,8,12,16,24,32,40,48,64}dp. Internal padding >= 16dp.'
  },

  // P8: Motion as meaning (~200 bytes)
  genui_motion: {
    static: { curve: 'cubic-bezier(0.22,0.25,0,1)', duration: '200-300ms', for: 'chrome transitions' },
    gen: { curve: 'cubic-bezier(0.05,0.7,0.1,1.0)', duration: '300-500ms', for: 'content entry/exit' },
    spring: { stiffness: 300, damping: 25, for: 'toggle activation, pull-to-refresh' },
    density_transition: { curve: 'cubic-bezier(0.05,0.7,0.1,1.0)', duration: '400-500ms', for: 'layer transitions' },
    rule: 'Motion encodes classification. Static=restrained, Gen=expressive. Not decorative.'
  },

  // P9: Notification stratification (~200 bytes)
  genui_notifications: {
    tiers: {
      live: { glass: 'G2', textOpacity: '100%', interactive: true, position: 'top' },
      other: { glass: 'G1', textOpacity: '90%', interactive: 'limited', position: 'middle' },
      silent: { glass: 'G0', textOpacity: '60%', interactive: 'minimal', position: 'bottom' }
    },
    order: 'Live > Other > Silent (fixed vertical order)',
    rule: 'Visual weight decreases per tier. Live includes inline controls.'
  },

  // P10: Ambient reactivity (~150 bytes)
  genui_ambient: {
    wallpaper: 'Extract 5-color palette → apply to glass tints + accent colors',
    timeOfDay: 'Shift color temperature warmer after sunset',
    activity: 'Refresh widget data when activity changes detected',
    rule: 'All ambient changes use Basic Path motion >= 500ms to avoid jumps'
  },

  // P11: Connected composition (~150 bytes)
  genui_connected: {
    rule: 'Two+ Gen components can connect (gap=0) in shared container',
    container: 'Squircle for multi-row, pill for single-row compounds',
    glass: 'Shared container glass level = max of children glass levels',
    examples: 'SmartThings card (header pill + action row), Snackbar (text + button)'
  },

  // P12: Dual-mode rendering (already in rules + colors fragments)

  // Composition grammar — surface structure rules (~300 bytes)
  genui_grammar: {
    lockScreen: 'chrome + widget-area?(0-4 widgets) + now-bar?',
    notifShade: 'chrome + qs-mini(6 toggles) + notification-list(live>other>silent)',
    qsPanel: 'chrome + qs-grid(6col x 1-4row) + brightness? + media-player? + device-control?',
    appSurface: 'chrome + app-content + bottom-nav?',
    homeScreen: 'chrome + widget-grid(0-8) + app-icon-grid + page-indicator?',
    constraints: [
      'Every surface has exactly one chrome (status-bar + nav-bar)',
      'Chrome (Static) renders before any Gen elements',
      'Now Bar on at most one surface at a time',
      'Notif sections in fixed order: live > other > silent',
      'QS grid: 6 columns fixed, 1-4 rows variable',
      'Widget sizes: {2x1, 2x2, 4x2, 4x4} only',
      'Button pairs must contrast: flat+contained or outlined+outlined'
    ]
  },

  // Implementation visual constants (~200 bytes)
  genui_constants: {
    statusBarHeight: '24dp', navBarHeight: '48dp (buttons) / 20dp (gesture)',
    nowBarHeight: '64dp', minTouchTarget: '48dp',
    qsToggleGrid: '6 columns', glassBlurRange: '12-40px',
    glassBorder: '1px solid rgba(255,255,255,0.08-0.15)',
    darkSurface: '#171717', lightSurface: '#FCFCFC',
    imageRadius: '26px', dashedPlaceholder: '1px dashed rgba(255,255,255,0.3)'
  },

  // ========================================================================
  // ORCHESTRATION — extracted from ORCHESTRATION.md (component composition)
  // ========================================================================

  // Vertical stacking rules (~400 bytes)
  orch_stacking: {
    statusbar_to_appbar: '0dp',
    statusbar_to_content: '0dp (lock/wallpaper screens)',
    appbar_to_content: '0dp (content scrolls under)',
    appbar_to_section_title: '16dp',
    section_title_to_item: '8dp',
    card_to_card: '12dp',
    card_to_card_grouped: '8dp',
    list_item_to_list_item: '0dp (divider separates)',
    list_item_to_section_header: '16dp',
    button_to_button_v: '8dp',
    input_to_input: '16dp',
    input_to_helper: '4dp',
    chip_row_to_content: '16dp',
    content_to_bottomnav_clear: '64dp',
    search_to_content: '16dp above and below'
  },

  // Container nesting rules (~300 bytes)
  orch_containers: {
    card: { radius: 26, padding: '16-20dp', header: 'icon(40dp)+gap(12dp)+title(15dp/600)', content_gap: '12dp', action_gap: '16dp', action_align: 'right' },
    dialog: { radius: '26dp top', padding: '24dp', title_desc_gap: '8dp', desc_buttons_gap: '24dp', buttons: 'flex:1 each, divider between, h:48dp' },
    notification: { radius: 999, padding: '16dp 20dp', icon: '20dp circle', structure: 'icon+appName+timestamp(row1) title+preview(row2)' },
    widget: { radius: 26, padding: '12-16dp', bg: 'semantic color or glass', sizes: '2x1(176x80) 2x2(176x176) 4x1(368x80) 4x2(368x160)' }
  },

  // Screen composition templates (~500 bytes)
  orch_screens: {
    login: 'statusbar(24) → content(center-v, pad:0 24dp): logo → gap32 → title(24dp/700) → gap8 → subtitle → gap32 → input(email) → gap16 → input(pw) → gap8 → forgot(right) → gap24 → btn(full,contained) → gap12 → divider("or") → gap12 → social-row → flex → signup-link(bottom 34dp)',
    home: 'statusbar(24) → wallpaper(bleed) → widgets(start ~140dp, pad:0 16dp, grid 2-col, gap 8dp) → search(full-32dp, h:48, r:999) → gap16 → app-grid(4col, pad:0 24dp, icon:60dp r:18dp, label:11dp, col-gap:~28dp, row-gap:24dp) → page-dots → gap12 → dock(4 icons, 60dp, no labels) → navbar(48dp)',
    home_widgets: 'statusbar(24) → widgets(start ~56dp, pad:0 16dp, up to 3-4 rows, full-width 4x2 + mixed 2x2/2x1, gap 8dp) → dock(4 icons) → navbar(48dp)',
    app_drawer: 'statusbar(24) → app-grid(4col, pad:24dp, icon:60dp r:18dp, col-gap:~28dp, row-gap:24dp, max 5 rows) → flex → page-dots → search(bottom, h:44, r:999, glass) → navbar(48dp)',
    lock: 'statusbar(24,transparent) → wallpaper(bleed) → clock(~25-35% from top, 64-96dp SamsungSharpSans) → gap4 → date(16dp) → gap16 → widgets(max 2 compact) → flex → nowbar-row([action 48dp][nowbar flex][action 48dp], gap:8dp, bottom 72dp) → navbar(20dp)',
    qs: 'statusbar(24) → actionbar(48dp, icons right) → qs-grid(4col x 2row, toggle:64dp circle, gap:12H 16V) → page-dots → gap16 → brightness(h:48) → gap16 → tile-cards(2col, gap:8, r:20) → gap12 → media-chips(2, r:999, h:36) → gap12 → shortcuts(2, r:20, h:56) → navbar(48dp)'
  },

  // Widget composition rules (~300 bytes)
  orch_widgets: {
    grid: { columns: 4, gap: 8, container_padding: '0 16dp', snap: 'grid-only, no free position' },
    sizes: { compact_2x1: '176x80dp', standard_2x2: '176x176dp', wide_4x1: '368x80dp', large_4x2: '368x160dp' },
    mixing: 'mixed heights OK: 2x2 left + two 2x1 stacked right. Top-aligned per row.',
    maxVisible: '3-4 rows above dock',
    colorRule: 'no two adjacent widgets same bg color',
    types: {
      weather_full: 'semantic bg, icon(48dp top-right), temp(36dp/700), condition+hilo+location',
      health_rings: 'rings(72dp centered), stats row bottom(3 items)',
      steps: 'title+value(28dp/700)+progress(h:8dp r:999)',
      calendar: 'header(16dp/600)+list(h:36dp each, color-bar 3dp left)',
      photo: 'image fills entire area, object-fit:cover, padding:0'
    }
  },

  // App icon grid & dock (~200 bytes)
  orch_icons: {
    icon: { size: 60, visual: 56, radius: 18, shadow: '0 2dp 8dp rgba(0,0,0,0.15)' },
    folder: { size: 60, radius: 18, bg: 'glass semi-transparent', miniIcons: '2x2 20dp each gap:4dp pad:8dp' },
    grid: { columns: 4, colGap: '~28dp (evenly fill)', rowGap: 24, padding: '0 24dp', label: '11dp/400 center gap:6dp' },
    dock: { items: 4, iconSize: 60, gap: '~28dp even', noLabels: true, position: '48dp above navbar' },
    pageIndicator: { dotSize: 6, gap: 6, activeOpacity: 1, inactiveOpacity: 0.35 },
    // CRITICAL: always render real PNG icons. NEVER use letter placeholders (e.g. <div>G</div>, <div>Y</div>) or coloured squares with initials.
    // Use <img src="app-icons/{name}.png" style="width:...;height:...;border-radius:...;"> with one of these canonical filenames (URL-encode Korean automatically in the browser):
    assets: [
      'Phone.png','Messages.png','Camera.png','Gallery.png','Settings.png','Internet.png','Contacts.png','Clock.png','Calculator.png','Weather.png','Health.png','Bixby.png','Cloud.png','Radio.png','Reminder.png','Studio.png','VoiceRecorder.png','MyFiles.png','DailyBoard.png','DeviceCare.png','DigitalWellbeing.png','SecureWifi.png','SecureFolder.png',
      'Find.png','Notes.png','Pass.png','SmartThings.png','Store.png','Wallet.png','Wearable.png'
    ],
    rule: 'MANDATORY <img src="app-icons/…"> for every app icon. No letter/emoji fallbacks. If an app has no asset, pick the closest match from the list.'
  },

  // Z-layer system (~200 bytes)
  orch_zlayers: {
    base: { z: 0, elements: 'content, lists, grids' },
    floating: { z: 10, elements: 'FAB, BottomNav, PillTab' },
    elevated: { z: 20, elements: 'snackbar, toast' },
    panel: { z: 50, elements: 'bottom sheet, QS panel' },
    modal: { z: 100, elements: 'dialog', dim: 'rgba(0,0,0,0.65)' },
    nowbar: { z: 150, elements: 'now bar' },
    system: { z: 200, elements: 'status bar, nav bar' },
    rule: 'only ONE overlay active at a time: Dialog > Sheet > Snackbar'
  },

  // Anti-patterns (~200 bytes)
  orch_antipatterns: [
    'No card-inside-card nesting',
    'Dialog max 2 buttons (use ActionSheet for 3+)',
    'FAB 16dp above BottomNav, never overlapping',
    'No full-width button inside narrow card',
    'No nested scroll (only horizontal-in-vertical)',
    'No opaque overlay on glass surface',
    'No mixed radius in same container',
    'Min 8dp gap between interactive elements',
    'No text on wallpaper without glass/scrim',
    'Max 5 items in BottomNav'
  ],

  // Component taxonomy — gen component specs (~300 bytes)
  genui_components: {
    notificationCard: { shape: 'pill(999px)', material: 'dark glass', structure: 'icon+appName+content+timestamp+actions' },
    nowBar: { shape: 'pill(999px)', material: 'tinted glass', states: ['media', 'timer', 'delivery', 'charging'] },
    lockWidget: { shape: 'squircle(26px)', layout: '2-col grid, 2x1 units', types: ['weather', 'health', 'clock'] },
    qsToggle: { shape: 'circle on colored circle', layout: '6col x 4row', interaction: 'tap=toggle, longpress=settings' },
    mediaPlayer: { shape: 'squircle(26px)', structure: 'albumArt+title+artist+progress+controls', material: 'extracted palette bg' },
    homeWidget: { shape: 'squircle(26px)', sizes: ['2x1', '2x2', '4x2'], material: 'opaque fill' },
    dialog: { shape: 'squircle(26px top)', structure: 'title+description+buttonPair', behavior: 'modal, blocks surface' },
    edgePanel: { structure: 'panel-content, glass tint', behavior: 'slide-in from edge' }
  }
};

// --- Scenario → relevant constraint keys mapping ---
// Each scenario pulls from DESIGN.md fragments + GENUI fragments as needed
const SCENARIO_CONSTRAINTS = {
  // Format: [DESIGN.md fragments, ...GENUI fragments, ...ORCH fragments]
  home:     ['layout', 'glass', 'depth', 'components', 'genui_classification', 'genui_grammar', 'genui_shapes', 'genui_grid', 'orch_stacking', 'orch_screens', 'orch_widgets', 'orch_icons'],
  login:    ['components', 'layout', 'genui_classification', 'genui_shapes', 'orch_stacking', 'orch_screens', 'orch_containers'],
  settings: ['components', 'layout', 'genui_classification', 'genui_shapes', 'orch_stacking', 'orch_containers'],
  chat:     ['components', 'layout', 'genui_classification', 'genui_shapes', 'genui_connected', 'orch_stacking', 'orch_containers'],
  feed:     ['components', 'layout', 'glass', 'genui_classification', 'genui_density', 'genui_shapes', 'orch_stacking'],
  profile:  ['components', 'layout', 'genui_classification', 'genui_shapes', 'orch_stacking', 'orch_containers'],
  gallery:  ['components', 'layout', 'glass', 'genui_classification', 'genui_grid', 'orch_stacking', 'orch_icons'],
  product:  ['components', 'layout', 'genui_classification', 'genui_shapes', 'orch_stacking', 'orch_containers'],
  lock:     ['glass', 'depth', 'layout', 'genui_classification', 'genui_grammar', 'genui_density', 'genui_ambient', 'genui_components', 'orch_stacking', 'orch_screens', 'orch_zlayers'],
  music:    ['components', 'glass', 'layout', 'genui_classification', 'genui_components', 'genui_connected', 'orch_stacking', 'orch_containers'],
  notif:    ['components', 'glass', 'depth', 'layout', 'genui_classification', 'genui_notifications', 'genui_density', 'genui_grammar', 'orch_stacking', 'orch_containers', 'orch_zlayers'],
  qs:       ['glass', 'depth', 'components', 'layout', 'genui_classification', 'genui_density', 'genui_grammar', 'genui_grid', 'genui_components', 'orch_stacking', 'orch_screens', 'orch_zlayers'],
  iot:      ['components', 'layout', 'glass', 'genui_classification', 'genui_connected', 'genui_shapes', 'orch_stacking', 'orch_containers'],
  dash:     ['components', 'layout', 'glass', 'genui_classification', 'genui_grid', 'genui_density', 'orch_stacking', 'orch_widgets'],
  onboard:  ['components', 'layout', 'genui_classification', 'genui_motion', 'genui_shapes', 'orch_stacking', 'orch_screens'],
  media:    ['components', 'layout', 'glass', 'genui_classification', 'genui_components', 'genui_connected', 'orch_stacking', 'orch_containers'],
  keyboard: ['components', 'layout', 'genui_classification', 'genui_components', 'orch_stacking'],
  default:  ['components', 'layout', 'genui_classification', 'genui_shapes', 'genui_grid', 'orch_stacking', 'orch_antipatterns']
};

// --- Extract constraints for a given prompt/scenario ---
function extractConstraints(prompt, scenario, mode) {
  // Always include core tokens
  const constraints = {
    core: CONSTRAINT_FRAGMENTS.core,
    colors: mode === 'light' ? CONSTRAINT_FRAGMENTS.colors_light : CONSTRAINT_FRAGMENTS.colors_dark,
    rules: CONSTRAINT_FRAGMENTS.rules
  };

  // Determine which extra fragments to include
  const scenarioKey = scenario || _detectScenario(prompt);
  const extraKeys = SCENARIO_CONSTRAINTS[scenarioKey] || SCENARIO_CONSTRAINTS.default;

  for (const key of extraKeys) {
    if (CONSTRAINT_FRAGMENTS[key]) {
      constraints[key] = CONSTRAINT_FRAGMENTS[key];
    }
  }

  // If prompt mentions specific topics, add relevant fragments dynamically
  const promptLower = (prompt || '').toLowerCase();

  // DESIGN.md fragment triggers
  if (promptLower.includes('glass') || promptLower.includes('blur') || promptLower.includes('transparent')) {
    constraints.glass = CONSTRAINT_FRAGMENTS.glass;
  }
  if (promptLower.includes('color') || promptLower.includes('theme') || promptLower.includes('palette')) {
    constraints.semantic_colors = CONSTRAINT_FRAGMENTS.semantic_colors;
  }
  if (promptLower.includes('depth') || promptLower.includes('shadow') || promptLower.includes('elevation')) {
    constraints.depth = CONSTRAINT_FRAGMENTS.depth;
  }

  // GENUI fragment triggers
  if (promptLower.includes('notification') || promptLower.includes('alert')) {
    constraints.genui_notifications = CONSTRAINT_FRAGMENTS.genui_notifications;
  }
  if (promptLower.includes('animation') || promptLower.includes('motion') || promptLower.includes('transition')) {
    constraints.genui_motion = CONSTRAINT_FRAGMENTS.genui_motion;
  }
  if (promptLower.includes('widget') || promptLower.includes('grid') || promptLower.includes('layout')) {
    constraints.genui_grid = CONSTRAINT_FRAGMENTS.genui_grid;
  }
  if (promptLower.includes('now bar') || promptLower.includes('lock') || promptLower.includes('ambient')) {
    constraints.genui_ambient = CONSTRAINT_FRAGMENTS.genui_ambient;
    constraints.genui_components = CONSTRAINT_FRAGMENTS.genui_components;
  }
  if (promptLower.includes('quick setting') || promptLower.includes('toggle') || promptLower.includes('control')) {
    constraints.genui_density = CONSTRAINT_FRAGMENTS.genui_density;
    constraints.genui_grammar = CONSTRAINT_FRAGMENTS.genui_grammar;
  }

  // ORCHESTRATION fragment triggers
  if (promptLower.includes('widget') || promptLower.includes('home')) {
    constraints.orch_widgets = CONSTRAINT_FRAGMENTS.orch_widgets;
    constraints.orch_icons = CONSTRAINT_FRAGMENTS.orch_icons;
  }
  if (promptLower.includes('card') || promptLower.includes('dialog') || promptLower.includes('list') || promptLower.includes('container')) {
    constraints.orch_containers = CONSTRAINT_FRAGMENTS.orch_containers;
  }
  if (promptLower.includes('stack') || promptLower.includes('spacing') || promptLower.includes('gap') || promptLower.includes('layout')) {
    constraints.orch_stacking = CONSTRAINT_FRAGMENTS.orch_stacking;
  }
  if (promptLower.includes('z-index') || promptLower.includes('overlay') || promptLower.includes('modal') || promptLower.includes('layer')) {
    constraints.orch_zlayers = CONSTRAINT_FRAGMENTS.orch_zlayers;
  }

  // --- Evolve.md: inject learned constraints ---
  // Reload from disk each time (file grows during session)
  EVOLVE_CONSTRAINTS = loadEvolveConstraints();
  if (EVOLVE_CONSTRAINTS && EVOLVE_CONSTRAINTS.length > 0) {
    // Filter: include all general constraints + scenario-specific ones
    const scenarioKey2 = scenario || _detectScenario(prompt);
    const relevant = EVOLVE_CONSTRAINTS.filter(e =>
      !e.scenario || e.scenario === 'general' || e.scenario === scenarioKey2
    );
    if (relevant.length > 0) {
      constraints.evolve = relevant.map(e => `[${e.id}] ${e.constraint}`);
    }
  }

  return constraints;
}

function _detectScenario(prompt) {
  if (!prompt) return 'default';
  const p = prompt.toLowerCase();
  const map = {
    home: ['home', 'homescreen', 'launcher', 'wallpaper'],
    login: ['login', 'sign in', 'sign up', 'register', 'account', 'auth'],
    settings: ['settings', 'preferences', 'configuration'],
    chat: ['chat', 'message', 'conversation', 'messenger'],
    feed: ['feed', 'social', 'timeline', 'news'],
    profile: ['profile', 'user', 'my page'],
    gallery: ['gallery', 'photo', 'album', 'image'],
    product: ['product', 'shop', 'store', 'ecommerce', 'cart'],
    lock: ['lock screen', 'lockscreen', 'aod', 'always on'],
    music: ['music', 'player', 'audio', 'spotify', 'playlist'],
    notif: ['notification', 'alert', 'notify'],
    qs: ['quick setting', 'quick panel', 'control center', 'toggle'],
    iot: ['iot', 'smart home', 'device', 'smartthings'],
    dash: ['dashboard', 'health', 'fitness', 'stats', 'analytics'],
    onboard: ['onboard', 'welcome', 'tutorial', 'intro'],
    media: ['media', 'video', 'streaming', 'youtube'],
    keyboard: ['keyboard', 'typing', 'input method']
  };
  for (const [key, keywords] of Object.entries(map)) {
    if (keywords.some(kw => p.includes(kw))) return key;
  }
  return 'default';
}

// --- Format constraints as compact system prompt injection ---
function formatConstraintsForPrompt(constraints) {
  return JSON.stringify(constraints, null, 0);
}

// ============================================================================
// OpenAI proxy
// ============================================================================

// Some OpenAI models (gpt-5 mini/nano variants, o1/o3/o4 reasoning family)
// reject any non-default temperature with a 400. Detect by model id pattern.
// Pattern matches:
//   gpt-5-mini       gpt-5-nano
//   gpt-5.4-mini     gpt-5.5-mini    (any minor version)
//   gpt-5.4-nano     gpt-5.5-nano
//   o1*  o3*  o4*    (reasoning families)
// Models NOT matching this pattern (gpt-4o, gpt-4o-mini, gpt-5.x main, etc.)
// get the requested temperature passed through normally.
const _NO_CUSTOM_TEMP_MODELS = /^(gpt-5(\.\d+)?-(mini|nano)|o1|o3|o4)/i;
function _supportsCustomTemp(model) {
  return !_NO_CUSTOM_TEMP_MODELS.test(model || '');
}

async function callOpenAI(systemPrompt, userMessage, temperature = 0.7, modelOverride) {
  const useModel = modelOverride || OPENAI_MODEL;
  const bodyObj = {
    model: useModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' }
  };
  if (_supportsCustomTemp(useModel)) bodyObj.temperature = temperature;
  const body = JSON.stringify(bodyObj);

  const url = new URL('https://api.openai.com/v1/chat/completions');
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Length': Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const err = JSON.parse(data);
            reject(new Error(err.error?.message || `OpenAI ${res.statusCode}`));
          } catch { reject(new Error(`OpenAI ${res.statusCode}: ${data.substring(0, 200)}`)); }
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content;
          // Cache telemetry: OpenAI returns prompt_tokens_details.cached_tokens
          // when an automatic prefix-cache hit was used. Logging this lets us
          // verify the cache-friendly prompt reorder is actually paying off.
          // Only log when there's a meaningful prompt size (>500 tokens) so
          // tiny calls don't spam.
          try {
            const pt   = parsed.usage?.prompt_tokens || 0;
            const cached = parsed.usage?.prompt_tokens_details?.cached_tokens || 0;
            if (pt >= 500) {
              const pct = pt > 0 ? Math.round((cached / pt) * 100) : 0;
              console.log(`[openai] ${useModel}  prompt=${pt}  cached=${cached} (${pct}%)`);
            }
          } catch (_) { /* ignore telemetry errors */ }
          resolve(JSON.parse(content));
        } catch (e) { reject(new Error('Failed to parse OpenAI response: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('OpenAI request timeout')); });
    req.write(body);
    req.end();
  });
}

// Convenience: routes to OPENAI_MODEL_FAST. Used for the merged
// interpret+normalize stage where TTFT matters most and the work is
// simple JSON extraction.
async function callOpenAIFast(systemPrompt, userMessage, temperature = 0.4) {
  return callOpenAI(systemPrompt, userMessage, temperature, OPENAI_MODEL_FAST);
}

// Convenience: routes to OPENAI_MODEL_EXPLAIN. Used for the final
// explanation stage which paraphrases the pipeline result. The
// _supportsCustomTemp regex above will silently drop the temperature
// arg if the configured explain model rejects custom temperatures
// (gpt-5-mini, o1/o3/o4 reasoning models).
async function callOpenAIExplain(systemPrompt, userMessage, temperature = 0.6) {
  return callOpenAI(systemPrompt, userMessage, temperature, OPENAI_MODEL_EXPLAIN);
}

// Convenience: routes to OPENAI_MODEL_COMPOSE. Used for the layout
// composer (Step 4) — the most complex pipeline stage (spatial reasoning
// + token alignment + ~17-validator avoidance). Often deserves a stronger
// model than OPENAI_MODEL when select doesn't need the same depth.
async function callOpenAICompose(systemPrompt, userMessage, temperature = 0.55) {
  return callOpenAI(systemPrompt, userMessage, temperature, OPENAI_MODEL_COMPOSE);
}

// Convenience: routes to OPENAI_MODEL_CONTENT_BAG. Used by the parallel
// content-bag stage (3.5) which fires alongside runSelect so it does not
// extend critical-path latency. The output is consumed by applyContentSwap
// to fill empty / duplicated content slots in the selector plan.
async function callOpenAIContentBag(systemPrompt, userMessage, temperature = 0.5) {
  return callOpenAI(systemPrompt, userMessage, temperature, OPENAI_MODEL_CONTENT_BAG);
}

// ============================================================================
//  Embeddings — used by Stage 3 RAG shortlist (pipeline.runSelect).
//  Single-input, single-output. Returns a 1536-dim Float64 array.
//  Latency: ~30-80ms per call. Cost: ~$0.000004 per call.
// ============================================================================
async function callOpenAIEmbedding(text) {
  const url = new URL('https://api.openai.com/v1/embeddings');
  const body = JSON.stringify({
    model: 'text-embedding-3-small',
    input: typeof text === 'string' ? text : String(text || '')
  });
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Length': Buffer.byteLength(body)
    }
  };
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const err = JSON.parse(data);
            reject(new Error(err.error?.message || `Embeddings ${res.statusCode}`));
          } catch { reject(new Error(`Embeddings ${res.statusCode}: ${data.substring(0, 200)}`)); }
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const vec = parsed.data?.[0]?.embedding;
          if (!Array.isArray(vec)) reject(new Error('Embedding response missing data[0].embedding'));
          else resolve(vec);
        } catch (e) { reject(new Error('Failed to parse embedding response: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Embedding request timeout')); });
    req.write(body);
    req.end();
  });
}

// ============================================================================
//  Streaming OpenAI call (SSE). Each token delta invokes onDelta(text, full);
//  resolves with the final parsed JSON object when the stream completes.
// ============================================================================
async function callOpenAIStream(systemPrompt, userMessage, temperature, onDelta) {
  const body = JSON.stringify({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    temperature: temperature != null ? temperature : 0.7,
    response_format: { type: 'json_object' },
    stream: true
  });

  const url = new URL('https://api.openai.com/v1/chat/completions');
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Length': Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request(url, options, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', c => err += c);
        res.on('end', () => reject(new Error(`OpenAI ${res.statusCode}: ${err.substring(0, 200)}`)));
        return;
      }
      let buffer = '';
      let fullText = '';
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // last line may be incomplete
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) || '';
            if (delta) {
              fullText += delta;
              try { onDelta(delta, fullText); } catch (e) { /* handler error, ignore */ }
            }
          } catch (e) { /* skip malformed SSE frames */ }
        }
      });
      res.on('end', () => {
        try {
          const finalJson = JSON.parse(fullText);
          resolve(finalJson);
        } catch (e) {
          reject(new Error('Failed to parse streamed JSON: ' + e.message + ' (text length: ' + fullText.length + ')'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('OpenAI stream timeout')); });
    req.write(body);
    req.end();
  });
}

// Scan accumulated (possibly incomplete) JSON text and extract every complete
// object from the `components` array. Uses a minimal brace-counting state
// machine — doesn't require valid JSON at the top level yet.
function extractStreamedComponents(fullText, alreadyEmitted) {
  const match = fullText.match(/"components"\s*:\s*\[/);
  if (!match) return [];
  const start = match.index + match[0].length;
  let depth = 0, inStr = false, esc = false;
  let objStart = -1;
  let foundIdx = 0;
  const out = [];
  for (let i = start; i < fullText.length; i++) {
    const c = fullText[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') { if (depth === 0) objStart = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        if (foundIdx >= alreadyEmitted) {
          try { out.push(JSON.parse(fullText.substring(objStart, i + 1))); }
          catch (e) { /* component still incomplete */ }
        }
        foundIdx++;
        objStart = -1;
      }
    }
    else if (c === ']' && depth === 0) break;
  }
  return out;
}

// ============================================================================
// System Prompt Builders (constraint-driven, NOT raw document injection)
// ============================================================================

// Compact per-role contract the AI can consume when choosing components.
// Each entry names: the role, its legal variant cardinality (when one
// exists), and the content fields it REQUIRES vs OPTIONALLY supports.
// Without this block the AI sees a flat enum of 60 roles and emits them
// as empty shells — the dummy-label problem. With it, the AI knows:
// "if I pick now-bar type=media, I must supply content.title + content.sub;
//  if I pick notif-card, I must supply content.title + content.body".
//
// Field names intentionally use both `content.*` and `variant.*`; the
// renderers read from both channels depending on the role (rich atomics
// like now-bar/notif-card read variant.*, chrome like app-bar/list-item
// reads content.*). Emitting under `content` is always safe because the
// server + client both merge content → variant before render.
function buildRoleSchemaHints() {
  return `=== ROLE CONTRACTS (what each role MUST and MAY carry) ===
Every role you emit MUST satisfy its REQUIRED fields. If you cannot
produce specific content for a REQUIRED field from the user's prompt,
omit the component entirely — do NOT fill with placeholder strings.

LAYOUT WIDTH HINT (for content cards — focus-block, notif-card, media-
card, information_glance_tile, etc.)
Every content card MAY set variant.width to control its layout:
  variant.width = "full"  → spans the full row (1-col, editorial hero)
  variant.width = "half"  → half-width, pairs with the adjacent half
  (omitted)               → sensible role default (focus-block=full;
                            information_glance_tile=half; media-half=half)

You CAN mix full + half in the same screen. Typical patterns:
  • 1 hero (full) + 2 glance tiles (half, half)     → overview with headline
  • 4 glance tiles (half × 4)                       → symmetric grid
  • 2 full cards stacked                            → editorial column
  • 1 full CTA card at top, 1 full summary below    → linear flow
Emit half ONLY in pairs (even count) OR the packer will render a
stranded half as a centered half-width card — still intentional-looking
but avoid unless you want that.

Chrome / app bars:
  expandable-app-bar   state ∈ {expanded, collapsed}. REQ content.title.
                       OPT content.sub (shown only when expanded).
  collapsed-app-bar    REQ content.title. OPT trailing ⋮ action is rendered.
  selection-app-bar    REQ content.title (e.g. "3 selected").
  search-bar           OPT content.placeholder (else a random Figma variant).
  list-top-bar         OPT content.title + auto time + date line.
  bottom-navigation    OPT content.tabs = [{label, icon}, …] (2–5 items).
  bottom-bar           OPT content.actions = [{label, icon}, …].
  app-dock             OPT content.apps = [{name, icon}, …] (typically 4).
  app-grid             OPT content.apps = [{name, icon}, …] (up to 20).

Lock screen:
  lock-clock           No required content — renderer uses current time.
  weather-date         OPT content.temperature + content.condition + content.date.
  unlock-hint          OPT content.text (default "Swipe up to open").
  lock-shortcuts       OPT content.shortcuts = [{icon, label}] (2 items).

Content containers:
  focus-block          variant.kind ∈ {hero, secondary, widget, (default)}.
                       REQ content.title. OPT content.sub, content.body,
                       content.value, content.accent (hex).
                       • kind=hero      → minimal art card, no text content
                       • kind=secondary → title + body paragraph (editorial)
                       • kind=widget    → title + value + sub (dashboard cell)
                       • (default)      → title + sub (single-source card)
  focus-block-group    REQ content.items = [ {title, value, sub, accent?} … ].
                       Each item renders as a kind=widget cell in a grid.
  list-item            REQ content.title. OPT content.sub, content.icon,
                       content.trailing (right-side value/chevron).
  list                 REQ content.items = [{title, sub?, icon?}] (3+ items).
  paragraph            REQ content.body (1–3 sentences of real prose).
  action-row           REQ content.actions = [{label, icon?}] (2–4 items).

Media / live activity:
  now-bar              variant.type ∈ {media, timer, charging, navigation}.
                       • type=media     → REQ content.title (song), OPT
                                          content.artist, content.marquee
                       • type=timer     → REQ content.time (e.g. "12:34")
                                          or content.value (e.g. "27 min")
                       • type=charging  → REQ content.percent ∈ 0..100
                       • type=navigation→ REQ content.title (turn text)
                                          OPT content.sub (ETA / distance)
  media-card           REQ content.title + content.artist. OPT content.album,
                       content.image.
  media-half           REQ content.title. OPT content.sub (half-width media).
  progress-track       REQ content.value ∈ 0..100. OPT content.label.

Notifications / AI:
  notif-card           variant.urgency ∈ {low, medium, high}. REQ content.title
                       (sender/app), content.body (message preview).
                       OPT content.time, content.accent, content.icon.
  notif-card-ai        REQ content.summary (AI-condensed 1-line). OPT
                       content.source (which apps summarized), content.icon.

Quick Settings / controls:
  toggle-chip          variant.state ∈ {on, off}. REQ content.label
                       (e.g. "Wi-Fi", "Bluetooth").
  toggle-grid          REQ content.toggles = [{label, state, icon?}] (4–8).
  slider-panel         variant.type ∈ {brightness, volume, (custom)}. REQ
                       content.value ∈ 0..100. OPT content.label.
  slider-pill          REQ content.value ∈ 0..100. OPT content.label.
  single-toggle        variant.kind ∈ {toggle, shortcut}. REQ content.label.
                       OPT variant.width ∈ {half, full}.
  smart-things         REQ content.title. OPT content.status + content.devices.
  qs-action-tile       REQ content.label + content.icon. OPT content.value.

Dialogs:
  selection-dialog     variant.theme ∈ {light, dark}. REQ variant.title +
                       variant.options = [string, …] (2+ options).
  bottom-dialog        REQ content.title. OPT content.body + content.actions.
  center-dialog        REQ content.title + content.body. OPT content.actions.
  dialog-shell         No required content (pure glass container).
  dialog-site-header   REQ variant.siteName + variant.url.
  dialog-browser-bar   Renders a fixed 5-action row (History, Downloads,
                       Galaxy AI, Add page, Settings). No content needed.
  dialog-icon-grid     Renders a fixed 2×4 app grid. No content needed.

CONTENT AUTHORING DISCIPLINE:
- If the prompt says "transfer $200 to my sister": emit recipient name,
  exact amount, funding account IF the prompt hints at one — never "Sister"
  or "Account" as the literal string.
- If the prompt says "tonight weather on lockscreen" and no temperature
  is given: YOU MAY hallucinate a plausible weather state (e.g. "68°
  cloudy, low 52°") — users expect filled screens, not blanks. Invent
  realistic specifics; never write "72°" + "sample weather".
- Numbers, proper nouns, and units make a screen feel alive. Emit them
  wherever the schema allows, even if you have to generate plausible
  values.
`;
}

function buildGenerateSystemPrompt() {
  return `
You are generating semantic UI plans for Samsung One UI 8.5 mobile surfaces.

Do not generate arbitrary freeform layouts.
Do not return absolute pixel coordinates.
Do not return generic vertical card stacks unless they are explicitly part of a role-aware surface plan.

You must think in surface grammar.

=== YOUR JOB ===
Propose semantic components. The frontend renderer owns spatial placement.

You will receive a "4+2+1 ORCHESTRATION BRIEF" in the user message. It
tells you the PURPOSE TYPE (one of 4), the body/environment modulation,
the multi-device modulation, and any governance triggers. READ THIS
BRIEF FIRST and let it drive what you include and what you suppress.

Decision order (always):
1. Read the orchestration brief → understand what purpose this UI serves.
2. Based on the purpose + modulation, decide which components MUST show
   and which must be SUPPRESSED or deferred.
3. **Prefer SEMANTIC IDs over raw atomic roles** — see
   "SEMANTIC COMPONENT VOCABULARY" below. A semantic id like
   "contextual_summary_card" carries design INTENT and resolves to an
   atomic role + variant automatically; a bare "focus-block" has none of
   that signal. Fall back to a raw atomic role ONLY when no semantic
   id genuinely fits the intent.
4. Read each chosen role's contract in "ROLE CONTRACTS" below. Fill
   every REQUIRED content field. If the prompt genuinely lacks a value
   you need, hallucinate a PLAUSIBLE specific (not "Title" / "Body") —
   users expect a complete screen, not blanks.
5. Fill content with SPECIFIC detail from the prompt (never placeholder).
6. Pick the surfaceType that best carries the resulting component set.

Always determine:
1. surfaceType (one of ALLOWED_SURFACE_TYPES)
2. user intent (a specific phrase derived from the prompt — not generic)
3. content hierarchy (what leads, what supports — drive it with typography
   scale: hero > headline > large > title > body > label > caption > micro)
4. component roles — PREFER semantic ids; pick the RICHEST role that fits
5. role-specific content (use SPECIFIC detail from the prompt — never placeholder text)
6. allowed state values (expandable-app-bar = expanded|collapsed only)

=== CONTENT QUALITY BAR (this is the bar to clear) ===
The renderer already produces a working template for any surfaceType.
What YOU add is SPECIFIC CONTENT that reflects the user's scenario.

GOOD:
  prompt: "Morning brief with weather"
  - expandable-app-bar.text = "Good morning, Kyuha"
  - focus-block.content.title = "72° partly cloudy"
  - focus-block.content.sub = "Low 58° · Rain expected 4 PM"

BAD:
  - expandable-app-bar.text = "Home"         (generic)
  - focus-block.content.title = ""           (empty)
  - focus-block.content.sub = "Card content" (placeholder)

=== FORBIDDEN PLACEHOLDER STRINGS ===
Never write any of these into text / title / sub / body / label. The
server REJECTS components that contain placeholder text and the
component is silently dropped from the output:

  "Focus block"                  "Title"              "Subtitle"
  "Important content goes here"  "Content goes here"  "Card content"
  "Generic card"                 "Placeholder"        "Label"
  "Primary action"               "Secondary action"   "Lorem ipsum"
  "Sample text"                  "Your content"       "TBD" / "TODO"

If you don't have a specific value for a field derived from the user's
prompt, OMIT that field or OMIT the entire component. Never fill it
with a design-system-demo string.

For a health-coach prompt, WRONG:
  focus-block.content.title = "Focus block"
  focus-block.content.sub   = "Important content goes here"
RIGHT:
  focus-block.content.title = "Heart rate \u2014 72 bpm resting"
  focus-block.content.sub   = "Steady for the last 3 hours"

=== COMPONENT SELECTION HINTS ===
These are atomic-role hints for when you drop to raw roles (see "SEMANTIC
COMPONENT VOCABULARY" first — semantic ids are the PREFERRED path and
cover most of these intents at a higher level of expression).

Pick components that MATCH the activity in the prompt. When emitting a
now-bar (directly or via continuity_bridge_panel / ambient_status_line),
variant.type is REQUIRED and must match the scenario — pick from
{media, timer, charging, navigation, delivery, dual-line}. Emitting a
music-player (type="media") now-bar for a cooking / workout / navigation
scenario looks broken.

- "music playing", "listening", "podcast"     → continuity_bridge_panel
                                                 + variant.type="media"
                                                 (play/prev/next controls)
- "charging", "low battery"                    → ambient_status_line
                                                 + variant.type="charging"
                                                 (battery % + bolt icon)
- "cooking", "pasta timer", "recipe step"      → continuity_bridge_panel
                                                 + variant.type="timer"
                                                 (stopwatch icon + MM:SS label)
                                                 plus a focus-block kind=hero
                                                 for the current step text
- "workout duration", "running time"           → continuity_bridge_panel
                                                 + variant.type="timer"
- "timer", stopwatch"                          → now-bar variant.type="timer"
- "navigation", "turn-by-turn", "directions"   → continuity_bridge_panel
                                                 + variant.type="navigation"
                                                 (turn arrow + street name)
- "delivery ETA", "package arriving"           → now-bar variant.type="delivery"
- "notifications pending", "messages from X"   → notification_summary (preferred)
                                                 or notif-card / notif-card-ai
- "toggle wifi", "bluetooth", "airplane"       → include toggle-chip or toggle-grid
- "lock screen"                                → lock-clock + weather-date + optionally
                                                 continuity_bridge_panel or now-bar
- "quick settings"                             → slider-panel (brightness/volume) + toggle-grid
- "share sheet", "pick browser"                → target_picker (preferred)
                                                 or dialog-shell + dialog-icon-grid
- "menu", "pick one of", "choose option"       → coordination_sheet (preferred)
                                                 or selection-dialog
- morning brief / status glance                → intent_header + information_glance_tile x2-3
                                                 + notification_summary (preferred over
                                                 app-bar + focus-block stack)
- Confirm/commit/pay moments                   → primary_action_pill + explanation_footer
                                                 + override_action
- Ambient, glanceable, minimal-touch contexts  → focus_protection_overlay (preferred)
                                                 or focus-block with kind="secondary"
                                                 (title + body text), avoid dense lists

=== SAMSUNG DESIGN VOICE — DO'S & DON'TS ===
These are the voice + shape + typography rules that separate a Samsung
screen from a generic "design-system demo". Emitted output must
respect them; content that violates these rules will feel wrong even
when the surface grammar is correct.

DO:
- Use SamsungSharpSans for HEADLINES, SamsungOne for body/UI text — assume
  the renderer picks the right family by role, but WRITE copy that suits
  its family (short punchy for sharp-sans, conversational for sans).
- Apply 700 weight to every SamsungSharpSans headline (e.g. lock-clock,
  hero focus-block titles, expandable-app-bar.text when state="expanded").
- Prefer GLASS treatment on floating system surfaces (now-bar,
  bottom-navigation, notif-card, quick-settings panel). These are
  frosted blur + thin outline + wallpaper-reactive tint — never solid.
- Use PILL radius for floating bars, CTAs, navigation — and 26dp SQUIRCLE
  for cards, dialogs, containers. Pick component roles that align with
  the intended shape language (now-bar = pill; focus-block = squircle).
- Layer depth using the three-layer system:
  Blur (emphasis, e.g. focus-block in hero) ·
  Dim  (hierarchy, e.g. overlay behind dialog) ·
  Shadow (connection, e.g. raised cards). Pick ONE per component.
- Reserve the Galaxy AI gradient (#64E9E3 → #9FFAC7) and Galaxy Yellow
  (#FFF01F) ONLY for AI moments — notif-card-ai, Bixby / AI summary
  blocks, AI-recommended actions. Don't spray them on generic cards.
- Use Samsung Blue (#1428A0) ONLY as a brand accent — tab indicator, CTA
  outline, key link color. Never as a background fill.
- Keep body / UI text LEFT-aligned. Centering reads as "marketing", not
  Samsung system UI.

DON'T:
- Don't mix SamsungSharpSans into body copy (list subtitles, help text,
  caption), and don't use SamsungOne for display headlines.
- Don't emit weights below 400 — ultralight is off-brand for Samsung UI.
- Don't combine Dim AND Shadow on the same component (pick one).
- Don't use Samsung Blue as a large background fill — it belongs as an
  accent only.
- Don't introduce 0px-radius corners on Gen components — Samsung's
  Gen-component language is always rounded (pill or 26dp squircle).
- Don't apply decorative letter-spacing to SamsungSharpSans headlines.
- Don't give floating system elements OPAQUE backgrounds — now-bar,
  toolbar, quick-settings MUST be glass (alpha + blur).
- Don't center-align body text. Left-align only (RTL locales are
  mirrored by the renderer, you don't need to think about that).
- Don't treat decorative illustrations as content — if a screen needs
  hero art, it goes in the wallpaper layer, not a focus-block.

=== ONE UI STRUCTURAL RULES ===
- viewing area and interaction area are distinct
- important content should use focus-block hierarchy when appropriate
- bottom bar and bottom navigation are different roles
- safe side margins are respected by the renderer
- expandable app bar may rest only in "expanded" or "collapsed"
- do not mix navigation and action components at the bottom
- every component.role MUST come from ALLOWED_ROLES below

=== STRICT OUTPUT SHAPE ===
Return STRICT JSON only:
{
  "layoutTree": {
    "surfaceType": "<from ALLOWED_SURFACE_TYPES>",
    "intent": "<specific phrase from prompt, 3-7 words>",
    "hierarchy": "focus-on-list | focus-on-hero | focus-on-dialog | focus-on-chrome"
  },
  "renderModel": {
    "surfaceType": "<same as above>",
    "layout": { "surfaceType": "<same>", "theme": "dark | light", "variant": "one-ui" },
    "components": [
      {
        "id": "<unique-id>",
        "role": "<a SEMANTIC id (preferred) OR an atomic ALLOWED_ROLE>",
        "state": "<optional — only for app bars>",
        "text": "<top-level text if the role carries a primary string>",
        "content": {
          "title": "<specific to prompt>",
          "sub": "<specific to prompt>",
          "value": "<specific to prompt>",
          "items": [ { "title": "", "sub": "" }, ... ]
        },
        "variant": { "<only set if using a raw atomic role; semantic ids auto-variant>": "" }
      }
    ]
  },
  "critic": { "score": 0, "issues": [], "suggestions": [] }
}

Concrete output example — a morning-brief screen using SEMANTIC ids
(this is what a good response looks like):

{
  "layoutTree": { "surfaceType": "lockscreen", "intent": "morning status glance",
                  "hierarchy": "focus-on-hero" },
  "renderModel": {
    "surfaceType": "lockscreen",
    "layout": { "surfaceType": "lockscreen", "theme": "dark", "variant": "one-ui" },
    "components": [
      { "id": "hdr", "role": "intent_header",
        "content": { "title": "Good morning, Kyuha", "sub": "Today at a glance" } },
      { "id": "weather", "role": "information_glance_tile",
        "content": { "title": "72\u00b0 partly cloudy", "sub": "Low 58\u00b0 \u00b7 Rain 4 PM" } },
      { "id": "cal", "role": "information_glance_tile",
        "content": { "title": "Design review \u00b7 3 PM", "sub": "with Sarah + Alex" } },
      { "id": "msgs", "role": "notification_summary",
        "content": { "title": "3 unread messages",
                     "sub": "Sarah \u00b7 Alex \u00b7 Design team" } }
    ]
  },
  "critic": { "score": 88, "issues": [], "suggestions": [] }
}

=== ALLOWED_SURFACE_TYPES ===
lockscreen, first-depth-list, second-depth-detail, tab-root,
dialog-bottom, dialog-center, quick-settings, notification-shade, selection-mode

${buildRoleSchemaHints()}

=== ALLOWED_ROLES ===
Chrome / layout:
  status-bar, expandable-app-bar, collapsed-app-bar, selection-app-bar,
  search-bar, list-top-bar, bottom-navigation, bottom-bar,
  app-dock, app-grid, app-icon

Content containers:
  focus-block, focus-block-group, list, list-item, detail-content,
  notification-list, paragraph, action-row

Lock screen:
  lock-clock, weather-date, lock-indicator, unlock-hint, lock-shortcuts

Live activity / media:
  now-bar (type: media | timer | charging | dual-line | single-line),
  media-card, media-half, progress-track, output-chip, media-output-row,
  control-pill

Notification / AI:
  notif-card, notif-card-ai

Quick Settings atomics:
  toggle-chip, toggle-grid, slider-pill, slider-panel, single-toggle,
  smart-things, qs-action-tile, drag-handle, quick-settings-panel

Dialog atomics:
  dialog-shell, dialog-site-header, dialog-browser-bar, dialog-icon-grid,
  bottom-dialog, center-dialog, selection-dialog

Background:
  background, scrim

=== SEMANTIC COMPONENT VOCABULARY (STRONGLY PREFER THESE) ===

These are INTENT-BASED component IDs. They carry design meaning
("what this component is DOING for the user") on top of the atomic
role they resolve to.

USE a semantic id whenever your purpose matches one of them. The
server resolves each semantic id to its atomic role + default
variant automatically — you do NOT set variant yourself. Only fall
back to a raw atomic role when the semantic vocabulary genuinely
doesn't cover your intent.

Concrete examples of the PREFERRED choice:

  Morning brief screen (context_reconstruction)
    GOOD: intent_header + information_glance_tile x3 + notification_summary
    BAD : expandable-app-bar + focus-block x3 + notif-card-ai
          (renders the same, but drops every bit of design intent)

  Music playing ambient (focus_protection)
    GOOD: ambient_status_line + explanation_footer
    BAD : now-bar + paragraph

  Watch-to-phone handoff (flow_continuity)
    GOOD: intent_header + continuity_bridge_panel + progress_trail
          + primary_action_pill
    BAD : expandable-app-bar + now-bar + progress-track + single-toggle

  Pick browser to share (multi_party_coordination)
    GOOD: intent_header + coordination_sheet + target_picker
    BAD : expandable-app-bar + selection-dialog + dialog-icon-grid

Content cards
  contextual_summary_card   unified summary of many sources (context_reconstruction)
  information_glance_tile   small single-source glance tile (grid friendly)
  focus_protection_overlay  ambient card for low-attention contexts

Continuity / live activity
  continuity_bridge_panel   active session continuation hero (flow_continuity)
  ambient_status_line       glanceable one-line status pill
  progress_trail            visible session progress bar

Actions
  primary_action_pill       the ONE main action for this moment
  override_action           explicit "Not now" / escape hatch

Coordination
  coordination_sheet        options + alignment actions (multi_party_coordination)
  target_picker             grid of target apps/devices (share / handoff)

Governance annotations
  explanation_footer        "Why this UI?" caption text
  handoff_affordance        device-to-device transfer invitation

Attention / interruption
  interruption_banner       time-sensitive alert demanding attention NOW
  notification_summary      AI-condensed summary of notifications

Chrome-ish
  intent_header             greeting / contextual heading (app-bar)
  scenario_title_bar        compact title + time/date bar above content

EMIT RULE
  You MAY mix semantic ids and atomic roles in the same components
  array. If you use a semantic id, the server resolves it for you —
  you don't need to set variant/role manually. If the semantic list
  doesn't cover what you need, fall back to the raw atomic role.

AVOID COLLISIONS — only ONE semantic id that resolves to a given
atomic role per screen. The following ids all resolve to the SAME
atomic; pick EXACTLY ONE:
  • continuity_bridge_panel / ambient_status_line / (raw) now-bar
        → all become now-bar with variant.type=media
        → pick continuity_bridge_panel when it represents the ACTIVE
          session hero; pick ambient_status_line only when NO
          continuity panel is appropriate; never emit both.
  • contextual_summary_card / information_glance_tile /
    focus_protection_overlay / handoff_affordance / (raw) focus-block
        → all become focus-block variants
        → fine to emit MULTIPLE focus-blocks with DIFFERENT titles
          (they're not collisions — they render as a grid / stack).
          Just don't emit two focus-blocks with the same title.
  • intent_header / (raw) expandable-app-bar
        → both become expandable-app-bar; pick ONE.

If you emit multiple colliders, the server will drop all but one
and you will get a sparser-than-intended screen.

LOCKSCREEN CONTEXT — BASE LAYERS ALREADY RENDERED
When surfaceType === "lockscreen", the renderer starts from the
canonical Samsung Screen/Lock template as the BASE LAYER. These
atomics are ALREADY on canvas before your output is applied:
  • status-bar     (top system bar with signal / battery / carrier)
  • lockIndicator  (padlock icon at top center)
  • weatherDate    (condition + temp + date thin line above the clock)
  • clock          (huge center clock — auto-fills current time)
  • shortcutLeft   (phone glass circle, bottom-left)
  • shortcutRight  (camera glass circle, bottom-right)
  • gestureBar     (full-width home indicator at very bottom)

DO NOT re-emit these — they're already there. Your job on lockscreen
is to add CONTEXTUAL OVERLAYS that answer the specific prompt:
  • now-bar        (variant.type ∈ media|timer|charging|navigation)
                   for active media / timers / charging / turn-by-turn
  • notif-card /
    notif-card-ai  for a pending message / AI summary
  • focus-block
    kind=secondary for a narrative caption ("Heart rate steady", etc.)
  • media-card     for album art + play controls
  • progress-track for a visible progress bar (run / workout / download)

The overlays land in the INTERACTION zone (below the huge clock), so
you don't need to worry about collisions with the base chrome. Emit
only what the prompt actually calls for — a glance-only lockscreen
might just be the base with ONE focus-block caption; a music
lockscreen is the base + a now-bar + optional focus-block narrative.

CONTEXT-AWARE CONTENT UPDATES to base atomics are fine — if you want
the weatherDate to show "Rain tonight · 52°" you MAY emit a
weatherDate with content.{condition, temperature, date} and the
server will merge it into the base slot. But don't emit an empty
clock / lockIndicator / shortcut just for the sake of it.
`;
}

function buildGenerateUserPrompt(payload) {
  const constraints = extractConstraints(
    payload.prompt || payload.scenario || '',
    payload.scenario,
    payload.mode || 'dark'
  );
  const tokenSummary = formatConstraintsForPrompt({
    core: constraints.core,
    colors: constraints.colors,
    typography: constraints.typography
  });

  // Extract user-mentioned keywords so the prompt explicitly pushes the
  // LLM to use THESE specifics in component text/content. A common
  // failure mode was the model generating generic "Home" / "Messages"
  // headers regardless of what the user typed.
  const keywordSource = [payload.prompt, payload.intent, payload.activity]
    .filter(Boolean).join(' ').toLowerCase();
  const keywordHints = [];
  [
    ['music', 'now-bar with type="media"'],
    ['playing', 'now-bar with type="media"'],
    ['podcast', 'now-bar with type="media"'],
    ['charging', 'now-bar with type="charging"'],
    ['battery', 'now-bar with type="charging"'],
    ['timer', 'now-bar with type="timer"'],
    ['cooking', 'now-bar with type="timer"'],
    ['workout', 'now-bar with type="timer"'],
    ['weather', 'focus-block with weather info OR weather-date atomic'],
    ['calendar', 'focus-block or list-item with calendar summary'],
    ['message', 'notif-card OR list-item with message preview'],
    ['notification', 'notif-card or notif-card-ai'],
    ['wifi', 'toggle-chip or toggle-grid'],
    ['bluetooth', 'toggle-chip or toggle-grid'],
    ['brightness', 'slider-panel'],
    ['volume', 'slider-panel']
  ].forEach(function (pair) {
    if (keywordSource.indexOf(pair[0]) !== -1) keywordHints.push(pair[1]);
  });
  const hintBlock = keywordHints.length
    ? `Component hints based on prompt keywords (use at least one of these):\n  - ${Array.from(new Set(keywordHints)).join('\n  - ')}\n`
    : '';

  const contextLine = [
    payload.timeOfDay ? `timeOfDay=${payload.timeOfDay}` : null,
    payload.activity  ? `activity="${payload.activity}"` : null,
    payload.intent    ? `intent="${payload.intent}"`     : null
  ].filter(Boolean).join(', ');

  // Build a full decision brief the generator can reason with. The
  // brief stacks the four upstream layers the classifier produced:
  //   (1) 4+2+1 orchestration    → purpose policy
  //   (2) interpretation         → what the user is really trying to do
  //   (3) state packet           → compressed decision state
  //   (4) information priority   → must_show / suppress / defer lists
  // The generator reads these in order BEFORE choosing components.
  const orch = payload.orchestration || null;
  const orchBlock     = orch ? buildOrchestrationBrief(orch) : '';
  const interpBlock   = payload.interpretation      ? buildInterpretationBrief(payload.interpretation) : '';
  const stateBlock    = payload.statePacket         ? buildStatePacketBrief(payload.statePacket)       : '';
  const priorityBlock = payload.informationPriority ? buildPriorityBrief(payload.informationPriority)  : '';
  // R4: per-node FLOW brief. When this payload represents ONE node of a
  // multi-node flow graph, tell the generator which moment in the flow it
  // is rendering so it produces content appropriate for THIS node only
  // (e.g. "entry = glance", "action = decisive choice", "completion =
  // outcome+handoff"). When absent, the generator behaves exactly as the
  // single-screen path.
  const flowBlock = payload.flowNode ? buildFlowNodeBrief(payload.flowNode) : '';
  // Design tokens ladder (typography / glass / radius / spacing / touch
  // target minimum). Always-on — independent of prompt keywords — so
  // every generation gets the full visual-hierarchy vocabulary to reason
  // about. See buildDesignRulesBrief comment for background.
  const designRulesBlock = buildDesignRulesBrief();

  return `
Requested surfaceType: ${payload.surfaceType || 'first-depth-list'}
Classified context: ${contextLine || '(none extracted)'}
Scenario key: ${payload.scenario || ''}
Prompt: ${payload.prompt || ''}
Brand: ${payload.surface || 'samsung'}
Mode: ${payload.mode || 'dark'}
Device: ${payload.device || 'Galaxy S26'}

${flowBlock}${orchBlock}${interpBlock}${stateBlock}${priorityBlock}${designRulesBlock}Constraints:
${JSON.stringify(payload.constraints || {}, null, 2)}

Design tokens (for copy/color/typography reference only — do not quote coordinates):
${tokenSummary}

Reference image attached: ${payload.referenceImage ? 'yes' : 'no'}

${hintBlock}Instructions:
- Every component MUST reflect the USER'S SPECIFIC prompt in its text/content.
- Use concrete details from the prompt, not generic fill ("Home", "Card content", "").
- Respect the 4+2+1 ORCHESTRATION BRIEF above: the purpose type dictates
  what MUST show vs. what should be suppressed.
- If timeOfDay is set, choose greetings / accent copy that match it
  (morning → "Good morning", night → "Tonight" / "Evening briefing").
- If activity is set, surface it via a now-bar (media/timer/charging) OR a
  focus-block with narrative title + body.
- Keep the response semantic and role-based. The frontend renderer handles placement.
- Choose only from approved roles and approved surface types.
- Prefer richer OneUI 8.5 atomics (now-bar, media-card, toggle-grid, slider-panel,
  notif-card-ai, selection-dialog) over plain focus-block whenever the prompt
  makes one of them appropriate.
`;
}

// Format the 4+2+1 classification as a concise decision brief that the
// generator LLM can consume. Only included when the classifier produced
// a non-null orchestration payload — otherwise returns empty string so
// the prompt stays lean.
function buildOrchestrationBrief(orch) {
  if (!orch || !orch.purpose) return '';
  const purposePolicy = {
    context_reconstruction: [
      'PURPOSE: context_reconstruction — consolidate scattered signals into ONE unified view.',
      '  must_show  : the consolidated conclusion (summary cards, aggregate widgets).',
      '  suppress   : raw per-source lists when a summary covers them.',
      '  pattern    : focus-block (kind=hero or secondary) carrying the synthesis.'
    ],
    flow_continuity: [
      'PURPOSE: flow_continuity — preserve the thread of intent across time/surface/device.',
      '  must_show  : continuity-critical state (current step, next step, active session).',
      '  suppress   : any component that breaks the thread.',
      '  pattern    : now-bar + progress-track + handoff affordance.'
    ],
    focus_protection: [
      'PURPOSE: focus_protection — reduce interruptions. Only the one thing that matters.',
      '  must_show  : the single most urgent / ambient signal.',
      '  suppress   : app-grid, dense widgets, promotional content, long lists.',
      '  defer      : anything not time-critical.',
      '  pattern    : now-bar + 1 minimal focus-block. Low density, high glass tier.'
    ],
    multi_party_coordination: [
      'PURPOSE: multi_party_coordination — surface conflicts and alignment actions.',
      '  must_show  : conflict visibility + resolution actions.',
      '  suppress   : single-user personalization until conflict resolves.',
      '  pattern    : selection-dialog / action-row / list showing parties and their states.'
    ]
  };
  const pri = orch.purpose.primary || 'context_reconstruction';
  const sec = orch.purpose.secondary;
  const lines = [];
  lines.push('==== 4+2+1 ORCHESTRATION BRIEF ====');
  (purposePolicy[pri] || purposePolicy.context_reconstruction).forEach(l => lines.push(l));
  if (sec && purposePolicy[sec]) {
    lines.push('(Secondary purpose: ' + sec + ' — layer lightly on top of primary)');
  }
  if (orch.purpose.reasoning) {
    lines.push('Why this purpose: ' + orch.purpose.reasoning);
  }

  const m = orch.modulationA || {};
  const modA = [];
  if (m.attention)    modA.push('attention=' + m.attention);
  if (m.mobility)     modA.push('mobility=' + m.mobility);
  if (m.interaction)  modA.push('interaction=' + m.interaction);
  if (m.privacy)      modA.push('privacy=' + m.privacy);
  if (m.time_of_day)  modA.push('time=' + m.time_of_day);
  if (m.ambient)      modA.push('ambient=' + m.ambient);
  if (modA.length) lines.push('Modulation A (body/env): ' + modA.join(', '));
  if (m.attention === 'glanceable' || m.attention === 'distracted') {
    lines.push('  → REDUCE density. Collapse non-essentials. Prefer minimal-touch targets.');
  }
  if (m.interaction === 'minimal-touch' || m.mobility === 'driving') {
    lines.push('  → Touch targets ≥ 56px. No fine-grain dense lists.');
  }

  const d = orch.modulationB || {};
  const modB = [];
  modB.push('device_count=' + d.device_count);
  if (d.primary_device)   modB.push('primary=' + d.primary_device);
  if (d.handoff_required) modB.push('handoff→' + (d.handoff_target || 'target?'));
  if (modB.length) lines.push('Modulation B (device): ' + modB.join(', '));
  if (d.handoff_required) {
    lines.push('  → Surface a handoff affordance (continuity hint, device icon).');
  }

  const g = orch.governance || {};
  if ((g.triggers && g.triggers.length) || g.explanation_needed || g.override_needed) {
    lines.push('Governance: triggers=[' + (g.triggers || []).join(',') + ']' +
      ', autonomy=' + (g.autonomy_level || 'advise') +
      (g.explanation_needed ? ', explanation_needed' : '') +
      (g.override_needed ? ', override_needed' : ''));
    if (g.explanation_needed) {
      lines.push('  → Include an explicit "why this" rationale in one component\'s sub-text.');
    }
    if (g.override_needed) {
      lines.push('  → Include an explicit user-override action (e.g. "Not now", "Change").');
    }
  }
  lines.push('==== END BRIEF ====');
  lines.push('');
  return lines.join('\n');
}

// R2: interpretation layer brief. Forces the generator to remember the
// 6 question answers before choosing components — the "what is the user
// actually trying to do" context that shouldn't be lost between the
// classifier and the component selector.
function buildInterpretationBrief(interp) {
  if (!interp) return '';
  const lines = [];
  lines.push('==== INTERPRETATION ====');
  if (interp.what_user_doing)  lines.push('user_doing:  ' + interp.what_user_doing);
  if (interp.real_goal)        lines.push('real_goal:   ' + interp.real_goal);
  if (interp.most_lacking)     lines.push('lacking:     ' + interp.most_lacking);
  if (interp.what_interferes)  lines.push('interferes:  ' + interp.what_interferes);
  if (interp.system_role && interp.system_role.length) {
    lines.push('system_role: ' + interp.system_role.join(' + '));
  }
  if (interp.interaction_complexity) {
    lines.push('complexity:  ' + interp.interaction_complexity);
  }
  lines.push('');
  return lines.join('\n');
}

// R2: compressed state packet brief — machine-readable decision packet.
// The generator treats this as a set of HARD constraints on component
// selection (attention_capacity=low → reject dense grids, etc.).
function buildStatePacketBrief(sp) {
  if (!sp) return '';
  const lines = [];
  lines.push('==== STATE PACKET ====');
  const pairs = [
    ['purpose_type',       sp.purpose_type],
    ['primary_goal',       sp.primary_goal],
    ['journey_stage',      sp.journey_stage],
    ['urgency',            sp.urgency],
    ['attention_capacity', sp.attention_capacity],
    ['interaction_budget', sp.interaction_budget],
    ['coordination_need',  sp.coordination_need],
    ['device_role',        sp.device_role],
    ['system_role',        sp.system_role],
    ['autonomy_level',     sp.autonomy_level]
  ];
  pairs.forEach(p => { if (p[1]) lines.push(p[0].padEnd(20) + ': ' + p[1]); });
  if (sp.privacy_level)       lines.push('privacy_level       : ' + sp.privacy_level);
  if (sp.explanation_needed)  lines.push('explanation_needed  : yes');
  if (sp.override_needed)     lines.push('override_needed     : yes');
  if (sp.handoff_required)    lines.push('handoff_required    : yes');
  lines.push('');
  return lines.join('\n');
}

// R2: information priority brief — the CONTRACT the generator must
// honor. must_show entries should map to actual components in the
// output. suppress entries must NOT appear. defer entries may appear
// marked with visibility="collapsed".
function buildPriorityBrief(ip) {
  if (!ip) return '';
  const lines = [];
  lines.push('==== INFORMATION PRIORITY (contract) ====');
  if (ip.must_show.length) {
    lines.push('MUST_SHOW   : ' + ip.must_show.join(', '));
    lines.push('              → Each of these MUST correspond to an emitted component.');
  }
  if (ip.should_show.length) {
    lines.push('should_show : ' + ip.should_show.join(', '));
  }
  if (ip.suppress.length) {
    lines.push('SUPPRESS    : ' + ip.suppress.join(', '));
    lines.push('              → NONE of these may appear in the emitted components.');
  }
  if (ip.defer.length) {
    lines.push('defer       : ' + ip.defer.join(', '));
    lines.push('              → If emitted, mark visibility="collapsed".');
  }
  if (ip.why_must)     lines.push('why_must    : ' + ip.why_must);
  if (ip.why_suppress) lines.push('why_suppress: ' + ip.why_suppress);
  lines.push('');
  return lines.join('\n');
}

// Compact, always-on brief of the project's structured design tokens —
// typography ladder, glass tier scale, radius ladder, 4dp spacing grid,
// touch target minimum. Previously these were gated behind keyword
// triggers in extractConstraints() which meant the AI only saw them
// when the prompt literally said "glass" / "typography". Now they travel
// with EVERY request so the AI can reason about visual hierarchy
// (weight ladder, size progression, glass depth stratification) on any
// scenario. Source: figma-refs/design_rules.json + global_rules.json.
function buildDesignRulesBrief() {
  if (!DESIGN_RULES && !GLOBAL_RULES) return '';
  const lines = [];
  lines.push('==== DESIGN TOKENS (use these scales for hierarchy) ====');

  if (DESIGN_RULES && DESIGN_RULES.typography) {
    const t = DESIGN_RULES.typography;
    const sizes = t.size || {};
    const weights = t.weight || {};
    // Typography ladder — ordered so the AI sees it as a visible hierarchy.
    const ladder = ['hero', 'headline', 'large', 'date', 'heading', 'title', 'body', 'label', 'caption', 'micro']
      .filter(k => sizes[k] != null)
      .map(k => `${k}=${sizes[k]}`)
      .join(', ');
    lines.push(`typography.size  : ${ladder} (use the ladder — 112 hero → 10 micro — for visual weight)`);
    if (Object.keys(weights).length) {
      lines.push(`typography.weight: ${Object.entries(weights).map(([k, v]) => `${k}=${v}`).join(', ')} (700 for all SamsungSharpSans headlines)`);
    }
    if (t.family) {
      lines.push(`typography.family: system=${t.family.system || ''}; clock=${t.family.clock || ''}`);
    }
  }

  if (DESIGN_RULES && DESIGN_RULES.glass) {
    const g = DESIGN_RULES.glass;
    const tiers = Object.entries(g).filter(([k]) => k !== '_usage').map(([k, v]) => {
      const blur = v.blur != null ? v.blur + 'px blur' : '';
      const alpha = (v.bg || '').match(/rgba\([^)]+,(0\.\d+)\)/);
      return `${k}(${blur}${alpha ? ', α=' + alpha[1] : ''})`;
    });
    lines.push(`glass tiers      : ${tiers.join(' / ')} — pick the tier that matches the role (shortcutCircle/widgetPill/nowBar/panel)`);
  }

  if (DESIGN_RULES && DESIGN_RULES.radius) {
    const r = DESIGN_RULES.radius;
    const ladder = ['small', 'card', 'medium', 'widget', 'pill', 'dialog', 'panel', 'container', 'circle']
      .filter(k => r[k] != null)
      .map(k => `${k}=${r[k]}`)
      .join(', ');
    lines.push(`radius           : ${ladder}  (pill for floating bars/CTAs; widget=20 for cards; container=50 for QS tiles)`);
  }

  if (DESIGN_RULES && DESIGN_RULES.spacing) {
    const s = DESIGN_RULES.spacing;
    const ladder = ['xs', 'sm', 'md', 'base', 'lg', 'xl', 'xxl', '3xl', '4xl']
      .filter(k => s[k] != null)
      .map(k => `${k}=${s[k]}`)
      .join(', ');
    lines.push(`spacing          : ${ladder}  (all gaps/paddings snap to these values)`);
  }

  if (GLOBAL_RULES && Array.isArray(GLOBAL_RULES.rules)) {
    const touchRule = GLOBAL_RULES.rules.find(r => r.id === 'touch_target_min');
    const spaceRule = GLOBAL_RULES.rules.find(r => r.id === 'spacing_scale_rule');
    if (touchRule) lines.push(`touch_target_min : ${touchRule.min}dp on both axes (Samsung minimum — enforced)`);
    if (spaceRule) {
      const values = (spaceRule.allowedValues || []).slice(0, 14).join(', ');
      lines.push(`spacing.grid     : [${values}, …] (4dp grid — any gap/padding MUST land on this ladder)`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// R4: describe ONE node of a multi-node flow graph. The classifier decides
// the graph (entry / action / completion / …); the generator uses this brief
// to render content appropriate for THIS moment only. When `flowNode` is
// absent (single-screen path), the generator ignores this block entirely.
//
// node.kind mapping — what content the renderer should produce:
//   entry      : glance / current state / invite to act
//   action     : a decisive choice (button cluster, selection-dialog, cta)
//   confirm    : review surface before committing
//   completion : outcome + handoff / return to ambient
//   detail     : expanded info about an entry item
//   alternate  : side branch (dismiss, cancel, different mode)
//   ambient    : passive reminder / status line only
function buildFlowNodeBrief(node) {
  if (!node || typeof node !== 'object') return '';
  const KIND_GUIDE = {
    entry:
      'entry     — first contact. Show the user CURRENT STATE and invite action.\n' +
      '            Components lean on contextual_summary_card / information_glance_tile /\n' +
      '            ambient_status_line. Do NOT render a confirm/completion view here.',
    action:
      'action    — a DECISIVE moment. The user is choosing. Surface MUST show\n' +
      '            the primary_action_pill (or override_action / coordination_sheet).\n' +
      '            Do not over-summarize; keep context minimal, choice obvious.',
    confirm:
      'confirm   — last-check BEFORE commit. Show what is ABOUT to happen and\n' +
      '            give a confirm/cancel pair. Do not repeat onboarding.',
    completion:
      'completion — outcome AFTER the decisive action. Show success state,\n' +
      '            then a handoff_affordance (continue elsewhere) or return\n' +
      '            to ambient. Do NOT show the action CTA again.',
    detail:
      'detail    — expanded read-only view of one item from the entry screen.\n' +
      '            Focus on content, not actions.',
    alternate:
      'alternate — a SIDE branch (dismiss / cancel / different mode). Keep it\n' +
      '            minimal; this is not the happy path.',
    ambient:
      'ambient   — passive, low-attention reminder. Status line + one summary tile,\n' +
      '            no action pill.'
  };
  const kind = typeof node.kind === 'string' ? node.kind : 'entry';
  const guide = KIND_GUIDE[kind] || KIND_GUIDE.entry;
  const trigger = node.triggered_by
    ? `arrived via "${node.triggered_by}" from the previous node.`
    : 'is the ENTRY point of the flow (no prior node).';

  const lines = [];
  lines.push('==== FLOW NODE BRIEF (you render ONE moment in a flow) ====');
  lines.push(`node id      : ${node.id || 'n1'}`);
  lines.push(`node kind    : ${kind}`);
  lines.push(`node intent  : ${node.intent || '(unspecified)'}`);
  lines.push(`arrival      : this node ${trigger}`);
  lines.push('kind guide   :');
  lines.push('  ' + guide.replace(/\n/g, '\n  '));
  lines.push('');
  lines.push('IMPORTANT:');
  lines.push('- Render ONLY this node. Do NOT cram the entire flow into one screen.');
  lines.push('- Downstream nodes are rendered by sibling generators running in parallel.');
  lines.push('- Do NOT duplicate the action CTA on completion/confirm nodes.');
  lines.push('');
  return lines.join('\n');
}

// Legacy entry point used elsewhere (handleConstraintExtract, variants). Left
// as a thin wrapper so we don't break callers that expect the old signature.
function buildGeneratePrompt(prompt, scenario, mode) {
  const constraints = extractConstraints(prompt, scenario, mode);
  const constraintJSON = formatConstraintsForPrompt(constraints);

  return `You are generating semantic UI plans for Samsung One UI screens.

You are NOT a layout engine. You do NOT decide coordinates, x/y/width/height, or spatial structure.
The frontend owns spatial placement via the surface grammar engine. Your job is to propose
SEMANTIC components with a role, the right surfaceType, and content — nothing else.

=== STRICT RULES ===
- Do NOT return absolute pixel coordinates (no x, y, top, left, width, height, position).
- Do NOT invent "card1 / card2 / box3" unnamed roles. Every component.role MUST come from the enum below.
- Do NOT merge bottom-bar and bottom-navigation — they are DIFFERENT roles.
- Do NOT invent app-bar "intermediate" states. Only "expanded" or "collapsed" are allowed.
- Do NOT return "free layout" or generic vertical stacks.
- Do NOT generate more components than the surface actually needs.

Always determine:
  1. surfaceType (one of ALLOWED_SURFACE_TYPES)
  2. user intent (e.g., "browse messages", "inspect product")
  3. content hierarchy (what's the focus block? what's secondary?)
  4. component roles (one per slot, from ALLOWED_ROLES)
  5. role-specific content (title, list items, tabs, placeholder, etc.)
  6. allowed state values (for expandable-app-bar: expanded|collapsed)

One UI structural principles you MUST respect (the engine enforces them; you propose semantics):
- Viewing area and interaction area are distinct.
- Focus-block hierarchy is used for emphasis, not as a generic container.
- Safe side margins are the engine's job.
- Expandable app bar may rest ONLY in "expanded" or "collapsed".

=== ALLOWED_SURFACE_TYPES ===
lockscreen, first-depth-list, second-depth-detail, tab-root,
dialog-bottom, dialog-center, quick-settings, notification-shade, selection-mode

=== ALLOWED_ROLES ===
status-bar, expandable-app-bar, collapsed-app-bar, selection-app-bar, search-bar,
focus-block, focus-block-group, list, detail-content, notification-list,
bottom-navigation, bottom-bar, bottom-dialog, center-dialog,
lock-time, lock-date, lock-shortcuts, quick-settings-panel, background, scrim

=== DESIGN CONSTRAINTS (tokens only — for content/copy guidance) ===
${constraintJSON}
=== END CONSTRAINTS ===

RESPOND with valid JSON in this exact structure:
{
  "sessionId": "<uuid>",
  "layoutTree": {
    "surfaceType": "<one of ALLOWED_SURFACE_TYPES>",
    "intent": "<short user-intent phrase>",
    "hierarchy": "focus-on-list | focus-on-hero | focus-on-dialog | focus-on-chrome",
    "zones": { "topSystem": true, "viewing": true, "interaction": true, "bottomNavigation": true }
  },
  "renderModel": {
    "surfaceType": "<same as layoutTree.surfaceType>",
    "layout": {
      "surfaceType": "<same>",
      "theme": "${mode}",
      "variant": "one-ui"
    },
    "components": [
      {
        "id": "<semantic id e.g. 'app-bar'>",
        "role": "<one of ALLOWED_ROLES>",
        "state": "expanded | collapsed (only for expandable-app-bar)",
        "text": "<optional primary copy>",
        "content": { "title": "...", "items": [...], "tabs": [...], "placeholder": "..." }
      }
    ]
  },
  "critic": {
    "score": <0-100>,
    "issues": [ { "type": "hierarchy|density|consistency|semantic", "message": "..." } ],
    "suggestions": [ "..." ]
  }
}

CONTENT RULES:
- Use role-specific content fields: list → content.items[{title, secondary}], bottom-navigation → content.tabs[], search-bar → content.placeholder.
- App-bar content: content.title required, content.subtitle optional.
- If the surface is lock/dialog/QS/notification, do NOT add a bottom-navigation or bottom-bar unless the surfaceType explicitly expects it.

APP ICON RULE (only when you must inline an icon reference in content):
Use <img src="app-icons/{filename}.png" …>. NEVER emit letter or emoji placeholders.
Valid filenames: Phone.png, Messages.png, Camera.png, Gallery.png, Settings.png, Internet.png, Contacts.png, Clock.png, Calculator.png, Weather.png, Health.png, Bixby.png, Cloud.png, Radio.png, Reminder.png, Studio.png, VoiceRecorder.png, MyFiles.png, DailyBoard.png, DeviceCare.png, DigitalWellbeing.png, SecureWifi.png, SecureFolder.png, Find.png, Notes.png, Pass.png, SmartThings.png, Store.png, Wallet.png, Wearable.png. If an app has no exact asset, pick the closest match.

Your output is the SEMANTIC layer. The renderer owns spatial placement.`;
}

function buildRefineSystemPrompt() {
  return `
You are refining an existing Samsung One UI semantic UI plan.

You must not redesign the whole layout.
You must not invent a new surface type unless explicitly instructed by the user.
You must not return absolute coordinates.
You must not move structure ownership away from the frontend renderer.

Refinement rules:
- Patch by targetRole, not arbitrary freeform layout
- Allowed patch kinds: content, style, state
- Forbidden style properties: x, y, top, left, right, bottom, width, height, position
- Expandable app bar state can only be "expanded" or "collapsed"
- Bottom bar and bottom navigation must remain distinct roles
- Preserve One UI structure: viewing area, interaction area, focus hierarchy

Return strict JSON only in this shape:
{
  "parsedIssue": {
    "type": "hierarchy",
    "severity": "medium",
    "summary": "Search bar is competing with title"
  },
  "patchPlan": {
    "surfaceType": "first-depth-list",
    "patches": [
      {
        "targetRole": "expandable-app-bar",
        "changes": [
          {
            "kind": "content",
            "field": "title",
            "to": "Messages"
          },
          {
            "kind": "style",
            "property": "emphasis",
            "to": "stronger"
          }
        ]
      }
    ]
  },
  "critic": {
    "score": 90,
    "issues": [],
    "suggestions": []
  }
}
`;
}

function buildRefineUserPrompt(payload) {
  const fallbackSurfaceType =
    (payload.currentRenderModel && payload.currentRenderModel.surfaceType) ||
    (payload.currentLayout && payload.currentLayout.surfaceType) ||
    'first-depth-list';

  return `
Current surfaceType: ${fallbackSurfaceType}

User feedback:
${payload.feedback || ''}

Issue tags:
${JSON.stringify(payload.issueTags || [], null, 2)}

Selected nodes:
${JSON.stringify(payload.selectedNodes || [], null, 2)}

Current layout tree:
${JSON.stringify(payload.currentLayout || {}, null, 2)}

Current render model:
${JSON.stringify(payload.currentRenderModel || {}, null, 2)}

Variant context:
${JSON.stringify(payload.variantContext || {}, null, 2)}

Snapshot summary:
${JSON.stringify(payload.snapshot || {}, null, 2)}

Refinement instructions:
- Keep the same surfaceType unless the user explicitly demands a surface change.
- Prefer targetRole-based patches.
- Patch semantics, emphasis, copy, and allowed state values.
- Do not output spatial coordinates.
`;
}

// Legacy single-string builder (kept for callers that still expect it).
function buildRefinePrompt(mode) {
  const constraints = {
    core: CONSTRAINT_FRAGMENTS.core,
    colors: mode === 'light' ? CONSTRAINT_FRAGMENTS.colors_light : CONSTRAINT_FRAGMENTS.colors_dark,
    rules: CONSTRAINT_FRAGMENTS.rules
  };
  const constraintJSON = formatConstraintsForPrompt(constraints);

  return `You are a Samsung One UI design critic. You propose ROLE-BASED patches, not structural rewrites.

You are NOT allowed to redesign the screen. The surface engine owns layout. You may only
patch existing roles (title copy, placeholder text, emphasis, opacity, app-bar state, etc.).

=== STRICT REFINE RULES ===
- Patches MUST target a role (targetRole), not absolute coordinates.
- You MAY change: content (title/text/placeholder/subtitle), semantic style tokens (emphasis/opacity/tone), and expandable-app-bar state.
- You MUST NOT change: surfaceType, x/y/top/left/width/height/position, transforms, or delete/replace structural roles.
- You MUST NOT convert a bottom-navigation into a bottom-bar (or vice versa).
- You MUST NOT invent an app-bar state other than "expanded" or "collapsed".
- You MUST preserve all other roles untouched.

=== ALLOWED patch.kind values ===
content   — replace text/title/placeholder
style     — semantic tokens only (emphasis=stronger|softer, opacity=0.0–1.0, tone=cool|warm)
state     — only for expandable-app-bar (expanded|collapsed)

=== FORBIDDEN patch properties ===
x, y, top, left, right, bottom, width, height, position, transform, translate*

=== ALLOWED_ROLES for targetRole ===
status-bar, expandable-app-bar, collapsed-app-bar, selection-app-bar, search-bar,
focus-block, focus-block-group, list, detail-content, notification-list,
bottom-navigation, bottom-bar, bottom-dialog, center-dialog,
lock-time, lock-date, lock-shortcuts, quick-settings-panel, background, scrim

=== DESIGN CONSTRAINTS (for validation / copy tone) ===
${constraintJSON}
=== END CONSTRAINTS ===

RESPOND with valid JSON:
{
  "parsedIssue": {
    "type": "hierarchy|density|consistency|readability|semantic",
    "severity": "high|medium|low",
    "summary": "short summary of what's wrong"
  },
  "patchPlan": {
    "surfaceType": "<unchanged surfaceType>",
    "patches": [
      {
        "targetRole": "<role from ALLOWED_ROLES>",
        "changes": [
          { "kind": "content", "field": "title|text|placeholder|subtitle", "to": "<new value>" },
          { "kind": "style",   "property": "emphasis|opacity|tone", "to": "<new value>" },
          { "kind": "state",   "to": "expanded|collapsed" }
        ]
      }
    ]
  },
  "updatedLayoutTree": null,
  "updatedRenderModel": null,
  "critic": {
    "score": <0-100>,
    "issues": [ { "type": "...", "message": "..." } ],
    "suggestions": [ "..." ]
  }
}

If the user's feedback implies a structural change (move this below that, make it a different
screen, etc.), you MUST REFUSE by returning an empty patches[] and a parsedIssue.type of
"semantic" explaining that a refine cannot restructure the surface — a new generate is required.`;
}

// ============================================================================
// Surface Grammar Schema — shared contract between server & frontend
// ----------------------------------------------------------------------------
// Server proposes semantic components. Frontend's surface engine owns spatial
// placement. sanitize* functions are the enforcement boundary.
// ============================================================================

const ALLOWED_ROLES = new Set([
  // Structural (surface chrome + containers)
  'status-bar',
  'expandable-app-bar',
  'collapsed-app-bar',
  'selection-app-bar',
  'search-bar',
  'focus-block',
  'focus-block-group',
  'list',
  'list-item',
  'list-top-bar',
  'detail-content',
  'notification-list',
  'bottom-navigation',
  'bottom-bar',
  'bottom-dialog',
  'center-dialog',
  'app-dock',
  'app-grid',
  'app-icon',
  'paragraph',
  'action-row',
  // Lockscreen atomics — canonical Scene/Lock template names
  // (camelCase) + legacy kebab-case aliases (kept so existing code
  // + AI emissions keep working; they alias in the client-side
  // Pass 1 merge via ROLE_ALIASES in app/agent.js).
  'clock',
  'weatherDate',
  'lockIndicator',
  'shortcutLeft',
  'shortcutRight',
  'gestureBar',
  // Legacy / kebab synonyms:
  'lock-time',            // alias for clock
  'lock-clock',           // alias for clock
  'lock-date',
  'lock-shortcuts',
  'weather-date',         // alias for weatherDate
  'lock-indicator',       // alias for lockIndicator
  'unlock-hint',          // maps to gestureBar in agent merge
  // OneUI 8.5 atomic library — enables AI to pick rich, context-aware
  // components: now-bar for ongoing media/timer/charging, media cards,
  // toggle rows, sliders, etc. Previously the AI couldn't surface any
  // of these because they weren't in its vocabulary.
  'now-bar',
  'media-card',
  'media-half',
  'notif-card',
  'notif-card-ai',
  'toggle-chip',
  'toggle-grid',
  'slider-pill',
  'slider-panel',
  'drag-handle',
  'output-chip',
  'progress-track',
  'control-pill',
  'media-output-row',
  'qs-action-tile',
  'single-toggle',
  'smart-things',
  'selection-dialog',
  'dialog-shell',
  'dialog-site-header',
  'dialog-browser-bar',
  'dialog-icon-grid',
  'quick-settings-panel',
  'background',
  'scrim'
]);

const ALLOWED_SURFACE_TYPES = new Set([
  'lockscreen',
  'first-depth-list',
  'second-depth-detail',
  'tab-root',
  'dialog-bottom',
  'dialog-center',
  'quick-settings',
  'notification-shade',
  'selection-mode'
]);

const ALLOWED_APPBAR_STATES = new Set(['expanded', 'collapsed']);

const ALLOWED_PATCH_KINDS = new Set(['content', 'style', 'state']);

// ═══════════════════════════════════════════════════════════════════════
//  R3-C — SEMANTIC COMPONENT VOCABULARY
//  ---------------------------------------------------------------------
//  AI can emit INTENT-BASED component IDs (what the component IS doing
//  for the user's purpose) instead of — or alongside — raw atomic roles.
//  The resolver below maps each semantic id to an atomic role + a
//  default variant, so downstream renderers stay unchanged. The AI
//  benefits because picking "contextual_summary_card" expresses design
//  INTENT more cleanly than "focus-block kind=secondary", and the
//  designer benefits because the pipelineOutput log shows each
//  semantic → atomic resolution explicitly.
//
//  Each entry's SHAPE:
//    role:    required OneUI atomic role
//    variant: default variant (merged over AI-provided variant)
//    note:    short doc string surfaced in the Hierarchy panel + log
// ═══════════════════════════════════════════════════════════════════════
const SEMANTIC_COMPONENT_VOCAB = {
  // ── Content cards ────────────────────────────────────────────────
  contextual_summary_card: {
    role: 'focus-block',
    variant: { kind: 'secondary' },
    note: 'Consolidated summary of multiple sources in ONE card (context_reconstruction).'
  },
  information_glance_tile: {
    role: 'focus-block',
    variant: { kind: 'secondary' },
    note: 'Small single-source info tile, grid-friendly (weather / calendar / messages glance).'
  },
  focus_protection_overlay: {
    role: 'focus-block',
    variant: { kind: 'secondary' },
    note: 'Ambient content card that respects low attention (focus_protection hero).'
  },

  // ── Continuity / live activity ──────────────────────────────────
  // NOTE: these semantic ids DO NOT hardcode variant.type anymore.
  // Earlier revision set {type:'media'} as a default, which caused the
  // now-bar to render as a MUSIC PLAYER (teal bg, prev/pause/next) on
  // every generation that used the semantic id — even when the prompt
  // was about cooking / workout / navigation. The AI must now set
  // variant.type based on the scenario; the renderer falls back to
  // 'timer' (stopwatch UI) when unset, which is a safer generic default
  // than a music-player UI.
  continuity_bridge_panel: {
    role: 'now-bar',
    variant: {},
    note: 'Active session continuation indicator (flow_continuity primary hero). REQUIRES variant.type: media (music), timer (cooking/workout), charging (battery), navigation (turn-by-turn), delivery (ETA), dual-line (generic 2-line). Pick by scenario — do NOT default to media.'
  },
  ambient_status_line: {
    role: 'now-bar',
    variant: {},
    note: 'Glanceable one-line status pill. REQUIRES variant.type matching what is being reported (media / timer / charging / navigation).'
  },
  progress_trail: {
    role: 'progress-track',
    variant: {},
    note: 'Visible session progress bar; pairs with continuity_bridge_panel.'
  },

  // ── Actions ─────────────────────────────────────────────────────
  primary_action_pill: {
    role: 'single-toggle',
    variant: { kind: 'shortcut', width: 'half' },
    note: 'The ONE main action the user is expected to take.'
  },
  override_action: {
    role: 'action-row',
    variant: { kind: 'override' },
    note: 'Explicit "Not now" / change-behavior escape hatch (governance.override_needed).'
  },

  // ── Coordination ────────────────────────────────────────────────
  coordination_sheet: {
    role: 'selection-dialog',
    variant: { theme: 'dark' },
    note: 'Options + alignment actions for multi_party_coordination.'
  },
  target_picker: {
    role: 'dialog-icon-grid',
    variant: {},
    note: 'Grid of target apps/devices to route to (share sheet, handoff target).'
  },

  // ── Governance annotations ──────────────────────────────────────
  explanation_footer: {
    role: 'paragraph',
    variant: { kind: 'caption' },
    note: '"Why this UI?" justification text (governance.explanation_needed).'
  },
  handoff_affordance: {
    role: 'focus-block',
    variant: { kind: 'secondary', accent: '#3388E9' },
    note: 'Device-to-device transfer invitation (governance.handoff_required).'
  },

  // ── Attention / interruption ────────────────────────────────────
  interruption_banner: {
    role: 'notif-card',
    variant: { urgency: 'high' },
    note: 'Time-sensitive alert demanding attention NOW (not background).'
  },
  notification_summary: {
    role: 'notif-card-ai',
    variant: {},
    note: 'AI-condensed summary of notifications (context_reconstruction).'
  },

  // ── Chrome-ish ──────────────────────────────────────────────────
  intent_header: {
    role: 'expandable-app-bar',
    variant: { state: 'collapsed' },
    note: 'Greeting / contextual heading aware of intent + timeOfDay.'
  },
  scenario_title_bar: {
    role: 'list-top-bar',
    variant: {},
    note: 'Compact title + time/date bar used above scenario content.'
  }
};

// Resolve a single AI-emitted component. If its role is a semantic id,
// rewrite it to the mapped atomic role and merge the default variant.
// Preserves `_semanticId` on the output so the client log can show the
// origin (the Design-tab Hierarchy panel + pipelineOutput need this).
function resolveSemanticComponent(comp) {
  if (!comp || !comp.role) return comp;
  const spec = SEMANTIC_COMPONENT_VOCAB[comp.role];
  if (!spec) return comp;        // not semantic — pass through unchanged
  const mergedVariant = Object.assign({}, spec.variant || {}, comp.variant || {});
  return Object.assign({}, comp, {
    _semanticId: comp.role,
    role: spec.role,
    variant: mergedVariant,
    _semanticNote: spec.note
  });
}

const FORBIDDEN_STYLE_FIELDS = new Set([
  'x', 'y', 'top', 'left', 'right', 'bottom',
  'width', 'height', 'position'
]);

function safeSurfaceType(surfaceType) {
  return ALLOWED_SURFACE_TYPES.has(surfaceType)
    ? surfaceType
    : 'first-depth-list';
}

function sanitizeRenderModel(renderModel) {
  if (!renderModel || typeof renderModel !== 'object') {
    return {
      surfaceType: 'first-depth-list',
      layout: { surfaceType: 'first-depth-list' },
      components: []
    };
  }

  const surfaceType = safeSurfaceType(
    renderModel.surfaceType ||
    (renderModel.layout && renderModel.layout.surfaceType)
  );

  // Roles that only make sense when filled with real content — a
  // focus-block with no title/sub renders the atomic's default
  // placeholder ("Focus block · Important content goes here"), which
  // looks broken on canvas. Drop them rather than let them through.
  const CONTENT_REQUIRED_ROLES = new Set([
    'focus-block', 'focus-block-group', 'paragraph', 'notif-card',
    'notif-card-ai', 'list-item', 'media-card', 'media-half',
    // action-row with no labels used to render literal "Primary" /
    // "Secondary" dummy buttons because the renderer hardcoded those
    // as fallbacks. The renderer is now empty-safe, but we also drop
    // empty action-rows here so they don't occupy layout space at all.
    'action-row'
  ]);
  // Common placeholder strings the AI uses when it's being lazy or
  // treating the screen like a design-system demo. These must be
  // rejected as "meaningful content" even if they're non-empty, or we
  // end up with half the canvas saying "Focus block" / "Title" /
  // "Important content goes here" (the atomic's own default copy
  // echoed back by the LLM).
  const PLACEHOLDER_PATTERNS = [
    /^focus block$/i,
    /^focus block\s*\u00b7\s*/i,
    /^important content goes here$/i,
    /^content goes here$/i,
    /^(generic )?card(\s+content)?$/i,
    /^title$/i,
    /^subtitle$/i,
    /^label$/i,
    /^placeholder$/i,
    /^lorem\s+ipsum/i,
    /^sample\s+(text|content)/i,
    /^(primary|secondary)\s+action$/i,
    /^(primary|secondary)$/i,          // bare "Primary" / "Secondary" dummies
    /^(your|my)\s+(content|text)$/i,
    /^\.\.\.$/,
    /^(todo|tbd|tbc)$/i
  ];
  function _isPlaceholderText(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length < 2) return true;
    return PLACEHOLDER_PATTERNS.some(p => p.test(t));
  }
  function _hasMeaningfulContent(c) {
    const check = (v) => typeof v === 'string' && v.trim().length >= 2 && !_isPlaceholderText(v);
    if (check(c.text)) return true;
    // Content fields live on BOTH channels depending on the atomic's
    // renderer — `focus-block`, `notif-card`, `now-bar`, `selection-
    // dialog`, `media-card` etc. all read from `variant.*`; `app-bar`,
    // `list-item`, `paragraph` read from `content.*`. Earlier revision
    // only scanned `content.*`, which silently dropped every AI
    // component that put its real content into `variant.*` (the
    // "1-2 components appear" symptom).
    const fields = ['title', 'sub', 'subtitle', 'body', 'value', 'label',
                    'description', 'song', 'artist', 'album',
                    'summary', 'text', 'placeholder', 'siteName', 'url'];
    const sources = [
      c.content && typeof c.content === 'object' ? c.content : null,
      c.variant && typeof c.variant === 'object' ? c.variant : null
    ].filter(Boolean);
    for (const src of sources) {
      for (const k of fields) {
        if (check(src[k])) return true;
      }
      // `items` / `options` arrays count if any entry has real text.
      if (Array.isArray(src.items)) {
        for (const it of src.items) {
          if (it && (check(it.title) || check(it.label) || check(it.text))) return true;
        }
      }
      if (Array.isArray(src.options)) {
        for (const opt of src.options) {
          if (typeof opt === 'string' ? check(opt) : (opt && check(opt.title || opt.label))) return true;
        }
      }
      // action-row's actions: each entry is {label, icon?}. At least
      // one real label is required for the row to count as meaningful.
      if (Array.isArray(src.actions)) {
        for (const a of src.actions) {
          if (typeof a === 'string' ? check(a) : (a && check(a.label || a.text))) return true;
        }
      }
      // Legacy 2-button action-row form: variant.primary / variant.secondary.
      // Must be real strings, not the literal "Primary"/"Secondary" dummies.
      if (check(src.primary) || check(src.secondary)) return true;
    }
    return false;
  }

  const rawInput = Array.isArray(renderModel.components) ? renderModel.components : [];
  const afterResolve = rawInput
    .map(c => c && typeof c === 'object' ? resolveSemanticComponent(c) : c);
  const afterAllowlist = afterResolve.filter(c => c && ALLOWED_ROLES.has(c.role));
  const afterContentGate = afterAllowlist.filter(c =>
    !CONTENT_REQUIRED_ROLES.has(c.role) || _hasMeaningfulContent(c));

  // Diagnostic so we can see at a glance why a screen came back sparse.
  const droppedByAllowlist  = afterResolve.length - afterAllowlist.length;
  const droppedByContent    = afterAllowlist.length - afterContentGate.length;
  if (droppedByAllowlist || droppedByContent) {
    const contentDrops = afterAllowlist
      .filter(c => CONTENT_REQUIRED_ROLES.has(c.role) && !_hasMeaningfulContent(c))
      .map(c => c.role).join(', ');
    console.log(`  [sanitize] AI emitted=${rawInput.length} → kept=${afterContentGate.length}` +
      (droppedByAllowlist ? ` · ${droppedByAllowlist} dropped (bad role)` : '') +
      (droppedByContent ? ` · ${droppedByContent} dropped (empty content: ${contentDrops})` : ''));
  }

  // Atomic renderers that read content from `variant.*` (not `content.*`).
  // These are the rich roles whose Figma spec sits on variant properties.
  // For these, we COPY selected content.* fields into variant.* on
  // sanitize, so the AI can keep writing into content.* (which is what
  // the system prompt's Role Contract says is always safe) and the
  // renderer still reads its expected channel.
  //
  // Without this merge, a now-bar emitted by the AI with
  //   content: { title: "Midnight City", artist: "M83", marquee: "..." }
  // would lose all of it — the renderer reads variant.title / variant.song
  // / variant.marquee, finds them undefined, and falls back to the
  // hardcoded Figma placeholder "Never Gonna Give You Up". THIS was the
  // "dummy labels" root cause on lockscreen music / notif / media prompts.
  const VARIANT_DRIVEN_ROLES = new Set([
    'now-bar', 'media-card', 'media-half', 'notif-card', 'notif-card-ai',
    'focus-block', 'focus-block-group', 'selection-dialog',
    'toggle-chip', 'single-toggle', 'slider-panel', 'slider-pill',
    'progress-track', 'smart-things', 'dialog-site-header',
    // Lockscreen canonical chrome — their renderers read variant.*
    // (see surface-layout.js cases for clock / weatherDate /
    // lockIndicator / shortcutLeft / shortcutRight / gestureBar /
    // unlock-hint). Listed in BOTH canonical camelCase (Scene
    // template names) and legacy kebab-case aliases so that content
    // → variant mirroring works regardless of which name the AI or
    // the canned plan emits.
    'clock', 'weatherDate', 'lockIndicator', 'gestureBar',
    'shortcutLeft', 'shortcutRight',
    'lock-clock', 'weather-date', 'lock-indicator', 'unlock-hint',
    'lock-date', 'lock-time', 'lock-shortcuts'
  ]);
  const VARIANT_MIRRORED_FIELDS = [
    'title', 'sub', 'subtitle', 'body', 'value', 'label', 'description',
    'song', 'artist', 'album', 'marquee', 'time', 'percent',
    'summary', 'text', 'accent', 'icon', 'image', 'source',
    'siteName', 'siteDesc', 'url', 'options', 'items',
    'theme', 'showTitle', 'state', 'urgency',
    // Lockscreen chrome reads these: weather-date wants condition/temp/
    // date; lock-indicator wants state; unlock-hint wants text; lock-
    // clock wants time/weight/size.
    'condition', 'temp', 'temperature', 'date', 'weight', 'size',
    'showArrow', 'left', 'right',
    // LAYOUT width hint ("full" | "half") — the dispatcher's mixed
    // packer reads variant.width; mirroring from content.width lets
    // the AI set it in either channel.
    'width'
  ];
  // Field synonyms the AI uses naturally vs. what renderers read.
  // e.g. AI emits `temperature` (natural language) but the weather-date
  // renderer reads `temp` (short). Normalize here so both sides of the
  // contract can stay comfortable.
  const FIELD_SYNONYMS = {
    'temperature': 'temp',
    'subtitle':    'sub'
  };
  function _mergeContentIntoVariant(c) {
    if (!VARIANT_DRIVEN_ROLES.has(c.role)) return c;
    const content = c.content && typeof c.content === 'object' ? c.content : {};
    const variant = c.variant && typeof c.variant === 'object' ? { ...c.variant } : {};
    let changed = false;
    for (const k of VARIANT_MIRRORED_FIELDS) {
      if (variant[k] == null && content[k] != null) {
        variant[k] = content[k];
        changed = true;
      }
      // Mirror synonyms too (content.temperature → variant.temp).
      const syn = FIELD_SYNONYMS[k];
      if (syn && variant[syn] == null && content[k] != null) {
        variant[syn] = content[k];
        changed = true;
      }
    }
    return changed ? { ...c, variant } : c;
  }

  const components = afterContentGate
        .map(_mergeContentIntoVariant)
        .map((c, idx) => ({
          id: c.id || `comp-${idx + 1}`,
          role: c.role,
          type: c.type || null,
          text: c.text || '',
          content: c.content && typeof c.content === 'object' ? c.content : {},
          variant: c.variant && typeof c.variant === 'object' ? c.variant : null,
          visibility: c.visibility === 'collapsed' || c.visibility === 'hidden'
            ? c.visibility : 'visible',
          html: typeof c.html === 'string' ? c.html : '',
          styles: c.styles && typeof c.styles === 'object' ? c.styles : {},
          state:
            c.role === 'expandable-app-bar' && ALLOWED_APPBAR_STATES.has(c.state)
              ? c.state
              : undefined,
          // R3-C: keep the origin semantic id + note when present so the
          // client log + Hierarchy panel can show what the AI asked for
          // (semantic) vs what it became (atomic).
          _semanticId:   c._semanticId   || null,
          _semanticNote: c._semanticNote || null
        }));

  // De-duplicate "collision emissions" — multiple semantic ids
  // resolving to the same (role + variant.type + variant.kind) signature.
  // The canonical case: the AI picks `continuity_bridge_panel`,
  // `ambient_status_line`, AND a raw `now-bar` for a music-playing
  // lockscreen — all three resolve to `now-bar type=media` and render
  // as visible duplicates. We keep the RICHEST (most content keys
  // populated) and drop the others. Does NOT collapse genuine
  // differences (e.g. 3 focus-blocks with different content survive
  // because their titles/sub differ, so the signature differs).
  const seen = new Map();
  const dedupedCollisions = [];
  let collisionDrops = 0;
  components.forEach(function (c) {
    // Signature: role + a couple of structural discriminators. Text
    // content is NOT part of the signature so different focus-blocks
    // with different titles survive.
    const v = c.variant || {};
    const ct = c.content || {};
    const discriminator = [v.type || '', v.kind || '', v.urgency || '']
      .filter(Boolean).join('|');
    // Singleton roles appear AT MOST ONCE per screen — even across
    // different type variants. Earlier revision included `discriminator`
    // in the singleton signature, which let the AI accidentally emit
    // BOTH a `now-bar` (type missing) AND a `now-bar` (type=timer) and
    // have both survive dedup. For now-bar / status-bar / app-bars /
    // app-dock / bottom-nav there is no legitimate scenario where the
    // same screen should render two — signature is just the role.
    const SINGLETON_ROLES = new Set([
      'now-bar', 'lock-clock', 'weather-date', 'lock-indicator',
      'unlock-hint', 'status-bar', 'expandable-app-bar',
      'collapsed-app-bar', 'selection-app-bar', 'list-top-bar',
      'app-dock', 'bottom-navigation', 'bottom-bar'
    ]);
    const sig = SINGLETON_ROLES.has(c.role)
      ? c.role
      : c.role + '|' + discriminator + '|' + (ct.title || '') + '|' + (v.title || '');
    if (seen.has(sig)) {
      // Keep whichever candidate has more populated content fields.
      const prev = seen.get(sig);
      const countKeys = function (x) {
        let n = 0;
        ['title', 'sub', 'subtitle', 'body', 'artist', 'marquee', 'summary'].forEach(function (k) {
          if ((x.content && x.content[k]) || (x.variant && x.variant[k])) n++;
        });
        return n;
      };
      if (countKeys(c) > countKeys(prev)) {
        const idx = dedupedCollisions.indexOf(prev);
        if (idx >= 0) dedupedCollisions[idx] = c;
        seen.set(sig, c);
      }
      collisionDrops++;
      return;
    }
    seen.set(sig, c);
    dedupedCollisions.push(c);
  });
  if (collisionDrops) {
    console.log('  [sanitize] deduped ' + collisionDrops + ' semantic-collision component(s) (same role+variant)');
  }

  return {
    surfaceType,
    layout: {
      ...(renderModel.layout || {}),
      surfaceType
    },
    components: dedupedCollisions
  };
}

function sanitizePatchPlan(patchPlan, fallbackSurfaceType = 'first-depth-list') {
  if (!patchPlan || typeof patchPlan !== 'object') {
    return {
      surfaceType: safeSurfaceType(fallbackSurfaceType),
      patches: []
    };
  }

  const surfaceType = safeSurfaceType(
    patchPlan.surfaceType || fallbackSurfaceType
  );

  const patches = Array.isArray(patchPlan.patches)
    ? patchPlan.patches.map((patch) => {
        const targetRole = ALLOWED_ROLES.has(patch.targetRole)
          ? patch.targetRole
          : null;

        const changes = Array.isArray(patch.changes)
          ? patch.changes.filter(ch => {
              if (!ch || !ALLOWED_PATCH_KINDS.has(ch.kind)) return false;
              if (ch.kind === 'style' && FORBIDDEN_STYLE_FIELDS.has(ch.property)) return false;
              if (ch.kind === 'state' && ch.to && !ALLOWED_APPBAR_STATES.has(ch.to)) return false;
              return true;
            }).map(ch => ({
              kind: ch.kind,
              field: ch.field || null,
              property: ch.property || null,
              to: ch.to
            }))
          : [];

        return {
          targetRole,
          changes
        };
      }).filter(p => p.targetRole && p.changes.length > 0)
    : [];

  return {
    surfaceType,
    patches
  };
}

// R2 information-priority enforcement. The classifier produced a
// contract of must_show / should_show / suppress / defer CONCEPTS.
// The generator LLM received this contract in its prompt but LLMs
// leak — sometimes they emit a suppressed role anyway. This function
// is the backstop: after sanitization, drop any component whose role
// matches a suppress concept, and mark any component whose role
// matches a defer concept with visibility="collapsed".
function enforceInformationPriority(renderModel, ip) {
  if (!renderModel || !Array.isArray(renderModel.components)) {
    return { renderModel, suppressed: [], deferred: [] };
  }
  if (!ip) return { renderModel, suppressed: [], deferred: [] };

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const suppressSet = new Set((ip.suppress || []).map(norm));
  const deferSet    = new Set((ip.defer    || []).map(norm));

  // Role ↔ semantic-concept aliases. Classifier emits "app_grid",
  // "promo_banner", "dense_list" etc. — these are concepts, not our
  // internal role names. Map each role to the concepts it fulfills
  // so matching is reliable in both directions.
  const ROLE_CONCEPTS = {
    'app-grid':           ['app_grid', 'grid', 'app_icons', 'launcher_grid'],
    'app-icon':           ['app_grid', 'app_icon', 'grid'],
    'app-dock':           ['app_dock', 'dock'],
    'notif-card':         ['notification_noise', 'unread_badges', 'notifications'],
    'notif-card-ai':      ['notification_noise', 'unread_badges', 'notifications'],
    'list':               ['dense_list', 'raw_list', 'raw_source_list'],
    'notification-list':  ['notification_noise', 'notifications'],
    'focus-block-group':  ['dense_widget_row', 'widget_grid', 'widget_row'],
    'toggle-grid':        ['dense_toggles', 'toggle_grid'],
    'smart-things':       ['iot_controls', 'smart_home'],
    'media-card':         ['full_media_controls', 'playlist_detail', 'media_detail'],
    'selection-dialog':   ['menu_list', 'option_picker'],
    'search-bar':         ['search'],
    'expandable-app-bar': ['app_bar_expanded'],
    'list-top-bar':       ['list_header'],
    'bottom-navigation':  ['bottom_nav', 'navigation_chrome'],
    'bottom-bar':         ['bottom_bar']
  };

  const roleMatchesSet = (role, set) => {
    if (!role) return false;
    if (set.has(norm(role))) return true;
    const aliases = ROLE_CONCEPTS[role] || [];
    return aliases.some(a => set.has(a));
  };

  const kept = [];
  const suppressed = [];
  const deferred = [];
  renderModel.components.forEach(c => {
    if (roleMatchesSet(c.role, suppressSet)) {
      suppressed.push({ id: c.id, role: c.role });
      return;                         // drop
    }
    if (roleMatchesSet(c.role, deferSet)) {
      c.visibility = 'collapsed';
      deferred.push({ id: c.id, role: c.role });
    }
    kept.push(c);
  });
  renderModel.components = kept;
  return { renderModel, suppressed, deferred };
}

function coerceGenerateResponse(modelJson, requestedSurfaceType) {
  modelJson = modelJson || {};
  const renderModel = sanitizeRenderModel({
    ...(modelJson.renderModel || {}),
    surfaceType:
      (modelJson.renderModel && modelJson.renderModel.surfaceType) ||
      (modelJson.layoutTree && modelJson.layoutTree.surfaceType) ||
      requestedSurfaceType
  });

  // If sanitize stripped everything (model violated the role contract), drop
  // to a minimal valid surface template instead of returning an empty frame.
  if (!renderModel.components.length) {
    return fallbackGenerateResponse(renderModel.surfaceType);
  }

  return {
    sessionId: modelJson.sessionId || `sess_${Date.now()}`,
    layoutTree: {
      ...(modelJson.layoutTree || {}),
      surfaceType: renderModel.surfaceType,
      intent: (modelJson.layoutTree && modelJson.layoutTree.intent) || 'generated',
      hierarchy: (modelJson.layoutTree && modelJson.layoutTree.hierarchy) || 'default'
    },
    renderModel,
    critic: _normalizeCritic(modelJson.critic)
  };
}

// The AI sometimes returns `critic.issues` as plain strings and
// sometimes as `{ type, message }` objects. Same for suggestions.
// The renderer expects the object shape, so anything that arrives as a
// string becomes `{ type: 'critique', message: <string> }`. Without
// this normalization the critic panel renders literal "undefined
// undefined" text for each flagged issue.
function _normalizeCritic(raw) {
  const score = (raw && typeof raw.score === 'number') ? raw.score : 80;
  const rawIssues = Array.isArray(raw && raw.issues) ? raw.issues : [];
  const rawSuggs  = Array.isArray(raw && raw.suggestions) ? raw.suggestions : [];
  const issues = rawIssues.map(function (i) {
    if (typeof i === 'string') return { type: 'critique', message: i };
    if (!i || typeof i !== 'object') return { type: 'critique', message: String(i || '') };
    return {
      type:    i.type    || 'critique',
      message: i.message || i.text || (typeof i === 'string' ? i : JSON.stringify(i))
    };
  });
  const suggestions = rawSuggs.map(function (s) {
    return typeof s === 'string' ? s : (s && (s.message || s.text)) || String(s || '');
  });
  return { score, issues, suggestions };
}

function coerceRefineResponse(modelJson, fallbackSurfaceType) {
  modelJson = modelJson || {};
  const patchPlan = sanitizePatchPlan(modelJson.patchPlan, fallbackSurfaceType);

  return {
    parsedIssue: {
      type: (modelJson.parsedIssue && modelJson.parsedIssue.type) || 'refinement',
      severity: (modelJson.parsedIssue && modelJson.parsedIssue.severity) || 'medium',
      summary: (modelJson.parsedIssue && modelJson.parsedIssue.summary) || ''
    },
    patchPlan,
    critic: {
      score: (modelJson.critic && modelJson.critic.score != null) ? modelJson.critic.score : 85,
      issues: Array.isArray(modelJson.critic && modelJson.critic.issues) ? modelJson.critic.issues : [],
      suggestions: Array.isArray(modelJson.critic && modelJson.critic.suggestions) ? modelJson.critic.suggestions : []
    }
  };
}

function fallbackGenerateResponse(surfaceType = 'first-depth-list') {
  const st = safeSurfaceType(surfaceType);
  return {
    sessionId: `sess_${Date.now()}`,
    layoutTree: {
      surfaceType: st,
      intent: 'fallback',
      hierarchy: 'default'
    },
    renderModel: {
      surfaceType: st,
      layout: {
        surfaceType: st,
        theme: 'dark',
        variant: 'one-ui'
      },
      components: [
        { id: 'status-bar', role: 'status-bar' },
        { id: 'app-bar', role: 'expandable-app-bar', state: 'expanded', text: 'Title' },
        { id: 'list', role: 'list' },
        { id: 'bottom-nav', role: 'bottom-navigation' }
      ]
    },
    critic: {
      score: 70,
      issues: [{ type: 'fallback', message: 'Model response was sanitized or defaulted' }],
      suggestions: []
    }
  };
}

// ============================================================================
// Route handlers
// ============================================================================

// Step 1 of 2 — cheap classifier LLM call that picks surfaceType + intent
// from the user prompt. Returns a safe default on any failure, so the main
// generate step can always proceed.
// ============================================================================
//  4+2+1 ORCHESTRATION CLASSIFIER
//  -------------------------------------------------------------------------
//  Replaces the simple surfaceType-only classifier. Returns both:
//    (a) Backward-compat fields — surfaceType, intent, hierarchy, timeOfDay,
//        activity — so existing renderFromModel / surfaceType-driven code
//        keeps working untouched.
//    (b) `orchestration` object — the 4+2+1 decision structure:
//          purpose       : 4 Purpose Types (primary + optional secondary + why)
//          modulationA   : body + environment state that modulates UI density
//          modulationB   : multi-device / handoff state
//          governance    : explanation / autonomy / override triggers
//  The generator step downstream reads (b) to reason about must_show /
//  suppress / continuity BEFORE proposing components. The pipelineOutput
//  client renders (b) as a structured block so every generation explains
//  itself in the log.
// ============================================================================
async function classifyIntent(userPrompt) {
  if (!userPrompt || userPrompt.trim().length < 3) {
    return {
      surfaceType: 'first-depth-list',
      intent: 'default',
      confidence: 0,
      orchestration: null
    };
  }

  const systemPrompt = `
You are the ORCHESTRATION CLASSIFIER for a state-based generative UI system
for Samsung One UI 8.5. You do NOT design screens. You analyze the user's
scenario into a FOUR-PART decision packet that a downstream component
selector uses to reason about what should be shown, suppressed, deferred,
or handed off:

  (1) 4+2+1 classification        — purpose type, modulations, governance
  (2) interpretation layer        — 6 questions about the user's situation
  (3) state packet                — compressed machine-readable decision state
  (4) information priority        — must_show / should_show / suppress / defer

Return STRICT JSON with the following shape:

{
  "surfaceType": "lockscreen | first-depth-list | second-depth-detail | tab-root | dialog-bottom | dialog-center | quick-settings | notification-shade | selection-mode",
  "intent":     "<3-7 word specific phrase derived from prompt>",
  "hierarchy":  "focus-on-list | focus-on-hero | focus-on-dialog | focus-on-chrome",
  "timeOfDay":  "morning | afternoon | evening | night | null",
  "activity":   "<short phrase or null>",

  "orchestration": {
    "purpose": {
      "primary":   "context_reconstruction | flow_continuity | focus_protection | multi_party_coordination",
      "secondary": "<same enum or null>",
      "reasoning": "<one sentence: why this purpose type>"
    },
    "modulationA_body_env": {
      "attention":         "glanceable | focused | distracted",
      "mobility":          "stationary | walking | driving | transit",
      "hands":             "both | one | none | null",
      "interaction":       "touch | voice | mixed | minimal-touch",
      "privacy":           "public | private | mixed | null",
      "time_of_day":       "morning | afternoon | evening | night | null",
      "ambient":           "<short free-form phrase like 'dim night private' or null>"
    },
    "modulationB_multi_device": {
      "device_count":      "single | multi",
      "primary_device":    "phone | tablet | watch | tv | desktop | null",
      "secondary_devices": ["<device>", ...],
      "handoff_required":  true | false,
      "handoff_target":    "<device name or null>",
      "surface_allocation_hint": "<short phrase or null>"
    },
    "governance": {
      "triggers":            [ "high_impact_decision" | "biometric" | "high_autonomy" | "explanation_gap" | "trust_risk" | "social_conflict" ],
      "autonomy_level":      "advise | execute_with_confirm | execute",
      "explanation_needed":  true | false,
      "override_needed":     true | false
    }
  },

  "interpretation": {
    "what_user_doing":        "<one sentence — what is the user literally doing right now>",
    "real_goal":              "<one sentence — what is the REAL underlying goal>",
    "most_lacking":           "time | info | confidence | coordination",
    "what_interferes":        "<one sentence — what is blocking the user>",
    "system_role":            ["show", "reduce", "connect", "decide"],
    "interaction_complexity": "low | medium | high"
  },

  "statePacket": {
    "purpose_type":        "<same enum as orchestration.purpose.primary>",
    "primary_goal":        "<short phrase — the main task to accomplish>",
    "journey_stage":       "entry | active | transition | completion | ambient",
    "urgency":             "low | medium | high",
    "attention_capacity":  "low | medium | high",
    "interaction_budget":  "minimal | normal | rich",
    "coordination_need":   "none | low | medium | high",
    "device_role":         "primary-single | primary-multi | secondary | auxiliary",
    "system_role":         "show | reduce | connect | decide",
    "autonomy_level":      "advise | execute_with_confirm | execute",
    "explanation_needed":  true | false,
    "override_needed":     true | false,
    "privacy_level":       "public | private | mixed | null",
    "handoff_required":    true | false
  },

  "informationPriority": {
    "must_show":   ["<semantic concept — what ABSOLUTELY must appear>", ...],
    "should_show": ["<concept — nice to have>", ...],
    "suppress":    ["<concept — must NOT appear in this context>", ...],
    "defer":       ["<concept — collapse / show on demand, not now>", ...],
    "why_suppress": "<one sentence explaining the core suppressions>",
    "why_must":     "<one sentence explaining the core must_show choices>"
  },

  "flowPlan": {
    "nodes": [
      {
        "id":            "<short id like 'n1'>",
        "kind":          "entry | action | confirm | completion | detail | alternate | ambient",
        "intent":        "<one-sentence purpose of THIS node only>",
        "triggered_by":  "<semantic id or atomic role of the component whose tap arrived at this node, or null for the entry node>"
      }
    ],
    "edges": [
      {
        "from":    "<node id>",
        "trigger": "<semantic id or role of the component that, when tapped on 'from', advances to 'to'>",
        "to":      "<node id>"
      }
    ]
  }
}

== 4 PURPOSE TYPES (pick exactly one as primary) ==
- context_reconstruction (맥락 재구성형)
    흩어진 정보, 기능, 신호를 사용자 목적 중심으로 한 화면/한 흐름으로 재편.
    Signals: "morning brief", "at a glance", "summary", "today's status",
             consolidating multiple data sources into one view.

- flow_continuity (흐름 연속형)
    Intent가 시간/surface/디바이스/상태를 넘어도 끊기지 않도록 이어줌.
    Signals: "continue", "pick up where I left", "handoff", "resume on
             another device", navigating step-to-step in a task.

- focus_protection (몰입 보호형)
    방해를 줄이고 지금 필요한 것만 남기며 나머지는 suppress / defer / collapse.
    Signals: "night", "driving", "do not disturb", "ambient", "minimal",
             "while working", "glanceable", "while doing X".

- multi_party_coordination (다자간 조율형)
    여러 사람 / 여러 목표 / 여러 기기 / 여러 제약의 충돌을 조정하고 정렬.
    Signals: "with my team", "shared", "two people need", "family",
             "meeting", "everyone", "schedule together", conflict
             between parties or intents.

== 2 MODULATION LAYERS (how the purpose is modulated by context) ==
A. Body / Environment
   Directly affects attention_capacity, interaction_budget, complexity
   allowance. Extract EVERY field that the prompt provides.
   If the prompt doesn't mention it, INFER the most likely default
   (e.g. no mention of driving → mobility = stationary).

B. Multi-device
   Affects continuity_path, surface_allocation, handoff_design. If the
   prompt mentions only one device, set device_count = single and
   handoff_required = false.

== 1 GOVERNANCE LAYER ==
Check if the scenario triggers any of:
- high_impact_decision : financial / health / legal / safety
- biometric            : uses or implies fingerprint / face / voice ID
- high_autonomy        : system would act without explicit confirm
- explanation_gap      : user may not understand why the UI appeared
- trust_risk           : wrong action degrades trust or breaks a relationship
- social_conflict      : multi-party coordination with competing goals
If NONE apply, triggers = [].
autonomy_level: default "advise" unless scenario clearly says system
should act.

== INTERPRETATION LAYER ==
Before committing to a state packet, answer these 6 questions honestly.
Keep each answer to ONE sentence. They shape the rest of the packet:

- what_user_doing         : literal description of the moment
- real_goal               : the underlying intent (often different from the literal action)
- most_lacking            : what is the user SHORT on right now — time / info / confidence / coordination
- what_interferes         : what's in the way (attention, noise, device, other people, ambiguity)
- system_role             : one or more of show / reduce / connect / decide
   show    = surface what exists and is relevant
   reduce  = strip noise, keep only what's necessary
   connect = bridge states, surfaces, or people
   decide  = take action on behalf of the user
- interaction_complexity  : how much interaction the user can handle right now

== STATE PACKET ==
A compressed, machine-readable representation of your interpretation.
This is what downstream code reads to make decisions. Keep it tight —
every field should directly drive a UI decision. Align the values with
the interpretation layer (system_role, primary_goal, etc. should not
contradict what you said there).

== INFORMATION PRIORITY (CRITICAL) ==
This is the heart of the packet. Before any components are proposed,
sort the candidate content concepts into 4 buckets:

- must_show   : user cannot accomplish their real_goal without this
- should_show : helps, but not strictly required
- suppress    : would actively harm the user's state (noise, distraction,
                privacy leak, cognitive load). MUST NOT appear.
- defer       : relevant but belongs to a later moment (collapse /
                behind gesture / next screen)

Rules:
- focus_protection          → must_show SHORT (1-2 concepts). Large
                              suppress list (app-grid, promotional,
                              dense lists, badges, non-critical chrome).
- context_reconstruction    → must_show centers on the UNIFIED CONCLUSION
                              (summary cards), suppress raw per-source
                              lists that are covered by the summary.
- flow_continuity           → must_show includes continuity-critical
                              state (current step, next step, session
                              identifier). Suppress anything that breaks
                              the thread.
- multi_party_coordination  → must_show includes conflict visibility +
                              alignment actions. Suppress personal
                              preference UI until coordination resolves.

Use SEMANTIC CONCEPTS here, not role names. Examples of good entries:
  must_show:  ["current_playback_status", "weather_glance", "conflict_summary"]
  suppress:   ["app_grid", "promo_banner", "unread_badges", "raw_source_list"]
  defer:      ["message_history", "full_calendar", "detailed_stats"]

== FLOW PLAN (temporal UI — single node vs multi-node flow) ==

This project generates TEMPORAL UI, not just single static screens.
For each scenario, decide whether the orchestration lives in ONE
moment or across a SEQUENCE of moments (entry → action → completion,
glance → detail, ambient → interrupt → ambient, etc.).

Rules for nodes count:

  1 node   — static glance / ambient / single screen that doesn't
             naturally advance.
             Examples: "Home at night with music playing"  (ambient),
                       "Morning brief at a glance"         (glance).
             → flowPlan.nodes = [{id:"n1", kind:"entry", ...}]
                flowPlan.edges = []

  2 nodes  — single decisive action arrives at a result.
             Examples: "Pick a browser to share this"  (pick → shared),
                       "Confirm purchase"              (confirm → done).
             → n1 kind=entry, n2 kind=confirm|completion
                edge: n1 --primary_action_pill.tap--> n2

  3 nodes  — session with a clear transition moment.
             Examples: "Continue workout from watch to phone"
                       (active → handoff → full view),
                       "Reply to message, then return to feed"
                       (feed → compose → sent).
             → n1=entry, n2=action|transition, n3=completion|ambient
                edges: n1 → n2 (tap primary), n2 → n3 (confirm)

Rules for each node:
  - id       : short unique string ("n1", "n2", "n3").
  - kind     : MUST be one of entry | action | confirm | completion |
               detail | alternate | ambient.
  - intent   : one-sentence purpose for THIS node only — WHAT this
               moment accomplishes, distinct from the overall scenario.
  - triggered_by : the semantic id / role of the component whose tap
               brought the user here. null for the entry node.

Rules for each edge:
  - from     : source node id.
  - trigger  : the semantic id / role of the component on the 'from'
               node that, when tapped, advances to 'to'.
               Use primary_action_pill / override_action / target_picker
               / coordination_sheet etc. — whatever the generator will
               actually render.
  - to       : target node id.

If in doubt, prefer FEWER nodes (1 > 2 > 3). Multi-node is for scenarios
that genuinely have distinct moments — don't invent a flow just to be
fancy.

== STRICT RULES ==
- Always return ALL top-level fields (orchestration, interpretation,
  statePacket, informationPriority).
- Never invent enum values outside the allowed sets above.
- If a field is unknowable from the prompt, use null.
- Purpose primary MUST be one of the 4 types.
- The state packet must not contradict the interpretation layer.
- informationPriority MUST reflect the purpose type's policy (see rules above).
- Return JSON only, no prose before or after.

EXAMPLE — "Samsung Galaxy Home at night with music playing"
{
  "surfaceType": "tab-root",
  "intent": "evening ambient home with playback",
  "orchestration": { ... purpose.primary = focus_protection ... },
  "interpretation": {
    "what_user_doing":        "checking phone briefly while music plays in the background at night",
    "real_goal":              "confirm playback is going fine without disrupting the ambient mood",
    "most_lacking":           "confidence",
    "what_interferes":        "low attention, dim light, not actively focused on the screen",
    "system_role":            ["reduce", "show"],
    "interaction_complexity": "low"
  },
  "statePacket": {
    "purpose_type":        "focus_protection",
    "primary_goal":        "glanceable_playback_status",
    "journey_stage":       "ambient",
    "urgency":             "low",
    "attention_capacity":  "low",
    "interaction_budget":  "minimal",
    "coordination_need":   "none",
    "device_role":         "primary-single",
    "system_role":         "reduce",
    "autonomy_level":      "advise",
    "explanation_needed":  false,
    "override_needed":     false,
    "privacy_level":       "private",
    "handoff_required":    false
  },
  "informationPriority": {
    "must_show":   ["current_playback_status", "time"],
    "should_show": ["next_track_hint"],
    "suppress":    ["app_grid", "promo_banner", "unread_badges", "dense_widget_row"],
    "defer":       ["full_media_controls", "playlist_detail"],
    "why_must":    "user needs playback confirmation at a glance — time stays as chrome",
    "why_suppress":"night ambient + low attention forbids dense grids and notification noise"
  }
}`;

  try {
    const result = await callOpenAI(systemPrompt, userPrompt.slice(0, 800), 0.1);
    const allowed = ALLOWED_SURFACE_TYPES;
    const surfaceType = (result && allowed.has(result.surfaceType))
      ? result.surfaceType
      : 'first-depth-list';

    // Normalize orchestration payload (defensive — LLM may omit or partial)
    const orch = (result && result.orchestration) || {};
    const ALLOWED_PURPOSE = new Set([
      'context_reconstruction', 'flow_continuity',
      'focus_protection', 'multi_party_coordination'
    ]);
    const purpose = orch.purpose || {};
    const modA    = orch.modulationA_body_env || {};
    const modB    = orch.modulationB_multi_device || {};
    const gov     = orch.governance || {};
    const normalizedOrch = {
      purpose: {
        primary:   ALLOWED_PURPOSE.has(purpose.primary) ? purpose.primary : 'context_reconstruction',
        secondary: ALLOWED_PURPOSE.has(purpose.secondary) ? purpose.secondary : null,
        reasoning: purpose.reasoning || ''
      },
      modulationA: {
        attention:    modA.attention    || 'focused',
        mobility:     modA.mobility     || 'stationary',
        hands:        modA.hands        || null,
        interaction:  modA.interaction  || 'touch',
        privacy:      modA.privacy      || null,
        time_of_day:  modA.time_of_day  || (result && result.timeOfDay) || null,
        ambient:      modA.ambient      || null
      },
      modulationB: {
        device_count:      (modB.device_count === 'multi') ? 'multi' : 'single',
        primary_device:    modB.primary_device    || 'phone',
        secondary_devices: Array.isArray(modB.secondary_devices) ? modB.secondary_devices : [],
        handoff_required:  !!modB.handoff_required,
        handoff_target:    modB.handoff_target    || null,
        surface_allocation_hint: modB.surface_allocation_hint || null
      },
      governance: {
        triggers:            Array.isArray(gov.triggers) ? gov.triggers : [],
        autonomy_level:      gov.autonomy_level || 'advise',
        explanation_needed:  !!gov.explanation_needed,
        override_needed:     !!gov.override_needed
      }
    };

    // ─── R2: normalize interpretation + state packet + information priority ───
    const interp = (result && result.interpretation) || {};
    const ALLOWED_SYSROLE = new Set(['show', 'reduce', 'connect', 'decide']);
    const sysRoleArr = Array.isArray(interp.system_role) ? interp.system_role : [];
    const normalizedInterpretation = {
      what_user_doing:        interp.what_user_doing        || '',
      real_goal:              interp.real_goal              || '',
      most_lacking:           ['time','info','confidence','coordination'].includes(interp.most_lacking)
                                ? interp.most_lacking : 'info',
      what_interferes:        interp.what_interferes        || '',
      system_role:            sysRoleArr.filter(r => ALLOWED_SYSROLE.has(r)),
      interaction_complexity: ['low','medium','high'].includes(interp.interaction_complexity)
                                ? interp.interaction_complexity : 'medium'
    };

    const sp = (result && result.statePacket) || {};
    const normalizedStatePacket = {
      purpose_type:        ALLOWED_PURPOSE.has(sp.purpose_type) ? sp.purpose_type : normalizedOrch.purpose.primary,
      primary_goal:        sp.primary_goal        || '',
      journey_stage:       ['entry','active','transition','completion','ambient'].includes(sp.journey_stage)
                             ? sp.journey_stage : 'active',
      urgency:             ['low','medium','high'].includes(sp.urgency) ? sp.urgency : 'low',
      attention_capacity:  ['low','medium','high'].includes(sp.attention_capacity)
                             ? sp.attention_capacity : 'medium',
      interaction_budget:  ['minimal','normal','rich'].includes(sp.interaction_budget)
                             ? sp.interaction_budget : 'normal',
      coordination_need:   ['none','low','medium','high'].includes(sp.coordination_need)
                             ? sp.coordination_need : 'none',
      device_role:         sp.device_role   || 'primary-single',
      system_role:         ALLOWED_SYSROLE.has(sp.system_role) ? sp.system_role : 'show',
      autonomy_level:      sp.autonomy_level  || normalizedOrch.governance.autonomy_level,
      explanation_needed:  !!sp.explanation_needed,
      override_needed:     !!sp.override_needed,
      privacy_level:       sp.privacy_level   || normalizedOrch.modulationA.privacy,
      handoff_required:    !!sp.handoff_required
    };

    const ip = (result && result.informationPriority) || {};
    const asStrArray = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim().length > 0) : []);
    const normalizedInformationPriority = {
      must_show:    asStrArray(ip.must_show),
      should_show:  asStrArray(ip.should_show),
      suppress:     asStrArray(ip.suppress),
      defer:        asStrArray(ip.defer),
      why_must:     ip.why_must     || '',
      why_suppress: ip.why_suppress || ''
    };

    // ─── R4: normalize flowPlan (1–3 nodes + edges) ─────────────────────
    const ALLOWED_NODE_KINDS = new Set([
      'entry', 'action', 'confirm', 'completion',
      'detail', 'alternate', 'ambient'
    ]);
    const fpRaw = (result && result.flowPlan) || {};
    let fpNodes = Array.isArray(fpRaw.nodes) ? fpRaw.nodes : [];
    let fpEdges = Array.isArray(fpRaw.edges) ? fpRaw.edges : [];

    // Cap to 3 nodes max (reject absurd flows the LLM might invent).
    if (fpNodes.length > 3) fpNodes = fpNodes.slice(0, 3);

    // Every valid flow must have at least one 'entry' node — if the LLM
    // gave us 0 or malformed nodes, fall back to a single-node flow so
    // the downstream parallel generator still works uniformly.
    if (!fpNodes.length) {
      fpNodes = [{
        id: 'n1', kind: 'entry',
        intent: (result && result.intent) || 'generated',
        triggered_by: null
      }];
      fpEdges = [];
    }

    const seenIds = new Set();
    const normalizedNodes = fpNodes.map((n, i) => {
      let id = (n && typeof n.id === 'string' && n.id.trim()) || ('n' + (i + 1));
      while (seenIds.has(id)) id += '_' + (i + 1);
      seenIds.add(id);
      const kind = ALLOWED_NODE_KINDS.has(n && n.kind) ? n.kind : (i === 0 ? 'entry' : 'action');
      return {
        id: id,
        kind: kind,
        intent: (n && n.intent) || (i === 0 ? 'Initial view' : 'Next moment'),
        triggered_by: (n && n.triggered_by) || (i === 0 ? null : 'primary_action_pill')
      };
    });

    const idSet = new Set(normalizedNodes.map(n => n.id));
    const normalizedEdges = fpEdges
      .filter(e => e && idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to)
      .map(e => ({
        from:    e.from,
        trigger: (typeof e.trigger === 'string' && e.trigger.trim()) ? e.trigger : 'primary_action_pill',
        to:      e.to
      }));

    const normalizedFlowPlan = {
      nodes: normalizedNodes,
      edges: normalizedEdges
    };

    return {
      surfaceType: surfaceType,
      intent: (result && result.intent) || 'generated',
      hierarchy: (result && result.hierarchy) || 'focus-on-list',
      timeOfDay: (result && result.timeOfDay) || normalizedOrch.modulationA.time_of_day,
      activity:  (result && result.activity)  || null,
      confidence: result && result.surfaceType ? 1 : 0,
      orchestration:        normalizedOrch,
      interpretation:       normalizedInterpretation,
      statePacket:          normalizedStatePacket,
      informationPriority:  normalizedInformationPriority,
      flowPlan:             normalizedFlowPlan
    };
  } catch (err) {
    console.warn('  [classify] failed:', err.message, '— falling back to client guess');
    return null;
  }
}

async function handleGenerate(body, res) {
  try {
    const clientGuess = safeSurfaceType(body.surfaceType || 'first-depth-list');

    // ── Step 1: Intent classification (4+2+1 + interpretation + state
    //                                   packet + information priority) ──
    let requestedSurfaceType = clientGuess;
    let intent = null;
    let timeOfDay = null;
    let activity = null;
    let orchestration = null;
    let interpretation = null;
    let statePacket = null;
    let informationPriority = null;
    if (body.prompt && body.prompt.trim().length >= 6) {
      const classification = await classifyIntent(body.prompt);
      if (classification && classification.surfaceType) {
        if (classification.surfaceType !== clientGuess) {
          console.log(`  [classify] client="${clientGuess}" → llm="${classification.surfaceType}" (intent: ${classification.intent})`);
        } else {
          console.log(`  [classify] confirmed "${classification.surfaceType}"`);
        }
        if (classification.orchestration) {
          console.log(`  [4+2+1] purpose=${classification.orchestration.purpose.primary}` +
            (classification.orchestration.purpose.secondary ? ` / ${classification.orchestration.purpose.secondary}` : '') +
            ` · attn=${classification.orchestration.modulationA.attention}` +
            ` · devices=${classification.orchestration.modulationB.device_count}` +
            ` · gov_triggers=${classification.orchestration.governance.triggers.length}`);
        }
        if (classification.informationPriority) {
          const ip = classification.informationPriority;
          console.log(`  [priority] must=${ip.must_show.length}, should=${ip.should_show.length}, suppress=${ip.suppress.length}, defer=${ip.defer.length}`);
        }
        requestedSurfaceType = classification.surfaceType;
        intent = classification.intent;
        timeOfDay = classification.timeOfDay;
        activity  = classification.activity;
        orchestration       = classification.orchestration      || null;
        interpretation      = classification.interpretation     || null;
        statePacket         = classification.statePacket        || null;
        informationPriority = classification.informationPriority || null;
      }
    }

    // ── Step 2: Generate the screen with the classified surfaceType ──
    const systemPrompt = buildGenerateSystemPrompt();
    const userPrompt = buildGenerateUserPrompt({
      ...body,
      surfaceType: requestedSurfaceType,
      intent: intent,
      timeOfDay: timeOfDay,
      activity:  activity,
      orchestration: orchestration,
      interpretation: interpretation,
      statePacket: statePacket,
      informationPriority: informationPriority
    });

    const promptSize = ((systemPrompt.length + userPrompt.length) / 1024).toFixed(1);
    console.log(`  [surface-grammar] ${promptSize}KB prompt (surfaceType: ${requestedSurfaceType})`);

    const modelJson = await callOpenAI(systemPrompt, userPrompt, 0.6);

    const beforeCount = Array.isArray(modelJson.renderModel && modelJson.renderModel.components)
      ? modelJson.renderModel.components.length : 0;

    // coerce handles sanitize + empty→fallback internally
    const response = coerceGenerateResponse(modelJson, requestedSurfaceType);

    const afterCount = response.renderModel.components.length;
    if (beforeCount !== afterCount) {
      console.log(`  [sanitize:generate] ${beforeCount} → ${afterCount} components (contract-enforced)`);
    }

    // Attach the classifier's intent to the layoutTree so clients can show it
    if (intent && response.layoutTree && !response.layoutTree.intent) {
      response.layoutTree.intent = intent;
    }

    // R2: enforce suppress / defer contract on non-stream path too
    if (informationPriority && response.renderModel) {
      const enforced = enforceInformationPriority(response.renderModel, informationPriority);
      if (enforced.suppressed.length) {
        console.log(`  [enforce] SUPPRESSED ${enforced.suppressed.length}: ` +
          enforced.suppressed.map(x => x.role).join(', '));
      }
      if (enforced.deferred.length) {
        console.log(`  [enforce] DEFERRED ${enforced.deferred.length}: ` +
          enforced.deferred.map(x => x.role).join(', '));
      }
    }

    // Attach the full decision packet to the layoutTree for caching / inspection.
    if (response.layoutTree) {
      if (orchestration)       response.layoutTree.orchestration       = orchestration;
      if (interpretation)      response.layoutTree.interpretation      = interpretation;
      if (statePacket)         response.layoutTree.statePacket         = statePacket;
      if (informationPriority) response.layoutTree.informationPriority = informationPriority;
    }

    sendJSON(res, 200, response);
  } catch (err) {
    console.error('[agent/generate]', err.message);
    sendJSON(res, 500, { error: err.message || 'Generate failed' });
  }
}

// ============================================================================
//  Streaming Generate — SSE endpoint
// ----------------------------------------------------------------------------
//  Event sequence:
//    event: classified   data: { surfaceType, intent, hierarchy }
//    event: component    data: { id, role, content, ... }     (×N progressive)
//    event: done         data: { sessionId, layoutTree, renderModel, critic }
//    event: error        data: { message }
// ============================================================================
async function handleGenerateStream(body, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  function emit(event, data) {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  req.on('close', () => { /* client disconnected mid-stream */ });

  try {
    const clientGuess = safeSurfaceType(body.surfaceType || 'first-depth-list');

    // ── Step 1: classify (4+2+1 orchestration + interpretation + state
    //                     packet + information priority) ──
    let surfaceType = clientGuess;
    let intent = null;
    let hierarchy = null;
    let timeOfDay = null;
    let activity = null;
    let orchestration = null;
    let interpretation = null;
    let statePacket = null;
    let informationPriority = null;
    if (body.prompt && body.prompt.trim().length >= 6) {
      const classification = await classifyIntent(body.prompt);
      if (classification && classification.surfaceType) {
        surfaceType         = classification.surfaceType;
        intent              = classification.intent;
        hierarchy           = classification.hierarchy;
        timeOfDay           = classification.timeOfDay;
        activity            = classification.activity;
        orchestration       = classification.orchestration      || null;
        interpretation      = classification.interpretation     || null;
        statePacket         = classification.statePacket        || null;
        informationPriority = classification.informationPriority || null;
        if (orchestration) {
          console.log(`  [stream/4+2+1] purpose=${orchestration.purpose.primary}` +
            ` · attn=${orchestration.modulationA.attention}` +
            ` · devices=${orchestration.modulationB.device_count}`);
        }
        if (informationPriority) {
          console.log(`  [stream/priority] must=${informationPriority.must_show.length}, ` +
            `should=${informationPriority.should_show.length}, ` +
            `suppress=${informationPriority.suppress.length}, ` +
            `defer=${informationPriority.defer.length}`);
        }
      }
    }
    // Emit the full orchestration decision packet (classification +
    // interpretation + state packet + information priority) so the
    // client log can render each layer explicitly and the generator
    // step downstream can consume them.
    emit('classified', {
      surfaceType, intent, hierarchy, timeOfDay, activity,
      orchestration, interpretation, statePacket, informationPriority
    });

    // ── Step 2: stream generate ──
    const systemPrompt = buildGenerateSystemPrompt();
    const userPrompt = buildGenerateUserPrompt({
      ...body, surfaceType, intent, timeOfDay, activity,
      orchestration, interpretation, statePacket, informationPriority
    });

    console.log(`  [stream] generate surfaceType=${surfaceType}`);

    let emittedCount = 0;
    let lastEmitTime = 0;
    const fullJson = await callOpenAIStream(systemPrompt, userPrompt, 0.6, (delta, fullText) => {
      // Throttle parsing to ~every 60ms to keep CPU low
      const now = Date.now();
      if (now - lastEmitTime < 60) return;
      lastEmitTime = now;

      const newComps = extractStreamedComponents(fullText, emittedCount);
      newComps.forEach(comp => {
        if (comp && comp.role && ALLOWED_ROLES.has(comp.role)) {
          emit('component', comp);
        }
        emittedCount++;
      });
    });

    // Final pass — pick up any components missed by the throttled parser
    const remaining = extractStreamedComponents(JSON.stringify(fullJson), emittedCount);
    remaining.forEach(comp => {
      if (comp && comp.role && ALLOWED_ROLES.has(comp.role)) emit('component', comp);
      emittedCount++;
    });

    const response = coerceGenerateResponse(fullJson, surfaceType);
    if (intent && response.layoutTree && !response.layoutTree.intent) {
      response.layoutTree.intent = intent;
    }

    // R2: enforce the information priority contract. If the generator
    // slipped in any role that matches a suppress concept, strip it.
    // Mark defer matches with visibility:"collapsed".
    if (informationPriority && response.renderModel) {
      const enforced = enforceInformationPriority(response.renderModel, informationPriority);
      if (enforced.suppressed.length) {
        console.log(`  [enforce/stream] SUPPRESSED ${enforced.suppressed.length}: ` +
          enforced.suppressed.map(x => x.role).join(', '));
      }
      if (enforced.deferred.length) {
        console.log(`  [enforce/stream] DEFERRED ${enforced.deferred.length}: ` +
          enforced.deferred.map(x => x.role).join(', '));
      }
    }

    // Attach the full decision packet to the layoutTree so it persists
    // in cached responses — when a client replays from the LRU cache,
    // the synthetic `classified` event still renders every layer block.
    if (response.layoutTree) {
      if (orchestration)       response.layoutTree.orchestration       = orchestration;
      if (interpretation)      response.layoutTree.interpretation      = interpretation;
      if (statePacket)         response.layoutTree.statePacket         = statePacket;
      if (informationPriority) response.layoutTree.informationPriority = informationPriority;
    }

    emit('done', response);
  } catch (err) {
    console.error('[agent/generate/stream]', err.message);
    emit('error', { message: err.message || 'Stream failed' });
  } finally {
    res.end();
  }
}

// ============================================================================
//  R4: Flow Graph generation — parallel per-node (Promise.all)
// ----------------------------------------------------------------------------
//  Event sequence on /api/agent/generate/flow/stream:
//    event: classified   data: { surfaceType, intent, orchestration, …,
//                                 flowPlan: { nodes:[…], edges:[…] } }
//    event: node_done    data: { nodeId, nodeKind, nodeIntent, nodeIndex,
//                                 renderModel, layoutTree, critic, elapsedMs }
//                        (×N — fires as each parallel generator resolves)
//    event: flow_done    data: { sessionId, nodes:[ { id, kind, intent,
//                                   renderModel, layoutTree, critic } ],
//                                 edges:[…], totalElapsedMs }
//    event: error        data: { message }
//
//  Shape of each node in flow_done matches the single-screen `done` payload
//  so the client renderer can reuse the same path unchanged.
//
//  NOT streamed: individual components within a node. Per-component
//  streaming was removed because progressive canvas paint either
//  degraded visual quality (no layout dispatcher) or flickered
//  (re-running the dispatcher on every arrival). A node's components
//  are delivered atomically when its generator resolves.
// ============================================================================

// Run ONE generator for ONE flow node using the shared classification.
// Returns a coerced response shape identical to single-screen generate
// (layoutTree, renderModel, critic) plus the per-node metadata.
//
// NOTE: deliberately NON-streaming. An earlier iteration used
// callOpenAIStream with per-component emits so the client could paint
// node 0's canvas progressively, but progressive painting either (a)
// skipped the purpose-aware layout dispatcher + chrome merge + emphasis
// tiers and looked visually degraded, or (b) re-ran the dispatcher on
// every arrival and flickered. Both outcomes were worse than waiting
// one more beat for a clean final render. We still run nodes in
// parallel (handleFlowGenerateStream uses Promise.all) so wall-clock
// stays ~= slowest single node.
async function _generateNodeFromClassification(body, ctx, node) {
  const t0 = Date.now();
  const systemPrompt = buildGenerateSystemPrompt();
  // Only emit the FLOW NODE BRIEF for genuinely multi-node flows. For
  // single-node "flows" (which is what every simple prompt like "show
  // weather on my lockscreen" collapses to) the brief used to dial the
  // model toward minimalism — e.g. ambient's "status line + one summary
  // tile" produced 4-component screens that the critic rightly flagged
  // as sparse. Without the brief, the generator behaves exactly like
  // the pre-R4 single-screen path (full chrome + rich content), which
  // is what restores the 90+ critic scores.
  const userPrompt = buildGenerateUserPrompt({
    ...body,
    surfaceType:         ctx.surfaceType,
    intent:              ctx.intent,
    timeOfDay:           ctx.timeOfDay,
    activity:            ctx.activity,
    orchestration:       ctx.orchestration,
    interpretation:      ctx.interpretation,
    statePacket:         ctx.statePacket,
    informationPriority: ctx.informationPriority,
    flowNode: ctx.isMultiNode ? {
      id:           node.id,
      kind:         node.kind,
      intent:       node.intent,
      triggered_by: node.triggered_by
    } : null
  });

  const modelJson = await callOpenAI(systemPrompt, userPrompt, 0.6);
  const response = coerceGenerateResponse(modelJson, ctx.surfaceType);

  // Attach the classifier's intent + decision packet to the layoutTree so
  // the per-node response mirrors the single-screen contract (same caching
  // + inspection surface).
  if (ctx.intent && response.layoutTree && !response.layoutTree.intent) {
    response.layoutTree.intent = ctx.intent;
  }
  if (ctx.informationPriority && response.renderModel) {
    const enforced = enforceInformationPriority(response.renderModel, ctx.informationPriority);
    if (enforced.suppressed.length) {
      console.log(`  [flow/${node.id}] SUPPRESSED ${enforced.suppressed.length}: ` +
        enforced.suppressed.map(x => x.role).join(', '));
    }
    if (enforced.deferred.length) {
      console.log(`  [flow/${node.id}] DEFERRED ${enforced.deferred.length}: ` +
        enforced.deferred.map(x => x.role).join(', '));
    }
  }
  if (response.layoutTree) {
    if (ctx.orchestration)       response.layoutTree.orchestration       = ctx.orchestration;
    if (ctx.interpretation)      response.layoutTree.interpretation      = ctx.interpretation;
    if (ctx.statePacket)         response.layoutTree.statePacket         = ctx.statePacket;
    if (ctx.informationPriority) response.layoutTree.informationPriority = ctx.informationPriority;
    // Per-node markers on the layoutTree, so the client renderer knows
    // which moment in the flow it's displaying without a lookup.
    response.layoutTree.flowNodeId     = node.id;
    response.layoutTree.flowNodeKind   = node.kind;
    response.layoutTree.flowNodeIntent = node.intent;
  }

  return {
    id:        node.id,
    kind:      node.kind,
    intent:    node.intent,
    triggered_by: node.triggered_by || null,
    layoutTree:  response.layoutTree,
    renderModel: response.renderModel,
    critic:      response.critic,
    elapsedMs: Date.now() - t0
  };
}

async function handleFlowGenerateStream(body, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  function emit(event, data) {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  const tFlowStart = Date.now();

  try {
    const clientGuess = safeSurfaceType(body.surfaceType || 'first-depth-list');

    // ── Step 1: classify once (shared across all nodes) ────────────────
    let ctx = {
      surfaceType:         clientGuess,
      intent:              null,
      hierarchy:           null,
      timeOfDay:           null,
      activity:            null,
      orchestration:       null,
      interpretation:      null,
      statePacket:         null,
      informationPriority: null
    };
    let flowPlan = { nodes: [], edges: [] };

    if (body.prompt && body.prompt.trim().length >= 6) {
      const classification = await classifyIntent(body.prompt);
      if (classification && classification.surfaceType) {
        ctx.surfaceType         = classification.surfaceType;
        ctx.intent              = classification.intent;
        ctx.hierarchy           = classification.hierarchy;
        ctx.timeOfDay           = classification.timeOfDay;
        ctx.activity            = classification.activity;
        ctx.orchestration       = classification.orchestration      || null;
        ctx.interpretation      = classification.interpretation     || null;
        ctx.statePacket         = classification.statePacket        || null;
        ctx.informationPriority = classification.informationPriority || null;
        flowPlan = classification.flowPlan || flowPlan;
        if (ctx.orchestration) {
          console.log(`  [flow/classify] purpose=${ctx.orchestration.purpose.primary}` +
            ` · attn=${ctx.orchestration.modulationA.attention}` +
            ` · nodes=${(flowPlan.nodes || []).length}`);
        }
      }
    }

    // Guarantee at least one node (single-screen equivalent). This also
    // preserves the fallback path when classification fails completely.
    if (!flowPlan.nodes || !flowPlan.nodes.length) {
      flowPlan = {
        nodes: [{
          id: 'n1', kind: 'entry',
          intent: ctx.intent || 'generated',
          triggered_by: null
        }],
        edges: []
      };
    }

    // Used by _generateNodeFromClassification to decide whether to emit
    // the FLOW NODE BRIEF. See the function's comment for why single-
    // node flows skip the brief (quality parity with pre-R4 path).
    ctx.isMultiNode = flowPlan.nodes.length > 1;

    // Emit the shared classification + the full flow graph up front so
    // the client can paint the Flow Navigator skeleton while the per-node
    // generators are still running.
    emit('classified', {
      surfaceType:         ctx.surfaceType,
      intent:              ctx.intent,
      hierarchy:           ctx.hierarchy,
      timeOfDay:           ctx.timeOfDay,
      activity:            ctx.activity,
      orchestration:       ctx.orchestration,
      interpretation:      ctx.interpretation,
      statePacket:         ctx.statePacket,
      informationPriority: ctx.informationPriority,
      flowPlan:            flowPlan
    });

    // ── Step 2: run per-node generators in parallel ───────────────────
    console.log(`  [flow] generating ${flowPlan.nodes.length} node(s) in parallel`);
    const nodePromises = flowPlan.nodes.map((node, idx) => {
      return _generateNodeFromClassification(body, ctx, node)
        .then(nodeResult => {
          if (!clientClosed) {
            emit('node_done', {
              nodeId:      nodeResult.id,
              nodeKind:    nodeResult.kind,
              nodeIntent:  nodeResult.intent,
              nodeIndex:   idx,
              triggered_by: nodeResult.triggered_by,
              layoutTree:  nodeResult.layoutTree,
              renderModel: nodeResult.renderModel,
              critic:      nodeResult.critic,
              elapsedMs:   nodeResult.elapsedMs
            });
            console.log(`  [flow/${nodeResult.id}] done (${nodeResult.kind}) in ${nodeResult.elapsedMs}ms`);
          }
          return nodeResult;
        })
        .catch(err => {
          console.error(`  [flow/${node.id}] FAILED: ${err.message}`);
          // Return a sentinel so Promise.all doesn't abort other nodes —
          // the flow_done event will contain whatever succeeded.
          return {
            id: node.id, kind: node.kind, intent: node.intent,
            triggered_by: node.triggered_by || null,
            layoutTree: null, renderModel: null,
            critic: { score: 0, issues: [{ type: 'error', message: err.message }], suggestions: [] },
            elapsedMs: 0,
            error: err.message
          };
        });
    });

    const nodes = await Promise.all(nodePromises);
    const totalElapsedMs = Date.now() - tFlowStart;
    console.log(`  [flow] total ${totalElapsedMs}ms for ${nodes.length} node(s)`);

    emit('flow_done', {
      sessionId: `sess_${Date.now()}`,
      nodes:     nodes,
      edges:     flowPlan.edges || [],
      totalElapsedMs: totalElapsedMs
    });
  } catch (err) {
    console.error('[agent/generate/flow/stream]', err.message);
    emit('error', { message: err.message || 'Flow stream failed' });
  } finally {
    res.end();
  }
}

async function handleRefine(body, res) {
  const fallbackSurface = safeSurfaceType(
    (body.currentRenderModel && body.currentRenderModel.surfaceType) ||
    (body.currentLayout && body.currentLayout.surfaceType) ||
    'first-depth-list'
  );

  try {
    const systemPrompt = buildRefineSystemPrompt();
    const userPrompt = buildRefineUserPrompt(body);

    const promptSize = ((systemPrompt.length + userPrompt.length) / 1024).toFixed(1);
    console.log(`  [surface-grammar] ${promptSize}KB refine prompt (surfaceType: ${fallbackSurface})`);

    const modelJson = await callOpenAI(systemPrompt, userPrompt, 0.4);
    const response = coerceRefineResponse(modelJson, fallbackSurface);

    const beforePatches = Array.isArray(modelJson.patchPlan && modelJson.patchPlan.patches)
      ? modelJson.patchPlan.patches.length : 0;
    const afterPatches = response.patchPlan.patches.length;
    if (beforePatches !== afterPatches) {
      console.log(`  [sanitize:refine] dropped ${beforePatches - afterPatches} patches (non-role or forbidden props)`);
    }

    sendJSON(res, 200, {
      parsedIssue: response.parsedIssue,
      patchPlan: response.patchPlan,
      updatedLayoutTree: {
        ...(body.currentLayout || {}),
        surfaceType: response.patchPlan.surfaceType
      },
      updatedRenderModel: sanitizeRenderModel({
        ...(body.currentRenderModel || {}),
        surfaceType: response.patchPlan.surfaceType
      }),
      critic: response.critic
    });
  } catch (err) {
    console.error('[agent/refine]', err.message);
    sendJSON(res, 500, { error: err.message || 'Refine failed' });
  }
}

// ============================================================================
//  Critic — evaluates semantic correctness only, never redesigns
// ============================================================================

function buildCriticSystemPrompt() {
  return `
You are a UI critic for Samsung One UI semantic surfaces.

Do not redesign.
Do not output coordinates.

Evaluate:
- hierarchy
- clarity
- role correctness
- One UI consistency
- action vs navigation separation
- app bar state consistency

Return strict JSON only:
{
  "score": 84,
  "issues": [
    { "type": "hierarchy", "message": "Search bar competes with title" }
  ],
  "suggestions": [
    "Strengthen app bar emphasis",
    "Reduce search bar prominence"
  ]
}
`;
}

function buildCriticUserPrompt(payload) {
  const surfaceType =
    (payload.renderModel && payload.renderModel.surfaceType) ||
    (payload.layoutTree && payload.layoutTree.surfaceType) ||
    'first-depth-list';

  return `
Surface type:
${surfaceType}

Layout tree:
${JSON.stringify(payload.layoutTree || {}, null, 2)}

Render model:
${JSON.stringify(payload.renderModel || {}, null, 2)}

Please critique the semantic correctness and One UI consistency only.
`;
}

async function handleCritic(body, res) {
  try {
    const systemPrompt = buildCriticSystemPrompt();
    const userPrompt = buildCriticUserPrompt(body);

    const modelJson = await callOpenAI(systemPrompt, userPrompt, 0.3);

    sendJSON(res, 200, {
      score: (modelJson && modelJson.score != null) ? modelJson.score : 80,
      issues: Array.isArray(modelJson && modelJson.issues) ? modelJson.issues : [],
      suggestions: Array.isArray(modelJson && modelJson.suggestions) ? modelJson.suggestions : []
    });
  } catch (err) {
    console.error('[agent/critic]', err.message);
    sendJSON(res, 500, { error: err.message || 'Critic failed' });
  }
}

// --- New: constraint extraction endpoint (for frontend debug/inspect) ---
function handleConstraintExtract(body, res) {
  const constraints = extractConstraints(body.prompt, body.scenario, body.mode || 'dark');
  const size = JSON.stringify(constraints).length;
  sendJSON(res, 200, {
    scenario: _detectScenario(body.prompt || body.scenario),
    constraintSize: `${(size / 1024).toFixed(1)}KB`,
    fullDocSize: `${((DESIGN_MD_RAW.length + GENUI_MD_RAW.length + ORCH_MD_RAW.length) / 1024).toFixed(1)}KB`,
    sources: { designMd: `${(DESIGN_MD_RAW.length / 1024).toFixed(1)}KB`, genuiMd: `${(GENUI_MD_RAW.length / 1024).toFixed(1)}KB`, orchMd: `${(ORCH_MD_RAW.length / 1024).toFixed(1)}KB` },
    compressionRatio: `${((1 - size / (DESIGN_MD_RAW.length + GENUI_MD_RAW.length + ORCH_MD_RAW.length)) * 100).toFixed(0)}%`,
    constraints
  });
}

// ============================================================================
// Variant Session Storage — prompt + result per variant
// ============================================================================
// In-memory store (per session). Refine endpoint reads this for full context.
const variantStore = {};  // { sessionId: { A: {prompt, scenario, html, critic}, B: {...} } }

function handleVariantSync(body, res) {
  const sid = body.sessionId || 'default';
  variantStore[sid] = body.variants || {};
  const aPrompt = body.variants?.A?.prompt || '';
  const bPrompt = body.variants?.B?.prompt || '';
  console.log(`  [variants] Session ${sid}: A="${aPrompt.substring(0, 40)}" B="${bPrompt.substring(0, 40)}"`);
  sendJSON(res, 200, { success: true, sessionId: sid });
}

function getVariantContext(sessionId) {
  return variantStore[sessionId || 'default'] || {};
}

// ============================================================================
// HTTP helpers
// ============================================================================

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  // Same-origin only: genui.html is served from this same server, so no
  // Access-Control-Allow-Origin header is needed. Removing `*` prevents
  // any third-party page your browser visits from silently invoking these
  // endpoints (which would burn the OpenAI key). If you ever need a
  // cross-origin client, echo a specific allowed Origin here — never `*`.
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Read a JSON request body with a hard size cap. On oversize:
//   - responds 413 itself (if `res` was passed and headers weren't sent)
//   - destroys the socket to stop further reads
//   - resolves to `null` so the caller can early-return
// Oversize on Content-Length header is a fast reject (no bytes read).
// On malformed JSON the contract is preserved: resolves to `{}`.
function readBody(req, res) {
  return new Promise((resolve) => {
    const reject413 = (got) => {
      if (res && !res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error:    'Request body too large',
          maxBytes: MAX_BODY_BYTES,
          got:      got
        }));
      }
      try { req.destroy(); } catch (_) { /* already closed */ }
      resolve(null);
    };
    const cl = parseInt(req.headers['content-length']);
    if (!isNaN(cl) && cl > MAX_BODY_BYTES) { reject413(cl); return; }
    let length = 0;
    const chunks = [];
    req.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) { reject413(length); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { parsed = {}; }

      // Only NOW enter the rate counter — body was successfully read and
      // (for LLM routes) the request will actually reach the handler.
      // Re-check because state may have changed since dispatch.
      const u = (req.url || '').split('?')[0];
      if (isLLMRoute(u, req.method)) {
        const check = llmRateCheck();
        if (!check.ok) {
          if (res && !res.headersSent) {
            res.writeHead(check.status, {
              'Content-Type': 'application/json',
              'Retry-After':  String(check.retryAfter)
            });
            res.end(JSON.stringify(check.body));
          }
          resolve(null);
          return;
        }
        llmRateEnter();
        if (res) res.once('close', llmRateExit);
      }

      resolve(parsed);
    });
    req.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
//  LLM rate limiting — global concurrency cap + rolling per-minute quota.
//  Applied in the route dispatcher below to any endpoint that invokes
//  callOpenAI / callOpenAIStream. Non-LLM endpoints (/health, /evolve,
//  static files) are NOT throttled.
// ---------------------------------------------------------------------------
let _llmInFlight = 0;
const _llmRecent = [];  // epoch-ms timestamps, pruned on each check

function _pruneRecent(now) {
  const cutoff = now - 60000;
  while (_llmRecent.length && _llmRecent[0] < cutoff) _llmRecent.shift();
}

// Returns { ok: true } or { ok: false, status, body, retryAfter }.
function llmRateCheck() {
  const now = Date.now();
  _pruneRecent(now);
  if (_llmInFlight >= MAX_CONCURRENT_LLM) {
    return {
      ok: false, status: 429, retryAfter: 1,
      body: { error: 'Too many concurrent LLM requests',
              limit: MAX_CONCURRENT_LLM, inFlight: _llmInFlight }
    };
  }
  if (_llmRecent.length >= MAX_LLM_PER_MIN) {
    const retryAfter = Math.max(1, Math.ceil((_llmRecent[0] + 60000 - now) / 1000));
    return {
      ok: false, status: 429, retryAfter,
      body: { error: 'LLM rate limit exceeded',
              limit: MAX_LLM_PER_MIN + '/min', retryAfterSec: retryAfter }
    };
  }
  return { ok: true };
}

function llmRateEnter() {
  _llmInFlight++;
  _llmRecent.push(Date.now());
}

function llmRateExit() {
  _llmInFlight = Math.max(0, _llmInFlight - 1);
}

// URL prefixes whose POST handlers call OpenAI. Throttle at dispatcher.
const LLM_ROUTE_PREFIXES = [
  '/api/pipeline/full',
  '/api/pipeline/plan',
  '/api/pipeline/compose',
  '/api/agent/generate',
  '/api/agent/refine',
  '/api/agent/variants',
  '/api/agent/constraints'
];

function isLLMRoute(url, method) {
  if (method !== 'POST') return false;
  return LLM_ROUTE_PREFIXES.some(p => url === p || url === p + '/stream');
}

function serveStatic(filePath, res) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    // Development-mode cache policy: force the browser to revalidate
    // every request. Previously hot edits to app/*.js and css/*.css
    // wouldn't reach the user until a manual hard-reload (Cmd+Shift+R),
    // which caused a string of "my fix isn't taking effect" debugging.
    // `no-store` is the strictest directive — no memory or disk cache.
    // This is the right default for a design tool in active
    // development; if we ever cut a release build we can switch to
    // hashed filenames + long-cache headers instead.
    const headers = {
      'Content-Type': mime,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma':        'no-cache',
      'Expires':       '0'
    };
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ============================================================================
// Server
// ============================================================================

const server = http.createServer(async (req, res) => {
  // CORS preflight: reject by default. Browsers will only send an OPTIONS
  // preflight for a cross-origin, credentialed, or non-simple request — and
  // we don't serve any cross-origin clients (genui.html is served from this
  // same origin). Responding 204 *without* Access-Control-* headers causes
  // the browser's CORS check to fail, so the follow-up request is blocked.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // LLM rate limit — FAST REJECT at dispatch only. Entering the counter
  // is deferred to readBody on successful parse (see readBody below) so
  // that 413 body-cap rejections do NOT consume rate slots. The counter
  // is released on `res.close`, which fires on normal end, error, or
  // client disconnect mid-stream, so the counter is leak-free.
  if (isLLMRoute(url, req.method)) {
    const check = llmRateCheck();
    if (!check.ok) {
      res.writeHead(check.status, {
        'Content-Type': 'application/json',
        'Retry-After':  String(check.retryAfter)
      });
      res.end(JSON.stringify(check.body));
      return;
    }
  }

  // ── genui_pipeline_v1 endpoints ─────────────────────────────────────────
  //
  //   POST /api/pipeline/plan     → steps 1 → 2 → 3 + plan validation
  //   POST /api/pipeline/compose  → + step 4 (LLM composer) + layout validation
  //   POST /api/pipeline/full     → + step 7 (explanation)
  //
  // All endpoints emit the canonical camelCase contract:
  //   { interpretation, planningPacket, plan, uiState, layoutPlan?,
  //     composerNotes?, explanation?, validation: { summary, violations[] } }
  // ------------------------------------------------------------------------

  if (url === '/api/pipeline/plan' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      const scenarioText = body.scenario_text || body.prompt || '';

      const planResult = await pipeline.runPlan({
        scenarioText,
        llmCall:           (sys, user) => callOpenAI(sys, user, 0.3),
        llmCallFast:       (sys, user) => callOpenAIFast(sys, user, 0.3),
        llmCallContentBag: (sys, user) => callOpenAIContentBag(sys, user, 0.5),
        embedCall:         callOpenAIEmbedding
      });

      const validation = pipeline.rollupValidationResults({
        planViolations:   planResult.planViolations,
        layoutViolations: []
      });

      console.log(`[Pipeline] plan for "${scenarioText.substring(0,50)}" → ${planResult.plan.requiredComponents.length} components, violations:${validation.summary.total}`);
      sendJSON(res, 200, {
        interpretation: planResult.interpretation,
        planningPacket: planResult.planningPacket,
        plan:           planResult.plan,
        uiState:        planResult.uiState,
        validation
      });
    } catch (e) {
      console.error('[Pipeline] plan error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url === '/api/pipeline/compose' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      const scenarioText = body.scenario_text || body.prompt || '';
      const viewport     = body.viewport || null;

      const planResult = await pipeline.runPlan({
        scenarioText,
        llmCall:           (sys, user) => callOpenAI(sys, user, 0.3),
        llmCallFast:       (sys, user) => callOpenAIFast(sys, user, 0.3),
        llmCallContentBag: (sys, user) => callOpenAIContentBag(sys, user, 0.5),
        embedCall:         callOpenAIEmbedding
      });

      const layoutResult = await pipeline.runComposeLayout({
        planningPacket: planResult.planningPacket,
        plan:           planResult.plan,
        llmCall:        (sys, user) => callOpenAICompose(sys, user, 0.55),
        viewport,
        scenarioText
      });

      const validation = pipeline.rollupValidationResults({
        planViolations:   planResult.planViolations,
        layoutViolations: layoutResult.violations
      });

      console.log(`[Pipeline] compose for "${scenarioText.substring(0,50)}" → groups:${layoutResult.composed.layoutPlan.groups.length} violations:${validation.summary.total}`);
      sendJSON(res, 200, {
        interpretation: planResult.interpretation,
        planningPacket: planResult.planningPacket,
        plan:           planResult.plan,
        uiState:        planResult.uiState,
        layoutPlan:     layoutResult.composed.layoutPlan,
        composerNotes:  layoutResult.composed.composerNotes,
        validation
      });
    } catch (e) {
      console.error('[Pipeline] compose error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Streaming variant of /api/pipeline/full. Emits one SSE event per
  // step so the client can see EXACTLY where the pipeline stalls or
  // fails, along with the JSON output each step produced. Events:
  //   event: step_started   data: { step, label, idx, total }
  //   event: step_done      data: { step, output, elapsedMs, idx, total }
  //   event: done           data: { /* full bundled result */ }
  //   event: error          data: { step, message, elapsedMs }
  if (url === '/api/pipeline/full/stream' && req.method === 'POST') {
    const _body = await readBody(req, res);
    if (_body === null) return;  // 413 already sent
    const _scenarioText = _body.scenario_text || _body.prompt || '';
    const _viewport     = _body.viewport || null;
    // fastMode (A+B+C from the speed-vs-detail tradeoff):
    //   A — trim verbose reasoning arrays (selectionReasoning,
    //       whyThisStructure, priorityPreservation, constraints) to
    //       max 1-2 entries. Keeps the schema shape but reduces tokens.
    //   B — skip Stage 7 (explain). Saves 2-5 seconds; the prose
    //       is purely UI-display, no downstream consumer reads it.
    //   C — strip slim-able metadata fields (collapsedOptionalTasks,
    //       constraints array) so JSON payload is smaller.
    // Activated by client when "Output log" checkbox is unchecked.
    const _fastMode = _body.fastMode === true;

    // Trim helper for fastMode — applied AFTER each step's output is
    // produced. Only mutates verbose arrays; structural fields stay.
    function _fastTrim(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      // Cap arrays of reasoning strings to 1-2 entries.
      if (Array.isArray(obj.selectionReasoning))    obj.selectionReasoning    = obj.selectionReasoning.slice(0, 2);
      if (Array.isArray(obj.whyThisStructure))      obj.whyThisStructure      = obj.whyThisStructure.slice(0, 2);
      if (Array.isArray(obj.priorityPreservation))  obj.priorityPreservation  = obj.priorityPreservation.slice(0, 2);
      if (Array.isArray(obj.collapsedOptionalTasks)) obj.collapsedOptionalTasks = obj.collapsedOptionalTasks.slice(0, 1);
      if (Array.isArray(obj.constraints))           obj.constraints           = obj.constraints.slice(0, 2);
      // Recurse into known nested holders
      if (obj.plannerNotes)  _fastTrim(obj.plannerNotes);
      if (obj.composerNotes) _fastTrim(obj.composerNotes);
      if (obj.interpretation) _fastTrim(obj.interpretation);
      if (obj.planningPacket) _fastTrim(obj.planningPacket);
      return obj;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    function emit(event, data) {
      res.write('event: ' + event + '\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    }

    const STEPS = [
      { id: 'interpret', label: 'merged interpret + normalize (steps 1+2)' },
      { id: 'select',    label: 'component selector (step 3)' },
      { id: 'compose',   label: 'LLM layout composer (step 4)' },
      { id: 'validate',  label: 'Rollup validation (step 5)' },
      { id: 'explain',   label: 'Explanation layer (step 7)' }
    ];
    const TOTAL = STEPS.length;
    let currentStep = null;
    let stepT0 = 0;

    function startStep(idx) {
      currentStep = STEPS[idx];
      stepT0 = Date.now();
      emit('step_started', {
        step:  currentStep.id,
        label: currentStep.label,
        idx:   idx + 1,
        total: TOTAL
      });
    }
    function doneStep(idx, output, fallbacks) {
      emit('step_done', {
        step:      STEPS[idx].id,
        output:    output,
        fallbacks: fallbacks || null,  // { total, byType, events[] } — null if step did no LLM/normalization work
        elapsedMs: Date.now() - stepT0,
        idx:       idx + 1,
        total:     TOTAL
      });
    }

    // Summarize a collector for emission (strip event array if huge)
    function summarizeCollector(c) {
      if (!c) return null;
      const MAX_EVENTS = 50;
      return {
        total:  c.total,
        byType: c.byType,
        events: Array.isArray(c.events) && c.events.length > MAX_EVENTS
          ? c.events.slice(0, MAX_EVENTS).concat([{ truncated: c.events.length - MAX_EVENTS }])
          : (c.events || [])
      };
    }

    try {
      // Step 1: merged interpret + normalize (uses fast model)
      startStep(0);
      const { result: ipnResult, fallbacks: ipnFallbacks } = await normalizer.withCollector(() => pipeline.runInterpretAndNormalize({
        scenarioText: _scenarioText,
        llmCall:     (sys, user) => callOpenAI(sys, user, 0.3),
        llmCallFast: (sys, user) => callOpenAIFast(sys, user, 0.3),
        fastMode:    _fastMode
      }));
      if (_fastMode) {
        _fastTrim(ipnResult.interpretation);
        _fastTrim(ipnResult.planningPacket);
      }
      doneStep(0, {
        interpretation:  ipnResult.interpretation,
        planningPacket:  ipnResult.planningPacket,
        uiState:         ipnResult.planningPacket.uiState || ipnResult.interpretation.uiState
      }, summarizeCollector(ipnFallbacks));

      // Step 2: component selector (uses full model — vocabulary reasoning
      // matters) running in PARALLEL with the content-bag enrichment stage
      // (Stage 3.5, mini model). Both fire after step 1 completes; we await
      // both via Promise.all so the bag adds zero critical-path latency.
      // After both resolve, applyContentSwap fills empty / duplicated slots
      // in the selector plan from bag entries.
      startStep(1);
      const [selPair, bagResult] = await Promise.all([
        normalizer.withCollector(() => pipeline.runSelect({
          scenarioText:    _scenarioText,
          interpretation:  ipnResult.interpretation,
          planningPacket:  ipnResult.planningPacket,
          rawCombined:     ipnResult.rawCombined,
          llmCall:         (sys, user) => callOpenAI(sys, user, 0.3),
          embedCall:       callOpenAIEmbedding,
          fastMode:        _fastMode
        })),
        pipeline.runContentBag({
          scenarioText:   _scenarioText,
          planningPacket: ipnResult.planningPacket,
          interpretation: ipnResult.interpretation,
          llmCall:        (sys, user) => callOpenAIContentBag(sys, user, 0.5),
          fastMode:       _fastMode
        }).catch(e => {
          console.warn('[Pipeline] content bag stream failure (non-fatal):', e.message);
          return null;
        })
      ]);
      const { result: selResult, fallbacks: selFallbacks } = selPair;
      if (bagResult) pipeline.applyContentSwap(selResult.plan, bagResult);
      if (_fastMode) _fastTrim(selResult.plan);
      doneStep(1, {
        plan:            selResult.plan,
        planViolations:  selResult.planViolations,
        contentBag:      bagResult
      }, summarizeCollector(selFallbacks));

      // Build the back-compat planResult shape (some downstream code still
      // reads it as a single object).
      const planResult = {
        interpretation:  ipnResult.interpretation,
        planningPacket:  ipnResult.planningPacket,
        plan:            selResult.plan,
        uiState:         ipnResult.planningPacket.uiState || ipnResult.interpretation.uiState,
        planViolations:  selResult.planViolations
      };

      // Step 3: compose (LLM layout composer — full model)
      startStep(2);
      const { result: layoutResult, fallbacks: composeFallbacks } = await normalizer.withCollector(() => pipeline.runComposeLayout({
        planningPacket: planResult.planningPacket,
        plan:           planResult.plan,
        llmCall:        (sys, user) => callOpenAICompose(sys, user, 0.55),
        viewport:       _viewport,
        scenarioText:   _scenarioText,
        fastMode:       _fastMode
      }));
      if (_fastMode) _fastTrim(layoutResult.composed);
      doneStep(2, {
        layoutPlan:       layoutResult.composed.layoutPlan,
        composerNotes:    layoutResult.composed.composerNotes,
        layoutViolations: layoutResult.violations
      }, summarizeCollector(composeFallbacks));

      // Step 4: validate (rollup — no LLM, no normalizer; fallbacks always zero here)
      startStep(3);
      const validation = pipeline.rollupValidationResults({
        planViolations:   planResult.planViolations,
        layoutViolations: layoutResult.violations
      });
      doneStep(3, validation, null);

      // Step 5: explain — fastMode SKIPS this step entirely. Saves 2-5
      // seconds. Path A panels handle missing explanation gracefully
      // (the "Why this UI" / "What was prioritized" sections just don't
      // render). Validation already gives the user the full violation
      // list, which is the only structured signal that matters.
      let explanation = null;
      let explainFallbacks = { total: 0, byType: {}, events: [] };
      if (!_fastMode) {
        startStep(4);
        const explainRes = await normalizer.withCollector(() => pipeline.runExplain({
          scenarioText:     _scenarioText,
          uiState:          planResult.uiState,
          plan:             planResult.plan,
          layoutPlan:       layoutResult.composed.layoutPlan,
          validationReport: validation,
          llmCall:          (sys, user) => callOpenAIExplain(sys, user, 0.6)
        }));
        explanation      = explainRes.result;
        explainFallbacks = explainRes.fallbacks;
        doneStep(4, explanation, summarizeCollector(explainFallbacks));
      } else {
        // Emit a step_done with null output so client knows the step
        // is intentionally skipped (and can render a "fast mode" hint
        // instead of a missing-data error).
        emit('step_started', { step: 'explain', label: 'Explanation layer (skipped — fast mode)', idx: 5, total: TOTAL });
        emit('step_done',    { step: 'explain', output: null, fallbacks: null, elapsedMs: 0, idx: 5, total: TOTAL, skipped: true });
      }

      const runFallbacks = {
        total: (ipnFallbacks.total || 0)
             + (selFallbacks.total || 0)
             + (composeFallbacks.total || 0)
             + (explainFallbacks.total || 0),
        byStep: {
          interpret: ipnFallbacks.total     || 0,
          select:    selFallbacks.total     || 0,
          compose:   composeFallbacks.total || 0,
          explain:   explainFallbacks.total || 0
        }
      };

      // Final bundled result (same shape as /api/pipeline/full)
      emit('done', {
        interpretation: planResult.interpretation,
        planningPacket: planResult.planningPacket,
        plan:           planResult.plan,
        uiState:        planResult.uiState,
        layoutPlan:     layoutResult.composed.layoutPlan,
        composerNotes:  layoutResult.composed.composerNotes,
        explanation,
        validation,
        fallbacks:      runFallbacks
      });
      console.log(`[Pipeline/stream] full for "${_scenarioText.substring(0,50)}" → groups:${layoutResult.composed.layoutPlan.groups.length} violations:${validation.summary.total} fallbacks:${runFallbacks.total}`);
    } catch (err) {
      const elapsed = Date.now() - stepT0;
      console.error('[Pipeline/stream]', (currentStep ? currentStep.id : 'init'), err.message);
      emit('error', {
        step: currentStep ? currentStep.id : 'init',
        message: err.message || 'Pipeline failed',
        elapsedMs: elapsed
      });
    } finally {
      res.end();
    }
    return;
  }

  if (url === '/api/pipeline/full' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      const scenarioText = body.scenario_text || body.prompt || '';
      const viewport     = body.viewport || null;
      // fastMode: A+B+C from the speed-vs-detail tradeoff. See the
      // /api/pipeline/full/stream endpoint above for full doc.
      const fastMode = body.fastMode === true;

      const planResult = await pipeline.runPlan({
        scenarioText,
        llmCall:           (sys, user) => callOpenAI(sys, user, 0.3),
        llmCallFast:       (sys, user) => callOpenAIFast(sys, user, 0.3),
        llmCallContentBag: (sys, user) => callOpenAIContentBag(sys, user, 0.5),
        embedCall:         callOpenAIEmbedding,
        fastMode
      });

      const layoutResult = await pipeline.runComposeLayout({
        planningPacket: planResult.planningPacket,
        plan:           planResult.plan,
        llmCall:        (sys, user) => callOpenAICompose(sys, user, 0.55),
        viewport,
        scenarioText,
        fastMode
      });

      const validation = pipeline.rollupValidationResults({
        planViolations:   planResult.planViolations,
        layoutViolations: layoutResult.violations
      });

      // fastMode: trim verbose arrays + skip explainer
      function _fastTrimNS(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj.selectionReasoning))     obj.selectionReasoning     = obj.selectionReasoning.slice(0, 2);
        if (Array.isArray(obj.whyThisStructure))       obj.whyThisStructure       = obj.whyThisStructure.slice(0, 2);
        if (Array.isArray(obj.priorityPreservation))   obj.priorityPreservation   = obj.priorityPreservation.slice(0, 2);
        if (Array.isArray(obj.collapsedOptionalTasks)) obj.collapsedOptionalTasks = obj.collapsedOptionalTasks.slice(0, 1);
        if (Array.isArray(obj.constraints))            obj.constraints            = obj.constraints.slice(0, 2);
        if (obj.plannerNotes)   _fastTrimNS(obj.plannerNotes);
        if (obj.composerNotes)  _fastTrimNS(obj.composerNotes);
        if (obj.interpretation) _fastTrimNS(obj.interpretation);
        if (obj.planningPacket) _fastTrimNS(obj.planningPacket);
        return obj;
      }
      if (fastMode) {
        _fastTrimNS(planResult.interpretation);
        _fastTrimNS(planResult.planningPacket);
        _fastTrimNS(planResult.plan);
        _fastTrimNS(layoutResult.composed);
      }

      const explanation = fastMode ? null : await pipeline.runExplain({
        scenarioText,
        uiState:          planResult.uiState,
        plan:             planResult.plan,
        layoutPlan:       layoutResult.composed.layoutPlan,
        validationReport: validation,
        llmCall:          (sys, user) => callOpenAIExplain(sys, user, 0.6)
      });

      console.log(`[Pipeline] full for "${scenarioText.substring(0,50)}" → groups:${layoutResult.composed.layoutPlan.groups.length} violations:${validation.summary.total} explained:${!!explanation}`);
      sendJSON(res, 200, {
        interpretation: planResult.interpretation,
        planningPacket: planResult.planningPacket,
        plan:           planResult.plan,
        uiState:        planResult.uiState,
        layoutPlan:     layoutResult.composed.layoutPlan,
        composerNotes:  layoutResult.composed.composerNotes,
        explanation,
        validation
      });
    } catch (e) {
      console.error('[Pipeline] full error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // ── Theme system endpoints ───────────────────────────────────────────
  // GET  /api/themes               → loads themes.json + active id
  // POST /api/themes/active        → { id } sets active theme
  // POST /api/themes               → { theme } adds a custom theme
  // The active theme ID is persisted in figma-refs/themes.json so it
  // survives restarts. Cards render via CSS vars → no rebuild needed.
  if (url === '/api/themes' && req.method === 'GET') {
    try {
      const themesPath = path.join(__dirname, 'figma-refs', 'themes.json');
      if (!fs.existsSync(themesPath)) {
        sendJSON(res, 404, { error: 'themes.json not found' });
        return;
      }
      sendJSON(res, 200, JSON.parse(fs.readFileSync(themesPath, 'utf8')));
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (url === '/api/themes/active' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;
      const themesPath = path.join(__dirname, 'figma-refs', 'themes.json');
      const data = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
      const id = body && body.id;
      if (!id || !data.themes.find(t => t.id === id)) {
        sendJSON(res, 400, { error: 'unknown theme id: ' + id });
        return;
      }
      data._active = id;
      fs.writeFileSync(themesPath, JSON.stringify(data, null, 2));
      console.log('[themes] active theme set to: ' + id);
      sendJSON(res, 200, { active: id });
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (url === '/api/themes' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;
      const theme = body && body.theme;
      if (!theme || !theme.id || !theme.name || !theme.vars) {
        sendJSON(res, 400, { error: 'theme requires { id, name, vars }' });
        return;
      }
      const themesPath = path.join(__dirname, 'figma-refs', 'themes.json');
      const data = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
      // Reject duplicate IDs (or update if `body.replace=true`)
      const existing = data.themes.findIndex(t => t.id === theme.id);
      if (existing >= 0 && !body.replace) {
        sendJSON(res, 409, { error: 'theme id already exists; pass replace:true to overwrite' });
        return;
      }
      if (existing >= 0) data.themes[existing] = theme;
      else                data.themes.push(theme);
      fs.writeFileSync(themesPath, JSON.stringify(data, null, 2));
      console.log('[themes] saved theme: ' + theme.id);
      sendJSON(res, 200, { saved: theme.id, total: data.themes.length });
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── Self-improving system endpoints (Phase A: test suite + scoring) ──
  // GET /api/improve/test-suite        → returns the loaded scenarios + scoring config
  // POST /api/improve/test-suite/run   → runs the entire suite, returns scored runs
  // GET /api/improve/history           → lists saved cycle reports
  // GET /api/improve/history/:filename → returns one report
  if (url === '/api/improve/test-suite' && req.method === 'GET') {
    sendJSON(res, 200, improvementEngine.getTestSuite() || { error: 'test-suite not loaded' });
    return;
  }

  if (url === '/api/improve/test-suite/run' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;
      // Build the runner that produces the same output shape as /api/pipeline/full.
      // The test suite engine is decoupled from server.js; we hand it a closure.
      const runner = async ({ scenarioText }) => {
        const planResult = await pipeline.runPlan({
          scenarioText,
          llmCall:           (sys, user) => callOpenAI(sys, user, 0.3),
          llmCallFast:       (sys, user) => callOpenAIFast(sys, user, 0.3),
          llmCallContentBag: (sys, user) => callOpenAIContentBag(sys, user, 0.5),
          embedCall:         callOpenAIEmbedding
        });
        const layoutResult = await pipeline.runComposeLayout({
          planningPacket: planResult.planningPacket,
          plan:           planResult.plan,
          llmCall:        (sys, user) => callOpenAICompose(sys, user, 0.55),
          viewport:       body.viewport || null,
          scenarioText
        });
        const validation = pipeline.rollupValidationResults({
          planViolations:   planResult.planViolations,
          layoutViolations: layoutResult.violations
        });
        // Skip explainer to save time (test suite runs ~10 scenarios — saves
        // ~30 seconds total, and the explanation isn't used for scoring).
        return {
          interpretation: planResult.interpretation,
          planningPacket: planResult.planningPacket,
          plan:           planResult.plan,
          uiState:        planResult.uiState,
          layoutPlan:     layoutResult.composed.layoutPlan,
          composerNotes:  layoutResult.composed.composerNotes,
          validation
        };
      };
      const t0 = Date.now();
      console.log('[improve] test-suite run starting...');
      const report = await improvementEngine.runTestSuite({
        runner,
        onProgress: ({ idx, total, scenario }) => {
          console.log(`[improve] [${idx + 1}/${total}] ${scenario.id} — "${scenario.scenarioText.slice(0, 60)}"`);
        }
      });
      report.summary.elapsedMsTotal = Date.now() - t0;
      const fname = improvementEngine.saveCycleReport(report);
      report.summary.savedAs = fname;
      console.log(`[improve] test-suite done: weightedAvg=${report.summary.weightedAvgScore} cumulative=${report.summary.cumulativeScore} elapsed=${(report.summary.elapsedMsTotal/1000).toFixed(1)}s saved=${fname}`);
      sendJSON(res, 200, report);
    } catch (e) {
      console.error('[improve] test-suite error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url === '/api/improve/history' && req.method === 'GET') {
    sendJSON(res, 200, { reports: improvementEngine.listCycleReports() });
    return;
  }

  // POST /api/improve/extract  — Phase B: run LLM pattern extraction on a
  // saved cycle report (default: latest) and return proposed rules. Body:
  //   { reportFilename?: "<filename in data/improvement_history>" }
  if (url === '/api/improve/extract' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;
      // Pick report: explicit filename or latest.
      let reportFilename = body && body.reportFilename;
      if (!reportFilename) {
        const all = improvementEngine.listCycleReports();
        if (all.length === 0) {
          sendJSON(res, 404, { error: 'no cycle reports found — run /api/improve/test-suite/run first' });
          return;
        }
        reportFilename = all[0];
      }
      // Sandbox path
      if (/[^A-Za-z0-9._\-]/.test(reportFilename) || reportFilename.indexOf('..') >= 0) {
        sendJSON(res, 400, { error: 'invalid filename' });
        return;
      }
      const filePath = path.join(__dirname, 'data', 'improvement_history', reportFilename);
      if (!fs.existsSync(filePath)) {
        sendJSON(res, 404, { error: 'report not found: ' + reportFilename });
        return;
      }
      const report = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.log(`[improve] extract starting on ${reportFilename}`);
      const t0 = Date.now();
      const extraction = await improvementEngine.runPatternExtraction({
        report,
        llmCall: (sys, user) => callOpenAI(sys, user, 0.4)  // standard model — extraction needs reasoning
      });
      extraction.elapsedMs = Date.now() - t0;
      extraction.sourceReport = reportFilename;
      console.log(`[improve] extract done: ${extraction.proposedRules.length} rules proposed (${extraction.rejectedCount} rejected) in ${(extraction.elapsedMs/1000).toFixed(1)}s`);
      sendJSON(res, 200, extraction);
    } catch (e) {
      console.error('[improve] extract error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/improve/rule-schema  — returns the closed rule type schema so
  // a UI / external tool can present what kinds of rules can be proposed.
  if (url === '/api/improve/rule-schema' && req.method === 'GET') {
    sendJSON(res, 200, { ruleTypes: improvementEngine.getRuleSchemaSummary() });
    return;
  }

  // GET /api/improve/learned  — current state of learned rules (runtime
  // and persisted). Used by the UI to display what's active.
  if (url === '/api/improve/learned' && req.method === 'GET') {
    sendJSON(res, 200, {
      runtime:   pipeline.listLearnedRules(),
      persisted: improvementEngine.loadLearnedRules()
    });
    return;
  }

  // Helper to build a runner closure used by trial / cycle endpoints. The
  // runner takes { scenarioText } and returns the same shape as
  // /api/pipeline/full (sans explanation, which we skip for speed).
  const _buildPipelineRunner = (viewport) => async ({ scenarioText }) => {
    const planResult = await pipeline.runPlan({
      scenarioText,
      llmCall:           (sys, user) => callOpenAI(sys, user, 0.3),
      llmCallFast:       (sys, user) => callOpenAIFast(sys, user, 0.3),
      llmCallContentBag: (sys, user) => callOpenAIContentBag(sys, user, 0.5),
      embedCall:         callOpenAIEmbedding
    });
    const layoutResult = await pipeline.runComposeLayout({
      planningPacket: planResult.planningPacket,
      plan:           planResult.plan,
      llmCall:        (sys, user) => callOpenAICompose(sys, user, 0.55),
      viewport:       viewport || null,
      scenarioText
    });
    const validation = pipeline.rollupValidationResults({
      planViolations:   planResult.planViolations,
      layoutViolations: layoutResult.violations
    });
    return {
      interpretation: planResult.interpretation,
      planningPacket: planResult.planningPacket,
      plan:           planResult.plan,
      uiState:        planResult.uiState,
      layoutPlan:     layoutResult.composed.layoutPlan,
      composerNotes:  layoutResult.composed.composerNotes,
      validation
    };
  };

  // POST /api/improve/trial  — run trial(s) for one or more rules. Body:
  //   {
  //     rules: [{ type, payload, reason?, confidence? }, ...],
  //     baseline?: { summary: { cumulativeScore } } | null,  // optional cached baseline
  //     persist?: boolean  // if true, accepted rules survive restart (default true)
  //   }
  // Returns: { results: [{ rule, accepted, baseline, trial, deltaPct, ... }], summary }
  if (url === '/api/improve/trial' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;
      const rules = Array.isArray(body && body.rules) ? body.rules : [];
      if (rules.length === 0) {
        sendJSON(res, 400, { error: 'body.rules must be a non-empty array' });
        return;
      }
      const persist = body.persist !== false;  // default true
      const runner = _buildPipelineRunner(body.viewport);
      console.log(`[improve] trial starting: ${rules.length} rules`);
      const t0 = Date.now();

      // First baseline (cached or fresh)
      let baseline = body.baseline || null;
      if (!baseline) {
        console.log(`[improve] trial: running baseline (no cache provided)`);
        baseline = await improvementEngine.runTestSuite({ runner });
      }

      const results = [];
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        console.log(`[improve] trial [${i + 1}/${rules.length}] type=${rule.type}`);
        const r = await improvementEngine.trialRule({
          rule,
          runner,
          baseline,
          pipelineModule: pipeline,
          onProgress: ({ stage, idx, total }) => {
            if (idx != null) console.log(`[improve]   ${stage} ${idx + 1}/${total}`);
          }
        });
        // If rejected, the trialRule already reverted. If accepted, runtime
        // still has it applied — we'll persist below.
        results.push({
          ruleType:   rule.type,
          ruleId:     r.rule && r.rule.id,
          accepted:   r.accepted,
          baseline:   r.baseline,
          trial:      r.trial,
          delta:      r.delta,
          deltaPct:   r.deltaPct,
          threshold:  r.threshold,
          reason:     r.reason,
          confidence: rule.confidence
        });
      }

      // Persist
      const accepted = results.filter(r => r.accepted);
      const rejected = results.filter(r => !r.accepted);
      if (persist) {
        if (accepted.length) {
          improvementEngine.persistAcceptedRules(
            accepted.map((a, i) => ({
              rule:    rules[i],
              baseline: a.baseline,
              trial:    a.trial,
              delta:    a.delta,
              deltaPct: a.deltaPct
            }))
          );
        }
        if (rejected.length) {
          improvementEngine.persistRejectedRules(
            rejected.map((rj) => {
              const idx = results.indexOf(rj);
              return {
                rule:     rules[idx],
                baseline: rj.baseline,
                trial:    rj.trial,
                delta:    rj.delta,
                deltaPct: rj.deltaPct,
                reason:   rj.reason
              };
            })
          );
        }
      }

      const elapsed = Date.now() - t0;
      console.log(`[improve] trial done: accepted=${accepted.length} rejected=${rejected.length} elapsed=${(elapsed / 1000).toFixed(1)}s`);
      sendJSON(res, 200, {
        results,
        summary: {
          total:    results.length,
          accepted: accepted.length,
          rejected: rejected.length,
          baselineScore: baseline.summary.cumulativeScore,
          finalScore:    accepted.length ? results[results.length - 1].trial : baseline.summary.cumulativeScore,
          elapsedMs: elapsed,
          persisted: persist
        }
      });
    } catch (e) {
      console.error('[improve] trial error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/improve/cycle  — Phase D: full self-improving loop.
  //    1. Run baseline test suite
  //    2. Run pattern extraction (LLM)
  //    3. Trial each proposed rule
  //    4. Persist accepted
  //    5. Return cycle report
  // Body: { sourceReport?: filename } (optional — if missing, runs fresh
  // baseline). { dryRun?: boolean } — if true, doesn't persist.
  if (url === '/api/improve/cycle' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;
      const dryRun = !!body.dryRun;
      const runner = _buildPipelineRunner(body.viewport);
      console.log('[improve] CYCLE starting (dryRun=' + dryRun + ')');
      const cycleT0 = Date.now();

      // 1. Baseline
      let baselineReport;
      if (body.sourceReport) {
        const filePath = path.join(__dirname, 'data', 'improvement_history', body.sourceReport);
        if (!fs.existsSync(filePath)) {
          sendJSON(res, 404, { error: 'source report not found: ' + body.sourceReport });
          return;
        }
        baselineReport = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        console.log('[improve] cycle: using cached baseline ' + body.sourceReport);
      } else {
        console.log('[improve] cycle: running fresh baseline');
        baselineReport = await improvementEngine.runTestSuite({ runner });
        improvementEngine.saveCycleReport(baselineReport);
      }
      const baselineScore = baselineReport.summary.cumulativeScore;

      // 2. Extract
      console.log('[improve] cycle: extracting patterns...');
      const extraction = await improvementEngine.runPatternExtraction({
        report:  baselineReport,
        llmCall: (sys, user) => callOpenAI(sys, user, 0.4)
      });
      console.log('[improve] cycle: ' + extraction.proposedRules.length + ' rules proposed');

      // 3. Trial each
      // Generalization knobs:
      //   body.useVariations=true → trial scores include synthetic variants
      //                              of each scenario (overfit guard)
      //   body.variationCount     → how many variants per scenario (default 2)
      const useVariations = !!body.useVariations;
      const variationCount = body.variationCount != null ? body.variationCount : 2;
      const trialLLM = (sys, user) => callOpenAI(sys, user, 0.5);  // for variation gen
      const results = [];
      for (let i = 0; i < extraction.proposedRules.length; i++) {
        const rule = extraction.proposedRules[i];
        console.log('[improve] cycle: trial [' + (i + 1) + '/' + extraction.proposedRules.length + '] type=' + rule.type +
          (useVariations ? ' (with ' + variationCount + ' variations)' : ''));
        const r = await improvementEngine.trialRule({
          rule,
          runner,
          baseline: baselineReport,  // reuse same baseline for fairness
          pipelineModule: pipeline,
          useVariations,
          llmCall: trialLLM,
          variationCount
        });
        results.push({
          rule,
          accepted: r.accepted,
          baseline: r.baseline,
          trial:    r.trial,
          delta:    r.delta,
          deltaPct: r.deltaPct,
          trainingDeltaPct:   r.trainingDeltaPct,
          validationDeltaPct: r.validationDeltaPct,
          hasHoldout:         r.hasHoldout,
          reason:   r.reason
        });
      }

      // 4. Persist
      const accepted = results.filter(r => r.accepted);
      const rejected = results.filter(r => !r.accepted);
      if (!dryRun && accepted.length) improvementEngine.persistAcceptedRules(accepted);
      if (!dryRun && rejected.length) improvementEngine.persistRejectedRules(rejected);

      const elapsed = Date.now() - cycleT0;
      const finalScore = accepted.length
        ? Math.max(...accepted.map(a => a.trial))
        : baselineScore;
      const report = {
        startedAt:      new Date(cycleT0).toISOString(),
        elapsedMs:      elapsed,
        dryRun,
        baseline: {
          score: baselineScore,
          weightedAvgScore: baselineReport.summary.weightedAvgScore,
          source: body.sourceReport || 'fresh'
        },
        extraction: {
          analysis:      extraction.analysis,
          proposedCount: extraction.proposedRules.length,
          rejectedShape: extraction.rejectedCount
        },
        trials: results,
        accepted: accepted.map(r => ({ id: r.rule.id, type: r.rule.type, deltaPct: r.deltaPct })),
        rejected: rejected.map(r => ({ type: r.rule.type, deltaPct: r.deltaPct, reason: r.reason })),
        summary: {
          baselineScore,
          finalScore,
          improvement:    finalScore - baselineScore,
          improvementPct: baselineScore !== 0 ? Math.round((finalScore - baselineScore) / Math.abs(baselineScore) * 10000) / 100 : 0,
          acceptedCount: accepted.length,
          rejectedCount: rejected.length
        }
      };
      console.log('[improve] CYCLE done: baseline=' + baselineScore + ' final=' + finalScore +
        ' Δ=' + (finalScore - baselineScore) + ' (' + report.summary.improvementPct + '%) ' +
        'accepted=' + accepted.length + '/' + results.length + ' elapsed=' + (elapsed/1000).toFixed(1) + 's');
      sendJSON(res, 200, report);
    } catch (e) {
      console.error('[improve] cycle error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url.startsWith('/api/improve/history/') && req.method === 'GET') {
    try {
      const fname = url.replace('/api/improve/history/', '');
      // Sandboxed path: only files in HISTORY_DIR, no traversal.
      if (/[^A-Za-z0-9._\-]/.test(fname) || fname.indexOf('..') >= 0) {
        sendJSON(res, 400, { error: 'invalid filename' });
        return;
      }
      const filePath = path.join(__dirname, 'data', 'improvement_history', fname);
      if (!fs.existsSync(filePath)) {
        sendJSON(res, 404, { error: 'not found' });
        return;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      sendJSON(res, 200, JSON.parse(content));
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // API routes
  if (url === '/api/agent/generate' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      console.log(`[API] Generate: "${body.prompt || body.scenario || '?'}"`);
      await handleGenerate(body, res);
    } catch (e) {
      console.error('[API] Generate error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Streaming generate (SSE)
  if (url === '/api/agent/generate/stream' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      console.log(`[API] Generate (stream): "${(body.prompt || body.scenario || '?').substring(0, 60)}"`);
      await handleGenerateStream(body, req, res);
    } catch (e) {
      console.error('[API] Stream error:', e.message);
      // If res hasn't been written to yet, send JSON error; otherwise just end
      try { sendJSON(res, 500, { error: e.message }); }
      catch (_) { try { res.end(); } catch(__) {} }
    }
    return;
  }

  // R4: Flow Graph parallel generation (SSE)
  //   Classifies once → runs N per-node generators in parallel (Promise.all)
  //   Emits: classified → node_done (×N) → flow_done
  if (url === '/api/agent/generate/flow/stream' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      console.log(`[API] Flow generate (stream): "${(body.prompt || body.scenario || '?').substring(0, 60)}"`);
      await handleFlowGenerateStream(body, req, res);
    } catch (e) {
      console.error('[API] Flow stream error:', e.message);
      try { sendJSON(res, 500, { error: e.message }); }
      catch (_) { try { res.end(); } catch(__) {} }
    }
    return;
  }

  if (url === '/api/agent/refine' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      console.log(`[API] Refine: "${(body.feedback || '').substring(0, 60)}"`);
      await handleRefine(body, res);
    } catch (e) {
      console.error('[API] Refine error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (url === '/api/agent/critic' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      console.log(`[API] Critic: surfaceType=${(body.renderModel && body.renderModel.surfaceType) || 'unknown'}`);
      await handleCritic(body, res);
    } catch (e) {
      console.error('[API] Critic error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Variant sync endpoint — store prompt+result per variant
  if (url === '/api/agent/variants' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      handleVariantSync(body, res);
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Variant read endpoint
  if (url === '/api/agent/variants' && req.method === 'GET') {
    const sid = (req.url.split('?')[1] || '').split('sessionId=')[1] || 'default';
    sendJSON(res, 200, { sessionId: sid, variants: getVariantContext(sid) });
    return;
  }

  // Debug endpoint — inspect extracted constraints for any prompt
  if (url === '/api/agent/constraints' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      handleConstraintExtract(body, res);
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Evolve: save a refinement issue
  if (url === '/api/agent/evolve' && req.method === 'POST') {
    try {
      const body = await readBody(req, res);
      if (body === null) return;  // 413 already sent
      const result = appendEvolveEntry(body);
      EVOLVE_CONSTRAINTS = loadEvolveConstraints();
      console.log(`[Evolve] Saved ${result.id}: "${(body.title || '').substring(0, 50)}" → ${EVOLVE_CONSTRAINTS ? EVOLVE_CONSTRAINTS.length : 0} total constraints`);
      sendJSON(res, 200, { ...result, totalConstraints: EVOLVE_CONSTRAINTS ? EVOLVE_CONSTRAINTS.length : 0 });
    } catch (e) {
      console.error('[Evolve] Error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Evolve: read all entries
  if (url === '/api/agent/evolve' && req.method === 'GET') {
    EVOLVE_CONSTRAINTS = loadEvolveConstraints();
    sendJSON(res, 200, {
      entries: EVOLVE_CONSTRAINTS || [],
      count: EVOLVE_CONSTRAINTS ? EVOLVE_CONSTRAINTS.length : 0
    });
    return;
  }

  if (url === '/api/agent/health') {
    EVOLVE_CONSTRAINTS = loadEvolveConstraints();
    sendJSON(res, 200, {
      status: 'ok',
      model: OPENAI_MODEL,
      mode: 'surface-grammar',
      fallbacks: normalizer.getFallbackStats(),  // cumulative since process start
      designKB: {
        mode: 'surface-grammar',
        designSections: Object.keys(DESIGN_SECTIONS).length,
        genuiSections: Object.keys(GENUI_SECTIONS).length,
        orchSections: Object.keys(ORCH_SECTIONS).length,
        evolveEntries: EVOLVE_CONSTRAINTS ? EVOLVE_CONSTRAINTS.length : 0,
        rawSize: `${((DESIGN_MD_RAW.length + GENUI_MD_RAW.length + ORCH_MD_RAW.length) / 1024).toFixed(1)}KB`,
        constraintFragments: Object.keys(CONSTRAINT_FRAGMENTS).length,
        sourceMode: 'constraint-extraction (DESIGN.md + GENUI-PRINCIPLES.md + ORCHESTRATION.md + evolve.md)'
      }
    });
    return;
  }

  // POST to reset cumulative fallback counters (useful when starting a fresh
  // observation window, e.g. before a batch test). No-op if already zero.
  if (url === '/api/agent/fallbacks/reset' && req.method === 'POST') {
    const before = normalizer.getFallbackStats();
    normalizer.resetFallbackStats();
    sendJSON(res, 200, { ok: true, reset: before });
    return;
  }

  // Static files — decode percent-encoded URLs so non-ASCII filenames (e.g.
  // Korean app-icons like Phone.png → %EC%A0%84%ED%99%94.png) resolve correctly.
  // Two security checks before we hand anything to the filesystem:
  //   1. Containment: the resolved absolute path must stay inside SAFE_ROOT.
  //      Rejects "GET /../../etc/passwd" etc.
  //   2. Dotfile deny: any path segment starting with "." is forbidden,
  //      including the root (".env", ".git/", ".claude/"). Rejects
  //      "GET /.env" which would otherwise leak the OpenAI API key.
  let decodedUrl;
  try { decodedUrl = decodeURIComponent(url); }
  catch (e) { decodedUrl = url; }
  // Convenience aliases for dashboards (extension-less URLs):
  //   /improve   → improve.html   (self-improvement system dashboard)
  //   /customize → customize.html (theme dropdown + live preview)
  let aliasedUrl = decodedUrl;
  if (aliasedUrl === '/improve')   aliasedUrl = '/improve.html';
  if (aliasedUrl === '/customize') aliasedUrl = '/customize.html';
  const requested = aliasedUrl === '/' ? 'genui.html' : aliasedUrl;
  const resolved  = path.resolve(path.join(__dirname, requested));
  if (resolved !== path.resolve(__dirname) && !(resolved + path.sep).startsWith(SAFE_ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const rel = path.relative(__dirname, resolved);
  if (rel.split(path.sep).some(seg => seg.startsWith('.'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  let filePath = resolved;
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return; }
  if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  serveStatic(filePath, res);
});

server.listen(PORT, BIND_HOST, () => {
  console.log('');
  console.log(`  \x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
  console.log(`  \x1b[1m  Samsung GenUI + AI Agent Server\x1b[0m`);
  console.log(`  \x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
  console.log(`  \x1b[32m✓\x1b[0m Running on  http://${BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST}:${PORT}${BIND_HOST === '127.0.0.1' ? '  (loopback-only)' : ''}`);
  console.log(`  \x1b[32m✓\x1b[0m Model       ${OPENAI_MODEL}  \x1b[2m(select)\x1b[0m`);
  if (OPENAI_MODEL_FAST !== OPENAI_MODEL) {
    console.log(`  \x1b[32m✓\x1b[0m Model FAST  ${OPENAI_MODEL_FAST}  \x1b[2m(interpret merged)\x1b[0m`);
  }
  if (OPENAI_MODEL_COMPOSE !== OPENAI_MODEL) {
    console.log(`  \x1b[32m✓\x1b[0m Model COMP  ${OPENAI_MODEL_COMPOSE}  \x1b[2m(compose)\x1b[0m`);
  }
  if (OPENAI_MODEL_EXPLAIN !== OPENAI_MODEL && OPENAI_MODEL_EXPLAIN !== OPENAI_MODEL_FAST) {
    console.log(`  \x1b[32m✓\x1b[0m Model EXPL  ${OPENAI_MODEL_EXPLAIN}  \x1b[2m(explain)\x1b[0m`);
  }
  if (OPENAI_MODEL_CONTENT_BAG !== OPENAI_MODEL) {
    console.log(`  \x1b[32m✓\x1b[0m Model BAG   ${OPENAI_MODEL_CONTENT_BAG}  \x1b[2m(stage 3.5 content bag, parallel)\x1b[0m`);
  }
  console.log(`  \x1b[32m✓\x1b[0m API Key     loaded (***${OPENAI_API_KEY.slice(-4)})`);
  console.log(`  \x1b[32m✓\x1b[0m Design KB   constraint-extraction mode`);
  {
    const ragOn = (process.env.PIPELINE_RAG || 'off').toLowerCase() === 'on';
    const ragK  = parseInt(process.env.PIPELINE_RAG_K || '30', 10);
    console.log(`  \x1b[32m✓\x1b[0m Stage 3 RAG ${ragOn ? `\x1b[33mON\x1b[0m  (top-${ragK} from 92, +~400ms/call)` : 'off  \x1b[2m(default — speed-first; 10-item curated vocab)\x1b[0m'}`);
  }
  console.log(`  \x1b[32m✓\x1b[0m Telemetry   fallback counters enabled${process.env.LOG_FALLBACKS === '1' ? ' (LOG_FALLBACKS=1, stderr)' : ''}`);
  {
    const suite = improvementEngine.getTestSuite();
    const n = suite && suite.scenarios ? suite.scenarios.length : 0;
    // Rehydrate persisted learned rules into pipeline runtime — keeps the
    // self-improving system coherent across restarts. Without this, every
    // accepted rule would evaporate when the server bounces.
    const rehydrated = improvementEngine.rehydrateLearnedRules(pipeline);
    console.log(`  \x1b[32m✓\x1b[0m Improve     test-suite ${n} scenarios · ${rehydrated} learned rules rehydrated → POST /api/improve/cycle`);
  }
  console.log(`  \x1b[32m✓\x1b[0m Limits      body<=${(MAX_BODY_BYTES/1024).toFixed(0)}KB  llm<=${MAX_CONCURRENT_LLM} concurrent / ${MAX_LLM_PER_MIN} per min`);
  console.log(`  \x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
  console.log('');
});
