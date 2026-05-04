#!/usr/bin/env node
// ============================================================================
//  Samsung One UI 8.5 — Design-System Validator (canonical violation schema)
//  ---------------------------------------------------------------------------
//  Inputs
//    figma_extracted.json       raw Figma extraction (frames + nested nodes)
//    global_rules.json          spacing scale, touch target, border min
//    orchestration_rules.json   component-pair gap rules (fromType → toType)
//
//  Output (stdout, JSON via --json)
//    {
//      runId, system, frame?, summary: {total, high, medium, low,
//                                      autoFixable, reviewRequired, semanticReview},
//      violations: [ canonical violation objects ]
//    }
//
//  Usage
//    node figma-refs/validator.js             // human report
//    node figma-refs/validator.js --json      // machine-readable envelope
// ============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FRAMES_PATH = path.join(ROOT, 'figma_extracted.json');
const GLOBAL_PATH = path.join(ROOT, 'global_rules.json');
const PAIR_PATH   = path.join(ROOT, 'orchestration_rules.json');

const RAW_FILE   = 'figma-refs/figma_extracted.json';
const RULE_FILES = {
  spacing_scale_rule: 'figma-refs/global_rules.json',
  touch_target_min:   'figma-refs/global_rules.json',
  border_min:         'figma-refs/global_rules.json',
  pill_radius_token:  'figma-refs/global_rules.json',
  pair_gap:           'figma-refs/orchestration_rules.json'
};

// ----------------------------------------------------------------------------
//  HELPERS
// ----------------------------------------------------------------------------

const loadJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));

function allNearest(value, allowed, within) {
  // Return every allowed value within `within` of `value`, sorted by distance.
  return allowed
    .map(v => ({ v, d: Math.abs(v - value) }))
    .filter(x => x.d <= within)
    .sort((a, b) => a.d - b.d);
}

// Supports two input shapes:
//   flat    → all fields on the node itself
//   dual    → { raw: {...full figma fields}, slim: {...slim validator fields}, children }
// The slim section drives layout checks; the raw section supplies nodeId,
// cornerRadius, radiusToken, borderWidth for semantic/consistency checks.
function normalizeElement(el) {
  const raw  = el.raw  || {};
  const slim = el.slim || el;

  const padding = {};
  // Dual-shape nested padding (slim.padding.{left,...}) OR flat padding{Left,...}
  const pSlim = slim.padding || {};
  if (typeof pSlim.left   === 'number') padding.left   = pSlim.left;
  if (typeof pSlim.right  === 'number') padding.right  = pSlim.right;
  if (typeof pSlim.top    === 'number') padding.top    = pSlim.top;
  if (typeof pSlim.bottom === 'number') padding.bottom = pSlim.bottom;
  if (typeof slim.paddingLeft   === 'number') padding.left   = slim.paddingLeft;
  if (typeof slim.paddingRight  === 'number') padding.right  = slim.paddingRight;
  if (typeof slim.paddingTop    === 'number') padding.top    = slim.paddingTop;
  if (typeof slim.paddingBottom === 'number') padding.bottom = slim.paddingBottom;

  return {
    frame: slim.frame || raw.frame || el.frame,
    name: slim.name || raw.name,
    nodeId: raw.nodeId || raw.node_id || raw.id || slim.nodeId || el.nodeId || null,
    type: slim.type || raw.type,
    width: slim.width ?? raw.width,
    height: slim.height ?? raw.height,
    gap: slim.gap ?? raw.gap,
    itemSpacing: slim.itemSpacing ?? raw.itemSpacing,
    padding: Object.keys(padding).length ? padding : undefined,
    // Semantic / consistency signals (raw-side only)
    cornerRadius: typeof raw.cornerRadius === 'number' ? raw.cornerRadius : undefined,
    radiusToken: raw.radiusToken || slim.radiusToken,
    borderWidth: typeof raw.borderWidth === 'number' ? raw.borderWidth
                 : typeof slim.borderWidth === 'number' ? slim.borderWidth : undefined,
    interactive: inferInteractive(slim) || inferInteractive(raw),
    inferredType: inferType(slim.name || raw.name || ''),
    children: el.children || slim.children || raw.children || []
  };
}

