'use strict';

/**
 * Muse Code session usage parser.
 *
 * Muse Code (Meta's CLI coding agent) writes one event-sourced transcript per
 * session under <XDG data>/muse/sessions/YYYY/MM/DD/<session-uuid>/session.jsonl
 * — the same XDG-style path on every platform, Windows included
 * (~/.local/share). Subagent runs log to subagent/<child-uuid>/session.jsonl
 * beside the parent transcript and are picked up by the same recursive walk.
 *
 * Usage rides only on `payload_type: "runtime.session"` records whose
 * payload.event.kind is "model_completed"; their `usage` is Responses-shaped:
 *
 *   {"recorded_at": 1790018558565806, "sequence": 45,
 *    "stream": {"kind": "session", "id": "<session-uuid>"},
 *    "payload_type": "runtime.session",
 *    "payload": {"kind": "run", "event": {"kind": "model_completed",
 *      "usage": {"input_tokens": 26964, "output_tokens": 103, "cached_tokens": 16369,
 *                "cache_write_tokens": 0, "cache_read_tokens": 16369, "reasoning_tokens": 85},
 *      "duration_ms": 3746, "model": "muse-spark-1.3"}}}
 *
 * The bucket arithmetic mirrors tokscale's parser
 * (crates/tokscale-core/src/sessions/muse.rs) so the numbers agree once the
 * vendored tokscale learns the client:
 *   - cached_tokens / cache_read_tokens are a *subset* of input_tokens (Meta's
 *     prompt-caching docs), so they are removed from input rather than billed
 *     twice;
 *   - reasoning_tokens ride inside output_tokens and are split out the same way;
 *   - recorded_at (microseconds) is the call's end; the start is back-anchored
 *     by duration_ms so a call that straddles midnight lands on the day it
 *     started;
 *   - the record `sequence` dedups a replayed event.
 * The parent session also logs workflow-child usage aggregates; those duplicate
 * the child's own subagent transcript, so only model_completed events count.
 *
 * Returns data shaped like a tokscale JSON response so it can be fed to
 * extractUsageFromTokscale or merged alongside tokscale results.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SESSION_FILE_NAME = 'session.jsonl';
const USAGE_EVENT_KIND = 'model_completed';
const METADATA_PAYLOAD_TYPE = 'runtime.session.metadata';
// A subagent transcript names its model "same-as-main"; the file's own
// metadata record carries the resolved id.
const INHERITED_MODEL_ALIAS = 'same-as-main';
const DEFAULT_MODEL_ID = 'muse-spark';
// YYYY/MM/DD/<uuid>/subagent/<uuid>/session.jsonl is the deepest documented layout.
const MAX_WALK_DEPTH = 8;

// Meta's published Muse Spark rates (USD per token, 2026-09): the Standard tier
// and the Contributor tier the CLI reports as a `-contributor` model suffix.
// Cache writes are not billed separately (cached tokens are a subset of input),
// so they carry the input rate. Used only when tokscale's pricing catalog has
// no entry for the model — a catalog price always wins.
const MUSE_FALLBACK_PRICING = Object.freeze({
  standard: Object.freeze({
    inputCostPerToken: 1.25e-6,
    outputCostPerToken: 4.25e-6,
    cacheReadInputTokenCost: 0.15e-6,
    cacheCreationInputTokenCost: 1.25e-6
  }),
  contributor: Object.freeze({
    inputCostPerToken: 0.10e-6,
    outputCostPerToken: 0.20e-6,
    cacheReadInputTokenCost: 0.002e-6,
    cacheCreationInputTokenCost: 0.10e-6
  })
});

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizedModelId(value) {
  return cleanText(value).toLowerCase();
}

/** Where Muse keeps its sessions: $XDG_DATA_HOME or ~/.local/share on every platform. */
function museSessionsRoot(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const dataHome = cleanText(env.XDG_DATA_HOME) || path.join(homeDir, '.local', 'share');
  return path.join(dataHome, 'muse', 'sessions');
}

