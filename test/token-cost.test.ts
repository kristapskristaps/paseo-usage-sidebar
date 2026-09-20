import assert from "node:assert/strict";
import { formatEstimatedCost, formatRatioPct, formatSidebarUsage, formatTokenSummary } from "../shared/usage/format.ts";
import { messagesFor } from "../shared/i18n/messages.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateTokenUsage,
  createSessionReader,
  durationForWindow,
  type SessionRecord,
  type SessionScan,
} from "../server/usage/session-reader.ts";
import { readSettingsState, validateSettings, writeSettingsState } from "../server/settings/state.ts";

const EMPTY_SETTINGS = { monthlyFees: {}, windowDurations: {} };

function record(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    identity: "record",
    provider: "openai-codex",
    model: "model-a",
    timestampMs: 9_000_000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedTotalTokens: 0,
    estimatedCost: null,
    usageKnown: false,
    costKnown: false,
    ...overrides,
  };
}

function scan(records: SessionRecord[]): SessionScan {
  return {
    status: "available",
    records,
    malformedLines: 0,
    fileErrors: 0,
    fileCount: 1,
    filesParsed: 1,
    duplicatesRemoved: 0,
  };
}

const resetMs = 10_000_000;
const startMs = resetMs - 5 * 60 * 60 * 1_000;
const stats = aggregateTokenUsage({
  providerId: "codex",
  windowId: "five_hour",
  resetsAt: new Date(resetMs).toISOString(),
  nowMs: 0,
  settings: { monthlyFees: { codex: 10 }, windowDurations: {} },
  scan: scan([
    record({
      identity: "known",
      model: "literal-model-a",
      timestampMs: startMs,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 70,
      reportedTotalTokens: 100,
      estimatedCost: 1.5,
      usageKnown: true,
      costKnown: true,
    }),
    // Same id + metadata must not double count when copied into a fork.
    record({
      identity: "known",
      model: "literal-model-a",
      timestampMs: startMs,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 70,
      reportedTotalTokens: 100,
      estimatedCost: 1.5,
      usageKnown: true,
      costKnown: true,
    }),
    record({ identity: "unknown", model: "observed-without-usage", timestampMs: startMs + 1 }),
    record({ identity: "future", timestampMs: 1, inputTokens: 999, usageKnown: true }),
    record({ identity: "before", timestampMs: startMs - 1, inputTokens: 999, usageKnown: true }),
    // Reset boundary is exclusive: it belongs to next live window, not this one.
    record({ identity: "reset", timestampMs: resetMs, inputTokens: 999, usageKnown: true }),
    record({ identity: "wrong-provider", provider: "other-provider", timestampMs: startMs + 2, inputTokens: 999 }),
  ]),
});

assert.equal(durationForWindow("codex", "session", EMPTY_SETTINGS), null);
assert.equal(durationForWindow("codex", "session", { monthlyFees: {}, windowDurations: { "codex:session": "five_hours" } }), 5 * 60 * 60 * 1_000);
assert.equal(durationForWindow("codex", "session", { monthlyFees: {}, windowDurations: { "codex:session": "seven_days" } }), 7 * 24 * 60 * 60 * 1_000);
assert.equal(durationForWindow("codex", "weekly", EMPTY_SETTINGS), 7 * 24 * 60 * 60 * 1_000);
assert.equal(durationForWindow("codex", "weekly_model_fable", EMPTY_SETTINGS), null);

assert.equal(stats.calls, 2);
assert.equal(stats.knownCalls, 1);
assert.equal(stats.unknownCalls, 1);
assert.equal(stats.totalTokens, 100);
assert.equal(stats.inputPct, 10);
assert.equal(stats.outputPct, 20);
assert.equal(stats.cacheReadPct, 70);
assert.equal(stats.estimatedCost, 1.5);
assert.equal(stats.costStatus, "partial");
assert.equal(stats.monthlyFeePct, 15);
assert.equal(stats.models.length, 2);
assert.equal(stats.models[0]?.model, "literal-model-a");
assert.equal(stats.models[1]?.costStatus, "unknown");
assert.equal(aggregateTokenUsage({
  providerId: "other-provider",
  windowId: "five_hour",
  resetsAt: new Date(resetMs).toISOString(),
  nowMs: 0,
  scan: scan([]),
}).reason, "unsupported-provider");
assert.equal(aggregateTokenUsage({
  providerId: "codex",
  windowId: "five_hour",
  resetsAt: new Date(resetMs).toISOString(),
  nowMs: 0,
  providerAvailable: false,
  scan: scan([]),
}).reason, "provider-unavailable");
assert.equal(aggregateTokenUsage({
  providerId: "codex",
  windowId: "session",
  resetsAt: new Date(resetMs).toISOString(),
  nowMs: 0,
  scan: scan([]),
}).reason, "duration-required");

const root = mkdtempSync(join(tmpdir(), "usage-sidebar-test-"));
const sessions = join(root, "sessions");
mkdirSync(sessions, { recursive: true });
const line = (
  id: string,
  timestamp: number,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cost: number,
  parentId = "parent",
) =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      provider: "openai-codex",
      model,
      timestamp,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        reasoning: 999,
        totalTokens: input + output + cacheRead,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  });
