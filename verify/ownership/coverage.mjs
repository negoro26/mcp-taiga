import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SKILL = '.omp/skills/verify-work-update-ownership/SKILL.md';

const REGIONS = [
  { file: 'src/taiga.ts', name: 'resolveItem' },
  { file: 'src/taiga.ts', name: 'assertWritable' },
  { file: 'src/taiga.ts', name: 'patchItem' },
  { file: 'src/tools/work.ts', name: "op === 'update'" },
];

function closing(source, open) {
  const pair = { '(': ')', '{': '}' }[source[open]];
  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    if (source[i] === source[open]) depth += 1;
    else if (source[i] === pair && --depth === 0) return i;
  }

  return -1;
}

function regionText(source, name) {
  const isUpdate = name.startsWith('op ===');
  const match = isUpdate
    ? { index: source.indexOf(`if (${name}) `) }
    : new RegExp(`function ${name}\\s*(<[^>]*>)?\\(`).exec(source);
  const start = match?.index ?? -1;

  if (start < 0) return null;
  const afterParams = isUpdate ? start : closing(source, source.indexOf('(', start));
  const body = source.indexOf('{', afterParams);

  return source.slice(start, closing(source, body) + 1);
}

const sync = readFileSync(SKILL, 'utf8').match(/^Sync commit: `([0-9a-f]{7,40})`/m)?.[1];

if (!sync) {
  console.error(`No "Sync commit:" line in ${SKILL}.`);
  process.exit(2);
}

const digest = (text) => createHash('sha256').update(text ?? 'MISSING').digest('hex').slice(0, 12);
let stale = 0;

for (const { file, name } of REGIONS) {
  const then = regionText(execFileSync('git', ['show', `${sync}:${file}`], { encoding: 'utf8' }), name);
  const now = regionText(readFileSync(file, 'utf8'), name);
  const same = then !== null && then === now;

  if (!same) stale += 1;
  console.log(`${same ? 'in sync' : 'CHANGED'}  ${file} ${name}  ${digest(then)} -> ${digest(now)}`);
}

if (stale) {
  console.log(`\n${stale} covered region(s) changed since ${sync}. Re-read them against the model before trusting the TLC result.`);
  process.exit(1);
}
