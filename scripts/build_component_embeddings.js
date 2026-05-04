#!/usr/bin/env node
// ============================================================================
//  build_component_embeddings.js
//  ----------------------------------------------------------------------------
//  Pre-computes OpenAI embeddings for every component in
//  figma-refs/component_registry.json and writes the result to
//  figma-refs/component_embeddings.json.
//
//  Used by the Stage 3 (select) RAG shortlist: at runtime, the pipeline embeds
//  the user scenario, takes top-K by cosine similarity, and feeds only that
//  shortlist to the planner LLM — instead of pasting all 92 component
//  descriptions into every prompt.
//
//  Cache strategy:
//    Each component's source text is hashed (SHA-256). If the existing
//    embeddings file contains the same hash for a component, its embedding is
//    reused. Only components whose source text changed (or are new) are
//    re-embedded. Run cost is ~$0.001 for the full set; incremental runs are
//    near-free.
//
//  Usage:   node scripts/build_component_embeddings.js
//           node scripts/build_component_embeddings.js --force   # re-embed all
//
//  Output schema (figma-refs/component_embeddings.json):
//    {
//      "model": "text-embedding-3-small",
//      "dim":   1536,
//      "built_at": "<ISO>",
//      "components": {
//        "<id>": {
//          "hash":      "<sha256 of source text>",
//          "text":      "<source text used for embedding>",
//          "embedding": [<1536 floats>]
//        },
//        ...
//      }
//    }
// ============================================================================

'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env so OPENAI_API_KEY is available when run standalone.
// Inline parser — mirrors server.js (no dotenv dep).
(function _loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const [key, ...vals] = trimmed.split('=');
      if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
    });
  } catch (e) { /* ignore */ }
})();

const REGISTRY_PATH   = path.join(__dirname, '..', 'figma-refs', 'component_registry.json');
const EMBEDDINGS_PATH = path.join(__dirname, '..', 'figma-refs', 'component_embeddings.json');
const EMBED_MODEL     = 'text-embedding-3-small';
const EMBED_DIM       = 1536;

const FORCE_REBUILD = process.argv.includes('--force');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('[embed] OPENAI_API_KEY not set in .env'); process.exit(1);
}

// ---------------------------------------------------------------------------
//  Source-text composition: combine every signal the LLM uses for selection
//  into one dense paragraph per component. The richer this text, the better
//  the cosine-similarity retrieval for novel scenarios.
// ---------------------------------------------------------------------------
function buildSourceText(id, c) {
  const parts = [];
  parts.push(`id: ${id}`);
  if (c.category) parts.push(`category: ${c.category}`);
  if (c.description) parts.push(`description: ${c.description}`);
  if (c.purpose)     parts.push(`purpose: ${c.purpose}`);
  if (c.use_when) {
    const uw = Array.isArray(c.use_when) ? c.use_when.join('; ') : String(c.use_when);
    parts.push(`use_when: ${uw}`);
  }
  if (c.dont_use_when) {
    const dw = Array.isArray(c.dont_use_when) ? c.dont_use_when.join('; ') : String(c.dont_use_when);
    parts.push(`dont_use_when: ${dw}`);
  }
  if (Array.isArray(c.states) && c.states.length) {
    parts.push(`states: ${c.states.join(', ')}`);
  }
  if (Array.isArray(c.allowed_contexts) && c.allowed_contexts.length) {
    parts.push(`contexts: ${c.allowed_contexts.join(', ')}`);
  }
  // Typical content examples — short scenario+copy pairs that give the
  // embedding strong situational anchors.
  const tc = c && c.typical_content;
  if (tc && Array.isArray(tc.examples) && tc.examples.length) {
    const ex = tc.examples.slice(0, 5).map(e => {
      const scn = e.scenario ? e.scenario : '';
      const lbl = e.label || '';
      const val = e.value || '';
      return `- ${scn}: ${lbl} / ${val}`;
    });
    parts.push('typical_content:\n' + ex.join('\n'));
    if (tc.guidance) parts.push(`guidance: ${tc.guidance}`);
  }
  return parts.join('\n');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function callEmbeddings(inputs) {
  const url = 'https://api.openai.com/v1/embeddings';
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`embeddings HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------
(async () => {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error('[embed] component_registry.json not found:', REGISTRY_PATH);
    process.exit(1);
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  if (!registry.components) {
    console.error('[embed] registry.components missing'); process.exit(1);
  }

  // Embed the FULL allowed_types set (92), not just the curated semantic_10.
  // The Stage 3 RAG retriever needs all 92 in the index so it can shortlist
  // any of them based on cosine similarity to the user scenario. The 10
  // legacy "semantic" types remain accessible — they're a strict subset of
  // the 92.
  const allowed = (registry.vocabulary && registry.vocabulary.allowed_types)
               || Object.keys(registry.components);

  // Existing cache (if any)
  let existing = { components: {} };
  if (fs.existsSync(EMBEDDINGS_PATH) && !FORCE_REBUILD) {
    try {
      existing = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, 'utf8'));
      if (!existing.components) existing.components = {};
    } catch (e) {
      console.warn('[embed] existing cache unreadable, rebuilding:', e.message);
      existing = { components: {} };
    }
  }

  const out = { components: {} };
  const toEmbed = [];   // { id, text }
  let reused = 0;

  for (const id of allowed) {
    const c = registry.components[id];
    if (!c) continue;
    const text = buildSourceText(id, c);
    const hash = sha256(text);
    const prev = existing.components[id];
    if (prev && prev.hash === hash && Array.isArray(prev.embedding) && prev.embedding.length === EMBED_DIM) {
      out.components[id] = prev;
      reused += 1;
    } else {
      toEmbed.push({ id, text, hash });
    }
  }

  console.log(`[embed] ${reused} reused from cache, ${toEmbed.length} to embed`);

  // Batch the embedding calls — OpenAI accepts up to 2048 inputs per request,
  // but we keep batches small (32) so a single failure doesn't blow the whole
  // run, and so progress logs make sense.
  const BATCH = 32;
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const batch = toEmbed.slice(i, i + BATCH);
    const inputs = batch.map(b => b.text);
    process.stdout.write(`[embed] batch ${i / BATCH + 1}/${Math.ceil(toEmbed.length / BATCH)} (${batch.length} items) ... `);
    try {
      const vectors = await callEmbeddings(inputs);
      batch.forEach((b, idx) => {
        out.components[b.id] = {
          hash:      b.hash,
          text:      b.text,
          embedding: vectors[idx]
        };
      });
      console.log('ok');
    } catch (e) {
      console.log('FAIL');
      console.error(e);
      process.exit(2);
    }
  }

  const result = {
    model:    EMBED_MODEL,
    dim:      EMBED_DIM,
    built_at: new Date().toISOString(),
    components: out.components
  };

  fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify(result, null, 2));
  const total = Object.keys(out.components).length;
  console.log(`[embed] wrote ${EMBEDDINGS_PATH}  (${total} components, ${EMBED_DIM} dims)`);
})().catch(e => { console.error('[embed] FATAL', e); process.exit(1); });