const firstFile = join(sessions, "one.jsonl");
const secondFile = join(sessions, "two.jsonl");
const logBase = 1_000_000_000_000;
writeFileSync(firstFile, `${line("same-id", logBase + 1_000, "model-a", 10, 20, 70, 1)}\n{truncated\n`);
writeFileSync(secondFile, `${line("same-id", logBase + 1_000, "model-a", 10, 20, 70, 1, "fork-parent")}\n${line("unknown-id", logBase + 2_000, "model-b", 0, 0, 0, 0)}\n`);
const reader = createSessionReader({ root, pollMs: 60_000 });
const firstScan = await reader.read(true);
assert.equal(firstScan.status, "partial");
assert.equal(firstScan.records.length, 2);
assert.equal(firstScan.duplicatesRemoved, 1);
assert.equal(firstScan.malformedLines, 1);
assert.equal(firstScan.filesParsed, 2);
const cachedScan = await reader.read();
assert.equal(cachedScan, firstScan);
writeFileSync(firstFile, `${readFileSync(firstFile, "utf8")}${line("new-id", logBase + 3_000, "model-c", 1, 2, 3, 0.5)}\n`);
const refreshedScan = await reader.read(true);
assert.equal(refreshedScan.records.length, 3);
assert.equal(refreshedScan.filesParsed, 1);
const parsedStats = aggregateTokenUsage({
  providerId: "codex",
  windowId: "five_hour",
  resetsAt: new Date(logBase + 5_000).toISOString(),
  nowMs: logBase + 4_000,
  settings: { monthlyFees: { codex: 10 }, windowDurations: {} },
  scan: refreshedScan,
});
assert.equal(parsedStats.totalTokens, 106);
assert.equal(parsedStats.inputTokens, 11);
assert.equal(parsedStats.outputTokens, 22);
assert.equal(parsedStats.cacheReadTokens, 73);
assert.equal(parsedStats.estimatedCost, 1.5);

assert.equal(formatEstimatedCost(0.001, "en"), "<$0.01");
assert.equal(formatRatioPct(0.001, "en"), "<0.1%");
assert.match(formatTokenSummary(stats, "en", messagesFor("en"))!, /input 10 \(10%\)/);
assert.match(formatTokenSummary(stats, "en", messagesFor("en"))!, /usage unknown/);
assert.equal(aggregateTokenUsage({ providerId: "codex", windowId: "five_hour",
  resetsAt: new Date(logBase + 7 * 24 * 60 * 60 * 1000).toISOString(), nowMs: logBase,
  scan: scan([]) }).reason, "stale-window");

// A native entry and transcript wrapper represent the same provider response.
const native = JSON.parse(line("native-id", logBase + 1000, "model-a", 10, 20, 70, 1));
native.message.responseId = "response-1";
const flat = { role: "assistant", message: native.message };
const incomplete = JSON.parse(JSON.stringify(flat));
incomplete.message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const incompletePrice = JSON.parse(line("partial-price", logBase + 2000, "model-b", 10, 20, 70, 1));
incompletePrice.message.usage.cost = { input: 0.1 };
writeFileSync(firstFile, [native, flat, incomplete, incompletePrice].map(x => JSON.stringify(x)).join("\n"));
rmSync(secondFile);
const deduped = await reader.read(true);
assert.equal(deduped.records.length, 2);
assert.equal(deduped.duplicatesRemoved, 2);
assert.equal(deduped.records[0]?.estimatedCost, 1);
assert.equal(deduped.records[1]?.estimatedCost, null);
assert.equal((await createSessionReader({ root: join(root, "missing") }).read()).status, "unavailable");

const glance = formatSidebarUsage(stats, "en", messagesFor("en"));
assert.equal(glance.total, "100 tokens");
assert.equal(glance.mix, "In 10% · Out 20% · Cache 70%");
assert.equal(glance.cost, "API ≈ $1.50+");
assert.equal(glance.fee, "15%+ of monthly fee");
assert.match(glance.detail, /Some calls had no logged price/);
assert(![glance.total, glance.mix, glance.cost, glance.fee].join(" ").includes("calls"));
assert.equal(formatSidebarUsage({ ...stats, estimatedCost: null, monthlyFeePct: null }, "en", messagesFor("en")).cost, null);

const previousStateHome = process.env.XDG_STATE_HOME;
const stateHome = mkdtempSync(join(tmpdir(), "usage-sidebar-state-"));
process.env.XDG_STATE_HOME = stateHome;
try {
  const saved = writeSettingsState({
    monthlyFees: { codex: 20, other: null },
    windowDurations: { "codex:session": "five_hours" },
  });
  assert.deepEqual(saved, readSettingsState());
  assert.throws(() => validateSettings({ monthlyFees: { codex: 0 }, windowDurations: {} }));
  assert.throws(() => validateSettings({ monthlyFees: { codex: Number.POSITIVE_INFINITY }, windowDurations: {} }));
  writeFileSync(join(stateHome, "paseo-usage-sidebar", "settings.json"), "{broken");
  assert.deepEqual(readSettingsState(), EMPTY_SETTINGS);
} finally {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(stateHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

console.log("token-cost.test: ok");
