import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TokenModelUsage, TokenUsage } from "../../shared/usage/contract";
import type { UsageSettings } from "../../shared/usage/settings";

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1_000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1_000;

/** Only explicit provider mappings are allowed to touch local token records. */
const LOG_PROVIDER_FOR_USAGE_PROVIDER: Readonly<Record<string, string>> = {
  codex: "openai-codex",
};

export type SessionRecord = {
  identity: string;
  provider: string;
  model: string;
  timestampMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reportedTotalTokens: number | null;
  estimatedCost: number | null;
  usageKnown: boolean;
  costKnown: boolean;
};

type FileCacheEntry = {
  mtimeMs: number;
  size: number;
  records: SessionRecord[];
  malformedLines: number;
};

export type SessionScanStatus = "available" | "partial" | "unavailable";

export type SessionScan = {
  status: SessionScanStatus;
  records: SessionRecord[];
  malformedLines: number;
  fileErrors: number;
  fileCount: number;
  filesParsed: number;
  duplicatesRemoved: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 100_000_000_000 ? value : value * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  return null;
}

function usageCost(usage: Record<string, unknown> | null): number | null {
  if (!usage || !isRecord(usage.cost)) {
    return null;
  }
  const cost = usage.cost;
  const total = nonnegative(cost.total);
  if (total != null && total > 0) {
    return total;
  }
  const parts = ["input", "output", "cacheRead", "cacheWrite"].map((key) => nonnegative(cost[key]));
  if (parts.some((part) => part == null)) return null;
  const sum = parts.reduce<number>((value, part) => value + (part ?? 0), 0);
  return sum > 0 ? sum : null;
}

function recordFromValue(value: unknown): SessionRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const nested = isRecord(value.message) ? value.message : null;
  const candidate = nested && (nested.role !== undefined || nested.provider !== undefined) ? nested : value;
  const role = stringValue(candidate.role) ?? stringValue(value.role);
  if (role !== "assistant") {
    return null;
  }

  const provider = stringValue(candidate.provider) ?? stringValue(value.provider);
  const model = stringValue(candidate.model) ?? stringValue(value.model);
  const time = timestampMs(candidate.timestamp ?? value.timestamp ?? value.ts);
  if (!provider || !model || time == null) {
    return null;
  }

  const usageValue = isRecord(candidate.usage) ? candidate.usage : isRecord(value.usage) ? value.usage : null;
  const inputTokens = nonnegative(usageValue?.input) ?? 0;
  const outputTokens = nonnegative(usageValue?.output) ?? 0;
  const cacheReadTokens = nonnegative(usageValue?.cacheRead) ?? 0;
  const cacheWriteTokens = nonnegative(usageValue?.cacheWrite) ?? 0;
  const reportedTotalTokens = nonnegative(usageValue?.totalTokens);
  const estimatedCost = usageCost(usageValue);
  const categorizedTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const usageKnown = categorizedTokens > 0 || (reportedTotalTokens != null && reportedTotalTokens > 0);
  // Native Pi entries and copied transcripts have different entry IDs but share responseId.
  const responseId = stringValue(candidate.responseId) ?? stringValue(value.responseId);
  const entryId = stringValue(value.id);
  const metadata = responseId
    ? JSON.stringify([provider, "response", responseId])
    : JSON.stringify([provider, model, time, entryId ?? value.runId ?? value.parentId ?? ""]);

  return {
    identity: metadata,
    provider,
    model,
    timestampMs: time,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reportedTotalTokens,
    estimatedCost,
    usageKnown,
    costKnown: estimatedCost != null,
  };
}

function uniqueRecords(records: SessionRecord[]): SessionRecord[] {
  const unique = new Map<string, SessionRecord>();
  for (const record of records) {
    const previous = unique.get(record.identity);
    const quality = (item: SessionRecord) => Number(item.usageKnown) * 2 + Number(item.costKnown);
    const tokens = (item: SessionRecord) => item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheWriteTokens;
    if (!previous || quality(record) > quality(previous) ||
      (quality(record) === quality(previous) && tokens(record) > tokens(previous))) {
      unique.set(record.identity, record);
    }
  }
  return [...unique.values()];
}

function parseFile(path: string): { records: SessionRecord[]; malformedLines: number } {
  const records: SessionRecord[] = [];
  let malformedLines = 0;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = recordFromValue(JSON.parse(line));
      if (record) {
        records.push(record);
      }
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines };
}

function collectSessionFiles(directory: string, files: string[], errors: { count: number }): boolean {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    errors.count += 1;
    return false;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSessionFiles(path, files, errors);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return true;
}

function hasDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Uses PI_CODING_AGENT_DIR only when it contains the expected sessions root. */
export function resolveSessionRoot(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    const candidate = resolve(expandHome(configured));
    if (hasDirectory(join(candidate, "sessions"))) {
      return candidate;
    }
  }
  return join(homedir(), ".pi", "agent");
}

export function logProviderForUsageProvider(providerId: string): string | null {
  return LOG_PROVIDER_FOR_USAGE_PROVIDER[providerId] ?? null;
}