// Flatten a tree. `inheritedFrame` propagates the top-level frame name down
// to every descendant (dual schema stores `frame` only on the root frame).
function flatten(node, acc = [], inheritedFrame = null) {
  const norm = normalizeElement(node);
  if (!norm.frame && inheritedFrame) norm.frame = inheritedFrame;
  acc.push(norm);
  const f = norm.frame || inheritedFrame;
  for (const child of norm.children) flatten(child, acc, f);
  return acc;
}

const INTERACTIVE_KEYWORDS = [
  'button', 'btn', 'toggle', 'switch', 'chip', 'fab',
  'shortcut', 'action', 'tab', 'link', 'menu item', 'close',
  'search', 'input', 'slider thumb', 'checkbox', 'radio'
];
function inferInteractive(el) {
  if (el.interactive === true) return true;
  const n = (el.name || '').toLowerCase();
  return INTERACTIVE_KEYWORDS.some(k => n.includes(k));
}

const TYPE_MAP = [
  [/card/i, 'card'], [/toggle|switch/i, 'qs-toggle'], [/slider/i, 'slider'],
  [/chip/i, 'chip'], [/status\s*bar/i, 'status-bar'],
  [/appbar|app\s*bar/i, 'appbar'], [/now\s*bar/i, 'now-bar'],
  [/bottom\s*nav|navbar|nav\s*bar/i, 'bottomnav'], [/dock/i, 'dock'],
  [/fab/i, 'fab'], [/dialog/i, 'dialog'], [/snackbar/i, 'snackbar'],
  [/notification/i, 'notification-card'], [/media/i, 'media-card'],
  [/search/i, 'search-bar'], [/tab\s*bar/i, 'tab-bar'],
  [/header|title/i, 'section-header'], [/list\s*item/i, 'list-item'],
  [/button|btn/i, 'button'], [/input|field/i, 'input'],
  [/widget/i, 'widget'], [/icon\s*grid|app\s*grid/i, 'icon-grid'],
  [/group|wrapper/i, 'group-wrapper']
];
function inferType(name) {
  for (const [re, t] of TYPE_MAP) if (re.test(name)) return t;
  return 'content';
}

// ----------------------------------------------------------------------------
//  VIOLATION BUILDER — canonical schema
// ----------------------------------------------------------------------------
//
//  Status rules:
//    auto-fixable    expected is a single concrete value; delta defined;
//                    autoFix.possible=true; needsReview=false
//    review-required multiple expected candidates (array) OR pair context
//                    matters; needsReview=true; autoFix.possible=false
//    semantic-review numeric value stands in for a token (e.g. pill radius);
//                    autoFix.possible=true with action=replace-token
//
function buildViolation({
  id, element, property, ruleId, category, severity,
  actual, expected, delta,
  message, autoFix, status, reviewReason
}) {
  const out = {
    id,
    frame: element.frame,
    element: element.name,
    nodeId: element.nodeId || null,
    property,
    ruleId,
    category,
    severity,
    status,
    actual,
    expected,
    delta: delta === undefined ? null : delta,
    message,
    autoFix: autoFix || { possible: false, action: null, value: null },
    needsReview: status !== 'auto-fixable',
    source: { rawFile: RAW_FILE, ruleFile: RULE_FILES[ruleId] || null }
  };
  if (reviewReason) out.reviewReason = reviewReason;
  return out;
}

// ----------------------------------------------------------------------------
//  VALIDATORS
// ----------------------------------------------------------------------------

