import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Mirrors the daemon's `provider.usage.list` payload (@getpaseo/protocol).
 * Kept local so the plugin never imports a host module it is not given.
 */
export const UsageToneSchema = z.enum(["default", "ok", "warning", "danger"]);
export const UsageStatusSchema = z.enum(["available", "unavailable", "error"]);

export const TokenUsageStatusSchema = z.enum(["available", "partial", "unavailable", "unsupported"]);
export const TokenCostStatusSchema = z.enum(["estimated", "partial", "unknown"]);
export const TokenUsageReasonSchema = z.enum([
  "duration-required",
  "unsupported-provider",
  "unsupported-window",
  "provider-unavailable",
  "logs-unavailable",
  "partial-logs",
  "stale-window",
]);

export const TokenModelUsageSchema = z.object({
  model: z.string(),
  calls: z.number().int().nonnegative(),
  knownCalls: z.number().int().nonnegative(),
  unknownCalls: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  estimatedCost: z.number().nonnegative().nullable(),
  costStatus: TokenCostStatusSchema,
});

export const TokenUsageSchema = z.object({
  status: TokenUsageStatusSchema,
  reason: TokenUsageReasonSchema.nullable(),
  source: z.literal("pi-logged-estimate"),
  calls: z.number().int().nonnegative(),
  knownCalls: z.number().int().nonnegative(),
  unknownCalls: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  inputPct: z.number().min(0).max(100).nullable(),
  outputPct: z.number().min(0).max(100).nullable(),
  cacheReadPct: z.number().min(0).max(100).nullable(),
  cacheWritePct: z.number().min(0).max(100).nullable(),
  estimatedCost: z.number().nonnegative().nullable(),
  costStatus: TokenCostStatusSchema,
  monthlyFee: z.number().positive().finite().nullable(),
  monthlyFeePct: z.number().nonnegative().finite().nullable(),
  models: z.array(TokenModelUsageSchema),
});

export const UsageWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().nullable().optional(),
  remainingPct: z.number().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
  runsOutAt: z.string().nullable().optional(),
  shortfallPct: z.number().nullable().optional(),
  tone: UsageToneSchema.optional(),
  tokenUsage: TokenUsageSchema.nullable().optional(),
});

export const UsageBalanceSchema = z.object({
  id: z.string(),
  label: z.string(),
  used: z.number().nullable().optional(),
  remaining: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  unit: z.enum(["usd", "credits", "requests", "tokens"]),
  resetsAt: z.string().nullable().optional(),
  tone: UsageToneSchema.optional(),
});

export const UsageDetailSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  tone: UsageToneSchema.optional(),
});

export const ProviderUsageSchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  status: UsageStatusSchema,
  planLabel: z.string().nullable().default(null),
  sourceLabel: z.string().nullable().optional(),
  fetchedAt: z.string().nullable().optional(),
  nextRefreshAt: z.string().nullable().optional(),
  windows: z.array(UsageWindowSchema).default([]),
  balances: z.array(UsageBalanceSchema).default([]),
  details: z.array(UsageDetailSchema).default([]),
  error: z.string().nullable().optional(),
});

/** Which code path answered. Surfaced in the UI footer so failures are diagnosable. */
export const UsageSourceSchema = z.enum(["sdk", "daemon"]);

export const UsageSnapshotSchema = z.object({
  fetchedAt: z.string().nullable().default(null),
  source: UsageSourceSchema,
  providers: z.array(ProviderUsageSchema).default([]),
});

export type UsageTone = z.output<typeof UsageToneSchema>;
export type TokenUsageStatus = z.output<typeof TokenUsageStatusSchema>;
export type TokenCostStatus = z.output<typeof TokenCostStatusSchema>;
export type TokenUsageReason = z.output<typeof TokenUsageReasonSchema>;
export type TokenModelUsage = z.output<typeof TokenModelUsageSchema>;
export type TokenUsage = z.output<typeof TokenUsageSchema>;
export type UsageWindow = z.output<typeof UsageWindowSchema>;
export type UsageBalance = z.output<typeof UsageBalanceSchema>;
export type UsageDetail = z.output<typeof UsageDetailSchema>;
export type ProviderUsage = z.output<typeof ProviderUsageSchema>;
export type UsageSnapshot = z.output<typeof UsageSnapshotSchema>;

export const listUsage = defineRpc({
  name: "usage.list",
  input: z.object({}),
  output: UsageSnapshotSchema,
});
