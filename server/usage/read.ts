import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { readSettingsState } from "../settings/state";
import { UsageSnapshotSchema, type UsageSnapshot } from "../../shared/usage/contract";
import type { UsageSettings } from "../../shared/usage/settings";
import {
  aggregateTokenUsage,
  durationForWindow,
  logProviderForUsageProvider,
  readLocalSessions,
  type SessionScan,
} from "./session-reader";

/**
 * The daemon payload is validated rather than trusted: a provider that reports
 * a window shape this plugin does not model should degrade to a missing field,
 * not crash the surface.
 */
function normalize(payload: unknown): UsageSnapshot {
  const raw = (payload ?? {}) as { fetchedAt?: unknown; providers?: unknown };
  return UsageSnapshotSchema.parse({
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : null,
    source: "sdk",
    providers: Array.isArray(raw.providers) ? raw.providers : [],
  });
}

const EMPTY_SCAN: SessionScan = {
  status: "available",
  records: [],
  malformedLines: 0,
  fileErrors: 0,
  fileCount: 0,
  filesParsed: 0,
  duplicatesRemoved: 0,
};

function needsLocalScan(snapshot: UsageSnapshot, settings: UsageSettings): boolean {
  return snapshot.providers.some(
    (provider) =>
      provider.status === "available" &&
      logProviderForUsageProvider(provider.providerId) != null &&
      provider.windows.some((window) => durationForWindow(provider.providerId, window.id, settings) != null),
  );
}

/** Adds local Pi token stats without changing the daemon-owned quota readings. */
export function enrichUsageSnapshot(
  snapshot: UsageSnapshot,
  settings: UsageSettings,
  scan: SessionScan | null,
  nowMs: number,
): UsageSnapshot {
  return {
    ...snapshot,
    providers: snapshot.providers.map((provider) => ({
      ...provider,
      windows: provider.windows.map((window) => ({
        ...window,
        tokenUsage: aggregateTokenUsage({
          providerId: provider.providerId,
          windowId: window.id,
          resetsAt: window.resetsAt,
          nowMs,
          settings,
          providerAvailable: provider.status === "available",
          scan: scan ?? EMPTY_SCAN,
        }),
      })),
    })),
  };
}

export async function readUsage(
  _input: Record<string, never>,
  context: PluginHandlerContext,
): Promise<UsageSnapshot> {
  const snapshot = normalize(await context.paseo.providers.listUsage());
  const settings = readSettingsState();
  const scan = needsLocalScan(snapshot, settings) ? await readLocalSessions() : null;
  return UsageSnapshotSchema.parse(enrichUsageSnapshot(snapshot, settings, scan, Date.now()));
}
