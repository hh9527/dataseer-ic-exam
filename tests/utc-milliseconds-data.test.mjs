import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generate as ic, loadModel as icModel } from '../data/ic/generate.mjs';

const temporary = mkdtempSync(join(process.env.TMPDIR || join(homedir(), '.cache/tmp'), 'utc-ms-data-'));
try {
  for (const [name, generate, model, table] of [
    ['icloud', ic, icModel(), 'NetworkDeviceKPI'],
  ]) {
    const output = join(temporary, name);
    generate({output,seed:20261031,resources:12,days:1,intervalMinutes:360,anchor:'2026-10-31T12:00:00.123Z'}, model);
    const db = new DatabaseSync(join(output, name + '.sqlite'));
    try {
      const values = db.prepare(`SELECT ts AS value FROM "${table}" ORDER BY ts`).all().map(row => row.value);
      assert.ok(values.length > 0);
      assert.ok(values.every(value => /\.\d{3}Z$/.test(value)), name + ': fixed millisecond precision');
      assert.ok(values.some(value => /\.123Z$/.test(value)), name + ': fractional anchor survives at sampling boundaries');
      assert.deepEqual(values, [...values].sort((a,b) => Date.parse(a)-Date.parse(b)));
    } finally { db.close(); }
  }
  console.log('IC data: fixed millisecond text, fractional anchors and chronological lexical order passed');
} finally { rmSync(temporary,{recursive:true,force:true}); }
