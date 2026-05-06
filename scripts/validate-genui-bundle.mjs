#!/usr/bin/env node
/**
 * Shallow structural validation for GenUI v1 bundles (no ajv dependency).
 * Usage: node scripts/validate-genui-bundle.mjs path/to/bundle.json
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/validate-genui-bundle.mjs <bundle.json>');
  process.exit(2);
}

const abs = path.resolve(process.cwd(), file);
let raw;
try {
  raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
} catch (e) {
  console.error('Invalid JSON:', e.message);
  process.exit(1);
}

const errors = [];
if (!raw || typeof raw !== 'object') errors.push('root must be object');
if (String(raw.genuiBundleVersion || '') !== '1') {
  errors.push('genuiBundleVersion must be "1"');
}
const okKinds = new Set(['pipelineResult', 'designDoc', 'themeOnly', 'composed', '']);
if (raw.kind != null && raw.kind !== '' && !okKinds.has(raw.kind)) {
  errors.push('kind must be one of: pipelineResult, designDoc, themeOnly, composed');
}

function checkNodes(arr, label) {
  if (!Array.isArray(arr)) return;
  arr.forEach((n, i) => {
    if (!n || typeof n !== 'object') errors.push(`${label}[${i}] must be object`);
    else {
      if (typeof n.id !== 'string' || !n.id) errors.push(`${label}[${i}].id required string`);
      if (typeof n.role !== 'string' || !n.role) errors.push(`${label}[${i}].role required string`);
    }
  });
}

checkNodes(raw.nodes, 'nodes');
if (raw.designDoc && Array.isArray(raw.designDoc.nodes)) {
  checkNodes(raw.designDoc.nodes, 'designDoc.nodes');
}

if (errors.length) {
  console.error('Validation failed:');
  errors.forEach((e) => console.error('  -', e));
  process.exit(1);
}

console.log('OK:', pathToFileURL(abs).href);