// Muse's recorded_at is microseconds today; accept milliseconds and seconds so a
// schema change cannot land usage in 1970 or the far future.
function recordedAtToMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1e15) return Math.floor(n / 1000);
  if (n >= 1e12) return Math.floor(n);
  if (n >= 1e9) return Math.floor(n * 1000);
  return 0;
}

function fallbackPricingFor(modelId) {
  if (!normalizedModelId(modelId).startsWith('muse-spark')) return null;
  return /contributor/.test(normalizedModelId(modelId))
    ? MUSE_FALLBACK_PRICING.contributor
    : MUSE_FALLBACK_PRICING.standard;
}

// Cost is an estimate from a model-price catalog, never a provider invoice.
// Reasoning is priced at the output rate, as tokscale does. Return null rather
// than silently undercount when a rate is unavailable.
function estimatedRowCost(row, pricingByModel) {
  const modelId = normalizedModelId(row.model);
  const pricing = pricingByModel?.[modelId] || fallbackPricingFor(modelId);
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output + row.reasoning, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function tokensFromUsage(usage) {
  const reportedInput = numberValue(usage.input_tokens);
  const reportedOutput = numberValue(usage.output_tokens);
  const cacheRead = Math.min(
    numberValue(usage.cache_read_tokens) || numberValue(usage.cached_tokens),
    reportedInput
  );
  const reasoning = Math.min(numberValue(usage.reasoning_tokens), reportedOutput);
  return {
    input: reportedInput - cacheRead,
    output: reportedOutput - reasoning,
    cacheRead,
    cacheWrite: numberValue(usage.cache_write_tokens),
    reasoning
  };
}

function rowTotal(row) {
  return row.input + row.output + row.cacheRead + row.cacheWrite + row.reasoning;
}

/** Parse one session.jsonl into per-call usage rows. */
function collectSessionRows(filePath) {
  const content = String(fs.readFileSync(filePath, 'utf8') || '');
  const lines = content.split(/\r?\n/);
  const pathSessionId = path.basename(path.dirname(filePath)) || 'unknown';
  const rows = [];
  const seen = new Set();
  let metadataModel = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    // Transcripts are multi-MB and mostly tool/text payloads; the parsed
    // fields below make the real decision, this only skips the JSON.parse.
    if (!line || (!line.includes(USAGE_EVENT_KIND) && !line.includes(METADATA_PAYLOAD_TYPE))) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue; // skip malformed lines
    }
    if (!record || typeof record !== 'object') continue;

    if (record.payload_type === METADATA_PAYLOAD_TYPE) {
      if (!metadataModel) metadataModel = normalizedModelId(record.payload?.record?.model_id);
      continue;
    }

    const event = record.payload?.event;
    if (!event || event.kind !== USAGE_EVENT_KIND || !event.usage || typeof event.usage !== 'object') continue;

    const tokens = tokensFromUsage(event.usage);
    if (rowTotal(tokens) === 0) continue;

    let model = normalizedModelId(event.model);
    if (!model || model === INHERITED_MODEL_ALIAS) model = metadataModel || DEFAULT_MODEL_ID;

    const endedAt = recordedAtToMs(record.recorded_at);
    const durationMs = numberValue(event.duration_ms);
    // Back-anchor to the call's start only from an explicit end stamp, never
    // from a file-mtime fallback that would shift the row into the wrong day.
    const createdAt = endedAt ? Math.max(0, endedAt - durationMs) : 0;

    const sessionId = cleanText(record.stream?.id) || pathSessionId;
    const ordinal = Number.isFinite(Number(record.sequence)) ? String(record.sequence) : `line-${index}`;
    const dedupKey = `${sessionId}:${ordinal}:${model}:${tokens.input}:${tokens.output}:${tokens.cacheRead}:${tokens.cacheWrite}:${tokens.reasoning}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    rows.push({ sessionId, model, ...tokens, createdAt, durationMs, messages: 1 });
  }
  return rows;
}

function sessionFiles(root, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    // .msp-view-v1/ holds Muse's binary view journals, never transcripts.
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_WALK_DEPTH) files.push(...sessionFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name === SESSION_FILE_NAME) {
      files.push(full);
    }
  }
  return files;
}

// Read every session exactly once per collection tick. The caller then derives
// several windows (and history) from the same snapshot rather than reopening
// every transcript once per period.
function collectMuseRows(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : [museSessionsRoot(options)];
  const rows = [];
  for (const root of roots) {
    for (const filePath of sessionFiles(root)) {
      try {
        rows.push(...collectSessionRows(filePath));
      } catch (_) {
        // skip unreadable files
      }
    }
  }
  return rows;
}

function timestampMs(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function windowStartMs(windows) {
  return Math.max(0, timestampMs(windows.todayStart), timestampMs(windows.monthStart), timestampMs(windows.allTimeSince));
}

/**
 * Build a tokscale-compatible JSON object from Muse session rows.
 *
 * @param {{ todayStart?: number, monthStart?: number, allTimeSince?: number }} windows
 *        Unix timestamps (ms) for period boundaries.
 */
function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0, allOutput = 0, allCacheRead = 0, allCacheWrite = 0, allMessages = 0, allCost = 0;

  // Filter per call, not per aggregated session: a session that began before
  // midnight must still contribute today's calls.
  const allRows = (Array.isArray(options.rows) ? options.rows : collectMuseRows(options))
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });

  // Keep the transcript's stable session id while aggregating calls by model;
  // extractUsageFromTokscale() merges the model rows of one session together.
  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId || 'unknown'} ${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId || 'unknown', model: row.model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        messages: 0, cost: 0, startedAt: 0, lastUsedAt: 0
      });
    }
    const m = bySessionModel.get(key);
    const cost = estimatedRowCost(row, options.pricingByModel);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.reasoning += row.reasoning;
    m.messages += Number(row.messages || 1);
    m.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!m.startedAt || row.createdAt < m.startedAt)) m.startedAt = row.createdAt;
    if (row.createdAt > m.lastUsedAt) m.lastUsedAt = row.createdAt;
  }

  for (const m of bySessionModel.values()) {
    entries.push({
      client: 'muse',
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: 'meta',
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      reasoning: m.reasoning,
      messageCount: m.messages,
      cost: m.cost,
      startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : '',
      lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : '',
      performance: null
    });
    allInput += m.input;
    allOutput += m.output + m.reasoning;
    allCacheRead += m.cacheRead;
    allCacheWrite += m.cacheWrite;
    allMessages += m.messages;
    allCost += m.cost;
  }

  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: allInput,
    totalOutput: allOutput,
    totalCacheRead: allCacheRead,
    totalCacheWrite: allCacheWrite,
    totalMessages: allMessages,
    totalCost: allCost,
    processingTimeMs: 0
  };
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Raw graph-compatible contributions so collector.js can merge this local
// adapter with tokscale's graph output through the shared history core.
function buildMuseHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : collectMuseRows(options);
  for (const row of rows) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
    if (!date) continue; // an undated row cannot be truthfully placed on a day
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = normalizedModelId(row.model) || 'unknown';
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: 'muse',
        modelId,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    const cost = estimatedRowCost(row, options.pricingByModel);
    client.tokens.input += row.input;
    client.tokens.output += row.output;
    client.tokens.cacheRead += row.cacheRead;
    client.tokens.cacheWrite += row.cacheWrite;
    client.tokens.reasoning += row.reasoning;
    client.cost += cost === null ? 0 : cost;
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/**
 * Compute local midnight for today and month start, then build
 * tokscale-compatible JSON for each period.
 *
 * @param {{ now?: Date | number | string, allTimeSince?: number | string, roots?: string[], rows?: Array, pricingByModel?: object }} options
 */
function buildMusePeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectMuseRows(options);
  const buildOptions = { rows, pricingByModel: options.pricingByModel };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

module.exports = {
  MUSE_FALLBACK_PRICING,
  museSessionsRoot,
  sessionFiles,
  collectSessionRows,
  collectMuseRows,
  estimatedRowCost,
  buildTokscaleJson,
  buildMuseHistoryGraph,
  buildMusePeriods
};