export function durationForWindow(
  providerId: string,
  windowId: string,
  settings: UsageSettings = { monthlyFees: {}, windowDurations: {} },
): number | null {
  if (windowId === "five_hour") {
    return FIVE_HOUR_MS;
  }
  if (windowId === "weekly") {
    return SEVEN_DAY_MS;
  }
  if (providerId === "codex" && windowId === "session") {
    const duration = settings.windowDurations[`${providerId}:${windowId}`];
    return duration === "five_hours" ? FIVE_HOUR_MS : duration === "seven_days" ? SEVEN_DAY_MS : null;
  }
  return null;
}

function percentage(part: number, total: number): number | null {
  return total > 0 ? (part / total) * 100 : null;
}

type Totals = {
  calls: number;
  knownCalls: number;
  unknownCalls: number;
  costKnownCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reportedTotalTokens: number;
  estimatedCost: number;
};

function emptyTotals(): Totals {
  return {
    calls: 0,
    knownCalls: 0,
    unknownCalls: 0,
    costKnownCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedTotalTokens: 0,
    estimatedCost: 0,
  };
}

function addRecord(totals: Totals, record: SessionRecord): void {
  totals.calls += 1;
  if (record.usageKnown) {
    totals.knownCalls += 1;
  } else {
    totals.unknownCalls += 1;
  }
  if (record.costKnown) {
    totals.costKnownCalls += 1;
    totals.estimatedCost += record.estimatedCost ?? 0;
  }
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.cacheReadTokens += record.cacheReadTokens;
  totals.cacheWriteTokens += record.cacheWriteTokens;
  totals.reportedTotalTokens += record.reportedTotalTokens ?? 0;
}

function modelUsage(model: string, totals: Totals): TokenModelUsage {
  const categorized = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const totalTokens = Math.max(categorized, totals.reportedTotalTokens);
  return {
    model,
    calls: totals.calls,
    knownCalls: totals.knownCalls,
    unknownCalls: totals.unknownCalls,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    totalTokens,
    estimatedCost: totals.costKnownCalls > 0 ? totals.estimatedCost : null,
    costStatus:
      totals.costKnownCalls === 0 ? "unknown" : totals.costKnownCalls === totals.calls ? "estimated" : "partial",
  };
}

function blankTokenUsage(
  status: TokenUsage["status"],
  reason: TokenUsage["reason"],
  monthlyFee: number | null,
): TokenUsage {
  return {
    status,
    reason,
    source: "pi-logged-estimate",
    calls: 0,
    knownCalls: 0,
    unknownCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    inputPct: null,
    outputPct: null,
    cacheReadPct: null,
    cacheWritePct: null,
    estimatedCost: null,
    costStatus: "unknown",
    monthlyFee,
    monthlyFeePct: null,
    models: [],
  };
}

export type TokenWindowOptions = {
  providerId: string;
  windowId: string;
  resetsAt: string | null | undefined;
  nowMs: number;
  settings?: UsageSettings;
  providerAvailable?: boolean;
  scan: SessionScan;
};

/** Aggregates one live usage window without inferring provider or window identity. */
export function aggregateTokenUsage(options: TokenWindowOptions): TokenUsage {
  const settings = options.settings ?? { monthlyFees: {}, windowDurations: {} };
  const monthlyFee = settings.monthlyFees[options.providerId] ?? null;
  if (options.providerAvailable === false) {
    return blankTokenUsage("unavailable", "provider-unavailable", monthlyFee);
  }
  const logProvider = logProviderForUsageProvider(options.providerId);
  if (!logProvider) {
    return blankTokenUsage("unsupported", "unsupported-provider", monthlyFee);
  }

  const duration = durationForWindow(options.providerId, options.windowId, settings);
  if (duration == null) {
    return blankTokenUsage(
      "unsupported",
      options.providerId === "codex" && options.windowId === "session" ? "duration-required" : "unsupported-window",
      monthlyFee,
    );
  }

  const resetMs = timestampMs(options.resetsAt);
  if (resetMs == null || resetMs <= options.nowMs || resetMs - duration > options.nowMs) {
    return blankTokenUsage("unsupported", "stale-window", monthlyFee);
  }
  if (options.scan.status === "unavailable") {
    return blankTokenUsage("unavailable", "logs-unavailable", monthlyFee);
  }

  const startMs = resetMs - duration;
  const byModel = new Map<string, Totals>();
  for (const record of uniqueRecords(options.scan.records)) {
    if (
      record.provider !== logProvider ||
      record.timestampMs < startMs ||
      record.timestampMs >= resetMs ||
      record.timestampMs > options.nowMs
    ) {
      continue;
    }
    const totals = byModel.get(record.model) ?? emptyTotals();
    addRecord(totals, record);
    byModel.set(record.model, totals);
  }

  const totals = emptyTotals();
  for (const modelTotals of byModel.values()) {
    totals.calls += modelTotals.calls;
    totals.knownCalls += modelTotals.knownCalls;
    totals.unknownCalls += modelTotals.unknownCalls;
    totals.costKnownCalls += modelTotals.costKnownCalls;
    totals.inputTokens += modelTotals.inputTokens;
    totals.outputTokens += modelTotals.outputTokens;
    totals.cacheReadTokens += modelTotals.cacheReadTokens;
    totals.cacheWriteTokens += modelTotals.cacheWriteTokens;
    totals.reportedTotalTokens += modelTotals.reportedTotalTokens;
    totals.estimatedCost += modelTotals.estimatedCost;
  }

  const categorized = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const totalTokens = Math.max(categorized, totals.reportedTotalTokens);
  const costStatus =
    totals.costKnownCalls === 0 ? "unknown" : totals.costKnownCalls === totals.calls ? "estimated" : "partial";
  const estimatedCost = totals.costKnownCalls > 0 ? totals.estimatedCost : null;
  const feePct = estimatedCost != null && monthlyFee != null ? (estimatedCost / monthlyFee) * 100 : null;

  return {
    status: options.scan.status === "partial" ? "partial" : "available",
    reason: options.scan.status === "partial" ? "partial-logs" : null,
    source: "pi-logged-estimate",
    calls: totals.calls,
    knownCalls: totals.knownCalls,
    unknownCalls: totals.unknownCalls,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    totalTokens,
    inputPct: percentage(totals.inputTokens, totalTokens),
    outputPct: percentage(totals.outputTokens, totalTokens),
    cacheReadPct: percentage(totals.cacheReadTokens, totalTokens),
    cacheWritePct: percentage(totals.cacheWriteTokens, totalTokens),
    estimatedCost,
    costStatus,
    monthlyFee,
    monthlyFeePct: feePct,
    models: [...byModel.entries()]
      .map(([model, modelTotals]) => modelUsage(model, modelTotals))
      .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)),
  };
}

