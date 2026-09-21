'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildMuseHistoryGraph,
  buildTokscaleJson,
  collectMuseRows,
  estimatedRowCost,
  museSessionsRoot,
  sessionFiles
} = require('../../src/shared/providers/muse/usage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

// Muse writes recorded_at in microseconds.
const us = (ms) => ms * 1000;

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function metadataRecord(sessionId, { modelId = 'muse-spark-1.3', workspaceRoot = 'C:\\Users\\arda\\proj' } = {}) {
  return {
    schema_version: 1,
    stream: { kind: 'session', id: sessionId },
    sequence: 3,
    recorded_at: us(Date.parse('2026-09-21T08:00:00.000Z')),
    payload_type: 'runtime.session.metadata',
    payload: { kind: 'metadata', record: { workspace_root: workspaceRoot, provider_id: 'meta', model_id: modelId } }
  };
}

function completedRecord(sessionId, { sequence, endedAtMs, durationMs = 0, model = 'muse-spark-1.3', input = 0, output = 0, cached = 0, cacheWrite = 0, reasoning = 0 }) {
  return {
    schema_version: 1,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: us(endedAtMs),
    payload_type: 'runtime.session',
    payload: {
      kind: 'run',
      event: {
        kind: 'model_completed',
        usage: { input_tokens: input, output_tokens: output, cached_tokens: cached, cache_write_tokens: cacheWrite, cache_read_tokens: cached, reasoning_tokens: reasoning },
        duration_ms: durationMs,
        model
      }
    }
  };
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muse-usage-'));
}

test('museSessionsRoot honours XDG_DATA_HOME and defaults to ~/.local/share on every platform', () => {
  assert.equal(
    museSessionsRoot({ homeDir: '/home/u', env: {} }),
    path.join('/home/u', '.local', 'share', 'muse', 'sessions')
  );
  assert.equal(
    museSessionsRoot({ homeDir: '/home/u', env: { XDG_DATA_HOME: '/data' } }),
    path.join('/data', 'muse', 'sessions')
  );
});

test('sessionFiles walks the dated layout, includes subagents and skips .msp-view-v1', () => {
  const root = makeRoot();
  const parent = path.join(root, '2026', '09', '21', 'parent-uuid', 'session.jsonl');
  const child = path.join(root, '2026', '09', '21', 'parent-uuid', 'subagent', 'child-uuid', 'session.jsonl');
  const journal = path.join(root, '.msp-view-v1', 'parent-uuid', 'session.jsonl');
  writeJsonl(parent, []);
  writeJsonl(child, []);
  writeJsonl(journal, []);

  assert.deepEqual(sessionFiles(root).sort(), [parent, child].sort());
});

test('Muse buckets mirror tokscale: cached tokens leave input, reasoning leaves output', () => {
  const root = makeRoot();
  const sessionId = 'parent-uuid';
  writeJsonl(path.join(root, '2026', '09', '21', sessionId, 'session.jsonl'), [
    metadataRecord(sessionId),
    completedRecord(sessionId, { sequence: 45, endedAtMs: Date.parse('2026-09-21T09:00:00.000Z'), durationMs: 3746, input: 26964, output: 103, cached: 16369, reasoning: 85 })
  ]);

  const [row] = collectMuseRows({ roots: [root] });
  assert.equal(row.sessionId, sessionId);
  assert.equal(row.model, 'muse-spark-1.3');
  assert.equal(row.input, 26964 - 16369);
  assert.equal(row.cacheRead, 16369);
  assert.equal(row.output, 103 - 85);
  assert.equal(row.reasoning, 85);
  assert.equal(row.cacheWrite, 0);
  // the call starts duration_ms before recorded_at
  assert.equal(row.createdAt, Date.parse('2026-09-21T09:00:00.000Z') - 3746);

  const usage = extractUsageFromTokscale(buildTokscaleJson({}, { rows: [row] }));
  assert.equal(usage.clients.muse, 26964 + 103);
  assert.equal(usage.models['muse-spark-1.3'], 26964 + 103);
});

test('Muse resolves a subagent\'s "same-as-main" model from its own metadata and dedups replayed sequences', () => {
  const root = makeRoot();
  const childId = 'child-uuid';
  const file = path.join(root, '2026', '09', '21', 'parent-uuid', 'subagent', childId, 'session.jsonl');
  const call = completedRecord(childId, { sequence: 12, endedAtMs: Date.parse('2026-09-21T09:00:00.000Z'), model: 'same-as-main', input: 500, output: 20 });
  writeJsonl(file, [metadataRecord(childId, { modelId: 'muse-spark-1.3' }), call, call]);

  const rows = collectMuseRows({ roots: [root] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'muse-spark-1.3');
});

test('Muse daily window filters per call, so a session that began yesterday still counts today', () => {
  const root = makeRoot();
  const sessionId = 'parent-uuid';
  const todayStart = Date.parse('2026-09-21T00:00:00.000Z');
  writeJsonl(path.join(root, '2026', '09', '20', sessionId, 'session.jsonl'), [
    metadataRecord(sessionId),
    completedRecord(sessionId, { sequence: 10, endedAtMs: todayStart - 60_000, input: 100, output: 1 }),
    completedRecord(sessionId, { sequence: 20, endedAtMs: todayStart + 60_000, input: 40, output: 3 })
  ]);

  const today = extractUsageFromTokscale(buildTokscaleJson({ todayStart }, { roots: [root] }));
  assert.equal(today.clients.muse, 43);
  const month = extractUsageFromTokscale(buildTokscaleJson({ monthStart: Date.parse('2026-09-01T00:00:00.000Z') }, { roots: [root] }));
  assert.equal(month.clients.muse, 144);
});

test('Muse cost falls back to Meta list prices when the catalog has no entry, catalog wins otherwise', () => {
  const row = { model: 'muse-spark-1.3', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, reasoning: 0 };
  assert.ok(Math.abs(estimatedRowCost(row, {}) - (1.25 + 4.25 + 0.15)) < 1e-9);

  const contributor = { ...row, model: 'muse-spark-1.3-contributor' };
  assert.ok(Math.abs(estimatedRowCost(contributor, {}) - (0.10 + 0.20 + 0.002)) < 1e-9);

  const catalog = { 'muse-spark-1.3': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6, cacheReadInputTokenCost: 0.5e-6, cacheCreationInputTokenCost: 1e-6 } };
  assert.ok(Math.abs(estimatedRowCost(row, catalog) - (1 + 2 + 0.5)) < 1e-9);

  assert.equal(estimatedRowCost({ ...row, model: 'some-other-model' }, {}), null);
});

test('Muse history graph places each call on its local start day', () => {
  const endedAt = Date.parse('2026-09-21T09:00:00.000Z');
  const rows = [
    { sessionId: 's', model: 'muse-spark-1.3', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2, createdAt: endedAt, messages: 1 },
    { sessionId: 's', model: 'muse-spark-1.3', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, createdAt: 0, messages: 1 }
  ];
  const graph = buildMuseHistoryGraph({ rows, pricingByModel: {} });
  assert.equal(graph.contributions.length, 1);
  const [day] = graph.contributions;
  assert.equal(day.clients[0].client, 'muse');
  assert.deepEqual(day.clients[0].tokens, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2 });
  assert.equal(day.clients[0].messages, 1);
});