function validateSpacingScale(element, rule, idGen) {
  const violations = [];
  const { allowedValues, snapWithin = 3, severity = 'medium' } = rule;
  const fields = [];
  if (typeof element.gap         === 'number') fields.push({ p: 'gap',         v: element.gap });
  if (typeof element.itemSpacing === 'number') fields.push({ p: 'itemSpacing', v: element.itemSpacing });
  if (element.padding) {
    for (const [side, val] of Object.entries(element.padding)) {
      if (typeof val === 'number') fields.push({ p: `padding.${side}`, v: val });
    }
  }

  for (const { p, v } of fields) {
    if (allowedValues.includes(v)) continue;

    const near = allNearest(v, allowedValues, snapWithin);
    // No candidates within snapWithin → reviewable off-grid
    if (near.length === 0) {
      violations.push(buildViolation({
        id: idGen(),
        element, property: p,
        ruleId: 'spacing_scale_rule', category: 'spacing', severity,
        actual: v,
        expected: null,
        delta: null,
        message: `${p} ${v} is off the approved spacing scale and outside snap tolerance.`,
        autoFix: { possible: false, action: null, value: null },
        status: 'review-required',
        reviewReason: 'value too far from any approved token — manual redesign needed'
      }));
      continue;
    }

    // One clear closest candidate → auto-fixable snap
    const uniqDistances = [...new Set(near.map(n => n.d))];
    const equidistant   = near.filter(n => n.d === near[0].d);

    if (equidistant.length === 1) {
      const target = equidistant[0].v;
      violations.push(buildViolation({
        id: idGen(),
        element, property: p,
        ruleId: 'spacing_scale_rule', category: 'spacing', severity,
        actual: v,
        expected: target,
        delta: target - v,
        message: `${p} ${v} is off the approved spacing scale.`,
        autoFix: { possible: true, action: 'snap', value: target },
        status: 'auto-fixable'
      }));
    } else {
      // Two or more equally-close candidates (e.g. 10 → [8, 12]) → review-required
      const options = equidistant.map(n => n.v).sort((a, b) => a - b);
      violations.push(buildViolation({
        id: idGen(),
        element, property: p,
        ruleId: 'spacing_scale_rule', category: 'spacing', severity,
        actual: v,
        expected: options,
        delta: null,
        message: `${p} ${v} is outside the approved spacing scale and needs normalization.`,
        autoFix: { possible: false, action: null, value: null },
        status: 'review-required',
        reviewReason: `Nearest valid tokens are ${options.join(' and ')}; semantic grouping must determine which one fits.`
      }));
    }
  }
  return violations;
}

function validateTouchTarget(element, rule, idGen) {
  const violations = [];
  const { min = 48, severity = 'high' } = rule;
  if (!element.interactive) return violations;
  if (typeof element.width !== 'number' || typeof element.height !== 'number') return violations;
  if (element.width >= min && element.height >= min) return violations;

  const target = { width: Math.max(element.width, min), height: Math.max(element.height, min) };
  violations.push(buildViolation({
    id: idGen(),
    element, property: 'size',
    ruleId: 'touch_target_min', category: 'touch-target', severity,
    actual:   { width: element.width, height: element.height },
    expected: { minWidth: min, minHeight: min },
    delta: { width: target.width - element.width, height: target.height - element.height },
    message: 'Interactive element is below the minimum 48dp touch target.',
    autoFix: { possible: true, action: 'expand-hit-area', value: target },
    status: 'auto-fixable'
  }));
  return violations;
}

function validateBorderMin(element, rule, idGen) {
  const violations = [];
  const { min = 0.5, severity = 'medium' } = rule;
  if (typeof element.borderWidth !== 'number' || element.borderWidth >= min) return violations;
  violations.push(buildViolation({
    id: idGen(),
    element, property: 'stroke.width',
    ruleId: 'border_min', category: 'consistency', severity,
    actual: element.borderWidth,
    expected: min,
    delta: min - element.borderWidth,
    message: `Border width below ${min}px may render inconsistently across pixel densities.`,
    autoFix: { possible: true, action: 'snap', value: min },
    status: 'auto-fixable'
  }));
  return violations;
}

function validatePillRadius(element, rule, idGen) {
  if (element.cornerRadius == null || element.height == null) return [];
  const behavesLikePill = element.cornerRadius >= element.height / 2;
  if (!behavesLikePill) return [];
  if (element.radiusToken === 'pill') return [];

  const severity = rule.severity || 'medium';
  return [buildViolation({
    id: idGen(),
    element, property: 'cornerRadius',
    ruleId: 'pill_radius_token', category: 'radius', severity,
    actual: element.cornerRadius,
    expected: 'pill',
    delta: null,
    message: 'Radius behaves like a pill but is not represented with the pill token.',
    autoFix: { possible: true, action: 'replace-token', value: 'pill' },
    status: 'semantic-review',
    reviewReason: 'numeric radius matches pill behaviour (>= height/2); confirm shape intent before swapping to token.'
  })];
}