export type SessionReader = {
  read(force?: boolean): Promise<SessionScan>;
};

export type SessionReaderOptions = {
  root?: string;
  pollMs?: number;
};

export function createSessionReader(options: SessionReaderOptions = {}): SessionReader {
  const root = options.root ?? resolveSessionRoot();
  const pollMs = options.pollMs ?? 15_000;
  const cache = new Map<string, FileCacheEntry>();
  let lastScan: SessionScan | null = null;
  let lastScanAt = 0;
  let inFlight: Promise<SessionScan> | null = null;

  function scan(): SessionScan {
    const sessionsDirectory = join(root, "sessions");
    const files: string[] = [];
    const traversalErrors = { count: 0 };
    if (!hasDirectory(sessionsDirectory)) {
      return {
        status: "unavailable",
        records: [],
        malformedLines: 0,
        fileErrors: 1,
        fileCount: 0,
        filesParsed: 0,
        duplicatesRemoved: 0,
      };
    }
    collectSessionFiles(sessionsDirectory, files, traversalErrors);

    const currentFiles = new Set(files);
    for (const path of cache.keys()) {
      if (!currentFiles.has(path)) {
        cache.delete(path);
      }
    }

    const records: SessionRecord[] = [];
    let malformedLines = 0;
    let fileErrors = traversalErrors.count;
    let filesParsed = 0;
    let readableFiles = 0;
    for (const path of files) {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        fileErrors += 1;
        cache.delete(path);
        continue;
      }
      const previous = cache.get(path);
      if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
        readableFiles += 1;
        records.push(...previous.records);
        malformedLines += previous.malformedLines;
        continue;
      }
      try {
        const parsed = parseFile(path);
        cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ...parsed });
        records.push(...parsed.records);
        malformedLines += parsed.malformedLines;
        filesParsed += 1;
        readableFiles += 1;
      } catch {
        fileErrors += 1;
        cache.delete(path);
      }
    }

    const unique = uniqueRecords(records);
    const duplicatesRemoved = records.length - unique.length;
    const status: SessionScanStatus =
      readableFiles === 0 ? "unavailable" : fileErrors > 0 || malformedLines > 0 ? "partial" : "available";
    return {
      status,
      records: unique,
      malformedLines,
      fileErrors,
      fileCount: files.length,
      filesParsed,
      duplicatesRemoved,
    };
  }

  return {
    async read(force = false): Promise<SessionScan> {
      const now = Date.now();
      if (!force && lastScan && now - lastScanAt < pollMs) {
        return lastScan;
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = Promise.resolve().then(scan);
      try {
        lastScan = await inFlight;
        lastScanAt = Date.now();
        return lastScan;
      } finally {
        inFlight = null;
      }
    },
  };
}

let defaultReader: SessionReader | null = null;
let defaultRoot: string | null = null;

function getDefaultReader(): SessionReader {
  const root = resolveSessionRoot();
  if (!defaultReader || defaultRoot !== root) {
    defaultReader = createSessionReader({ root });
    defaultRoot = root;
  }
  return defaultReader;
}

export function readLocalSessions(): Promise<SessionScan> {
  return getDefaultReader().read();
}
