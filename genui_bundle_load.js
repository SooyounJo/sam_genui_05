'use strict';

/**
 * Load a persisted GenUI bundle and re-apply schema_normalizer to embedded
 * pipeline slices so snake_case / partial LLM shapes become camelCase canon.
 * Browser: use DesignDoc.hydrateFromPipelineBundle only; this module is Node.
 */
const normalizer = require('./schema_normalizer');

function _normPlanSlice(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const out = Object.assign({}, plan);
  if (Array.isArray(plan.requiredComponents)) {
    const sel = normalizer.normalizeSelectorOutput({
      requiredComponents: plan.requiredComponents,
      plannerNotes: plan.plannerNotes || {}
    });
    out.requiredComponents = sel.requiredComponents;
    out.plannerNotes = sel.plannerNotes;
  }
  return out;
}

function _normLayoutSlice(layoutPlan) {
  if (!layoutPlan || typeof layoutPlan !== 'object') return layoutPlan;
  return normalizer.normalizeComposerOutput({ layoutPlan: layoutPlan }).layoutPlan;
}

/**
 * @param {object} raw — parsed JSON bundle
 * @returns {object} bundle with normalized plan / layoutPlan when present
 */
function normalizePersistedBundle(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const b = Object.assign({}, raw);
  if (b.plan) b.plan = _normPlanSlice(b.plan);
  if (b.layoutPlan) b.layoutPlan = _normLayoutSlice(b.layoutPlan);
  return b;
}

module.exports = {
  normalizePersistedBundle,
  _normPlanSlice,
  _normLayoutSlice
};
