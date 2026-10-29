import path from 'node:path';
import { DATA, readJson, writeJson } from './paths.js';

// Names people give sessions in AgentsEye. Kept here rather than in the agents' own files, which we never edit.
const file = path.join(DATA, 'names.json');
let names = readJson(file, {});

export const nameOf = (harness, id) => names[`${harness}:${id}`] || '';
export function rename(harness, id, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  names = { ...names };
  if (clean) names[`${harness}:${id}`] = clean; else delete names[`${harness}:${id}`];
  writeJson(file, names);
  return clean;
}