function validatePairGap(container, pairRules, idGen) {
  const violations = [];
  if (!Array.isArray(container.children) || container.children.length < 2) return violations;
  const spacing = container.itemSpacing ?? container.gap;
  if (typeof spacing !== 'number') return violations;

  for (let i = 0; i < container.children.length - 1; i++) {
    const fromType = inferType(container.children[i].name || '');
    const toType   = inferType(container.children[i + 1].name || '');
    const match = pairRules.find(r => r.fromType === fromType && r.toType === toType)
               || pairRules.find(r => r.fromType === fromType && r.toType === 'content');
    if (!match) continue;

    const diff = Math.abs(spacing - match.expectedGap);
    if (diff <= (match.tolerance ?? 2)) continue;

    violations.push(buildViolation({
      id: idGen(),
      element: container, property: 'itemSpacing',
      ruleId: match.id, category: 'pair-gap',
      severity: match.severity || 'medium',
      actual: spacing,
      expected: match.expectedGap,
      delta: match.expectedGap - spacing,
      message: `${fromType} → ${toType} itemSpacing ${spacing} does not match rule ${match.id}.`,
      autoFix: { possible: false, action: null, value: null },
      status: 'review-required',
      reviewReason: `${fromType}→${toType} spacing is context-dependent (expected ${match.expectedGap}±${match.tolerance ?? 2}dp); confirm grouping intent before changing.`
    }));
  }
  return violations;
}

// ----------------------------------------------------------------------------
//  RUNNER
// ----------------------------------------------------------------------------

function runValidators(frames, globalRules, pairRules) {
  const violations = [];
  let counter = 0;
  const idGen = () => 'V-' + String(++counter).padStart(4, '0');
  const elements = frames.flatMap(f => flatten(f));

  for (const el of elements) {
    for (const rule of globalRules) {
      if (rule.id === 'spacing_scale_rule') violations.push(...validateSpacingScale(el, rule, idGen));
      if (rule.id === 'touch_target_min')   violations.push(...validateTouchTarget(el, rule, idGen));
      if (rule.id === 'border_min')         violations.push(...validateBorderMin(el, rule, idGen));
      if (rule.id === 'pill_radius_token')  violations.push(...validatePillRadius(el, rule, idGen));
    }
    violations.push(...validatePairGap(el, pairRules, idGen));
  }
  return violations;
}

function summarize(violations) {
  const s = { total: violations.length,
              high: 0, medium: 0, low: 0,
              autoFixable: 0, reviewRequired: 0, semanticReview: 0 };
  for (const v of violations) {
    if (s[v.severity] !== undefined) s[v.severity] += 1;
    if (v.status === 'auto-fixable')    s.autoFixable    += 1;
    if (v.status === 'review-required') s.reviewRequired += 1;
    if (v.status === 'semantic-review') s.semanticReview += 1;
  }
  return s;
}

function buildEnvelope(violations, scopeFrame = null) {
  return {
    runId: new Date().toISOString(),
    system: 'oneui-layout-validator',
    ...(scopeFrame ? { frame: scopeFrame } : {}),
    summary: summarize(violations),
    violations
  };
}

// ----------------------------------------------------------------------------
//  MAIN
// ----------------------------------------------------------------------------

function main() {
  const asJSON = process.argv.includes('--json');
  const frames      = loadJSON(FRAMES_PATH);
  const globalRules = loadJSON(GLOBAL_PATH).rules;
  const pairRules   = loadJSON(PAIR_PATH).rules;

  const violations = runValidators(frames, globalRules, pairRules);
  const envelope   = buildEnvelope(violations);

  if (asJSON) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  const s = envelope.summary;
  console.log('=== One UI 8.5 Validator ===');
  console.log(`runId          : ${envelope.runId}`);
  console.log(`frames checked : ${frames.length}`);
  console.log(`total          : ${s.total}`);
  console.log(`  severity     : high=${s.high}  medium=${s.medium}  low=${s.low}`);
  console.log(`  status       : auto-fixable=${s.autoFixable}  review-required=${s.reviewRequired}  semantic-review=${s.semanticReview}`);
  console.log('');
  for (const v of violations.slice(0, 20)) {
    const act = typeof v.actual === 'object' ? JSON.stringify(v.actual) : v.actual;
    const exp = Array.isArray(v.expected) ? `[${v.expected.join(',')}]`
              : typeof v.expected === 'object' && v.expected ? JSON.stringify(v.expected)
              : v.expected;
    console.log(`  ${v.id}  ${v.severity.toUpperCase().padEnd(6)} ${v.status.padEnd(15)} [${v.frame}] ${v.element} · ${v.property}  ${act} → ${exp}`);
  }
  if (violations.length > 20) console.log(`  … ${violations.length - 20} more (use --json for full list)`);
}

if (require.main === module) main();

module.exports = {
  runValidators, buildEnvelope, summarize,
  validateSpacingScale, validateTouchTarget, validateBorderMin,
  validatePillRadius, validatePairGap,
  flatten, inferType, allNearest
};
