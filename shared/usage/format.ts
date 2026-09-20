import type { Locale, Messages } from "../i18n/messages";
import type { TokenModelUsage, TokenUsage, UsageBalance, UsageTone, UsageWindow } from "./contract";

/**
 * Value shapes mirror Paseo's own provider-usage helpers (percent rounding, tone
 * thresholds, compact durations); only the wording is localized, because Paseo's
 * copy for this surface is hardcoded English.
 */

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
    Math.round(clampPct(value)) / 100,
  );
}

/**
 * Two-unit compact duration (`2d 3h`, `3h 25m`, `40m`), localized.
 *
 * Claude Code and Codex both spell the remainder out to a second unit — `3h 25m`
 * rather than `3h` — because a bare leading unit hides up to an hour of headroom
 * right when the window is about to matter. Returns null for a non-finite instant.
 */
function compactDuration(deltaMs: number, messages: Messages): string | null {
  if (!Number.isFinite(deltaMs)) {
    return null;
  }
  const totalMinutes = Math.floor(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${messages.days(days)} ${messages.hours(hours)}` : messages.days(days);
  }
  if (hours > 0) {
    return minutes > 0 ? `${messages.hours(hours)} ${messages.minutes(minutes)}` : messages.hours(hours);
  }
  return messages.minutes(minutes);
}

const DAY_MS = 24 * 60 * 60_000;

/** Remaining time until an instant, or null when it is absent, unparseable, or past. */
function remainingMs(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const delta = new Date(iso).getTime() - Date.now();
  return Number.isFinite(delta) && delta > 0 ? delta : null;
}

/** Within a day, the wall-clock time; beyond it, the date too. Mirrors Claude Code's `/usage`. */
export function formatResetClock(
  iso: string | null | undefined,
  locale: Locale,
  messages: Messages,
): string | null {
  if (!iso) {
    return null;
  }
  const at = new Date(iso);
  const time = at.getTime();
  const remaining = time - Date.now();
  // A reset that already came due is announced as "resetting now"; a stale
  // wall-clock time next to that would read as a contradiction.
  if (!Number.isFinite(time) || remaining <= 0) {
    return null;
  }
  const withinADay = remaining < DAY_MS;
  const clock = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(withinADay ? {} : { month: "short", day: "numeric" }),
  }).format(at);
  return messages.resetsAt(clock);
}

export function formatResetLabel(iso: string | null | undefined, messages: Messages): string | null {
  if (!iso) {
    return null;
  }
  const deltaMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(deltaMs)) {
    return null;
  }
  if (deltaMs <= 0) {
    return messages.resettingNow;
  }
  const duration = compactDuration(deltaMs, messages);
  return duration ? messages.resets(duration) : null;
}

/**
 * The reset a row leads with: a countdown while the window still resets today,
 * the wall-clock instant once it is a day or more out.
 *
 * Claude Code makes the same split — its session bar prints `Resets 3pm` while
 * the weekly bars print `Resets Nov 12, 3pm` — because the two horizons answer
 * different questions. Under a day, "how long do I have" is the actionable
 * number; past that, `1d` is too coarse to plan around and a date is not.
 */
export function formatResetPrimary(
  iso: string | null | undefined,
  locale: Locale,
  messages: Messages,
): string | null {
  const remaining = remainingMs(iso);
  if (remaining == null) {
    return formatResetLabel(iso, messages);
  }
  return remaining >= DAY_MS ? formatResetClock(iso, locale, messages) : formatResetLabel(iso, messages);
}

/** The other half of the pair, for a tooltip: whichever form the row did not print. */
export function formatResetSecondary(
  iso: string | null | undefined,
  locale: Locale,
  messages: Messages,
): string | null {
  const remaining = remainingMs(iso);
  if (remaining == null) {
    return null;
  }
  return remaining >= DAY_MS ? formatResetLabel(iso, messages) : formatResetClock(iso, locale, messages);
}

export function formatRunsOutLabel(iso: string | null | undefined, messages: Messages): string | null {
  if (!iso) {
    return null;
  }
  const deltaMs = new Date(iso).getTime() - Date.now();
  const duration = compactDuration(Math.max(deltaMs, 0), messages);
  return duration ? messages.runsOut(duration) : null;
}

export function formatAgo(iso: string | null | undefined, messages: Messages): string | null {
  if (!iso) {
    return null;
  }
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) {
    return null;
  }
  if (deltaMs < 60_000) {
    return messages.justNow;
  }
  const duration = compactDuration(deltaMs, messages);
  return duration ? messages.ago(duration) : null;
}

export function formatTokenCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Percentages of a monthly fee may exceed 100%; quota percentages are clamped separately. */
export function formatRatioPct(value: number, locale: Locale): string {
  const format = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  return value > 0 && value < 0.1 ? `<${format.format(0.001)}` : format.format(value / 100);
}

export function formatAmount(value: number, unit: UsageBalance["unit"], locale: Locale): string {
  switch (unit) {
    case "usd":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
    case "tokens":
      return formatTokenCount(value, locale);
    default:
      return new Intl.NumberFormat(locale).format(value);
  }
}

export function formatEstimatedCost(value: number, locale: Locale): string {
  return value > 0 && value < 0.01
    ? `<${formatAmount(0.01, "usd", locale)}`
    : formatAmount(value, "usd", locale);
}

export function formatTokenMix(
  stats: Pick<TokenModelUsage, "totalTokens" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  locale: Locale,
  messages: Messages,
): string {
  const bucket = (count: number) => `${formatTokenCount(count, locale)} (${stats.totalTokens > 0
    ? formatRatioPct(count / stats.totalTokens * 100, locale) : "—"})`;
  return messages.tokenSummary(
    formatTokenCount(stats.totalTokens, locale),
    bucket(stats.inputTokens), bucket(stats.outputTokens), bucket(stats.cacheReadTokens),
    stats.cacheWriteTokens > 0 ? bucket(stats.cacheWriteTokens) : null,
  );
}

/** Compact enough for the sidebar, while retaining the three requested mix shares. */
export function formatTokenSummary(stats: TokenUsage, locale: Locale, messages: Messages): string | null {
  if (stats.status === "unsupported") {
    return stats.reason === "duration-required" ? messages.tokenDurationRequired : messages.tokenUnsupported;
  }
  if (stats.status === "unavailable") {
    return messages.tokenUnavailable;
  }
  if (stats.calls === 0) {
    return messages.tokenNoRecords;
  }
  const summary = stats.knownCalls === 0
    ? messages.tokenModelUnknown(formatTokenCount(stats.calls, locale))
    : `${formatTokenMix(stats, locale, messages)} · ${messages.tokenCalls(formatTokenCount(stats.calls, locale))}${
      stats.unknownCalls > 0 ? ` · ${messages.tokenModelUnknown(formatTokenCount(stats.unknownCalls, locale))}` : ""}`;
  return stats.status === "partial" ? `${summary} · ${messages.tokenPartial}` : summary;
}

export function formatTokenCost(stats: TokenUsage, locale: Locale, messages: Messages): string | null {
  if (stats.calls === 0 || stats.status === "unsupported" || stats.status === "unavailable") {
    return null;
  }
  if (stats.estimatedCost == null) {
    return messages.tokenCostUnknown;
  }
  const estimate = formatEstimatedCost(stats.estimatedCost, locale);
  const line = messages.tokenCost(estimate);
  return stats.costStatus === "partial" ? `${line} · ${messages.tokenCostPartial}` : line;
}

/** Sidebar is a glance view; detailed counts and coverage warnings remain in its tooltip/panel. */
export function formatSidebarUsage(stats: TokenUsage, locale: Locale, messages: Messages) {
  const detail = [formatTokenSummary(stats, locale, messages), formatTokenCost(stats, locale, messages)]
    .filter(Boolean).join("\n");
  if (stats.status === "unsupported" || stats.status === "unavailable" || stats.knownCalls === 0) {
    return { total: formatTokenSummary(stats, locale, messages), mix: null, cost: null, detail };
  }
  const percent = (value: number | null) => value == null ? "—" : formatRatioPct(value, locale);
  const partial = stats.costStatus === "partial" || stats.status === "partial";
  return {
    total: messages.sidebarTokens(formatTokenCount(stats.totalTokens, locale)),
    mix: messages.sidebarMix(percent(stats.inputPct), percent(stats.outputPct),
      percent(stats.cacheReadPct)),
    cost: stats.estimatedCost == null ? null : messages.sidebarCost(
      `${formatEstimatedCost(stats.estimatedCost, locale)}${partial ? "+" : ""}`),
    detail,
  };
}

/** Where the ramp steps. Below `WARNING` a window is simply not the problem. */
const WARNING_PCT = 70;
const DANGER_PCT = 90;

/**
 * A reading's own tone, from the share consumed.
 *
 * A known-good reading is `ok`, not `default`: the two used to collapse into one
 * value, which left every healthy bar painted in the "no data" grey and made
 * "comfortable" and "unknown" indistinguishable.
 */
export function deriveTone(usedPct: number | null): UsageTone {
  if (usedPct == null) {
    return "default";
  }
  if (usedPct > DANGER_PCT) {
    return "danger";
  }
  return usedPct >= WARNING_PCT ? "warning" : "ok";
}

const SEVERITY: Record<UsageTone, number> = { default: 0, ok: 1, warning: 2, danger: 3 };

/**
 * The tone a bar paints: the more severe of what the daemon reported and what
 * the percentage implies.
 *
 * Neither alone is right. Taking the daemon's blindly means its thresholds decide
 * where this plugin's ramp steps, and a provider that reports no tone at all
 * paints grey. Deriving locally and ignoring the daemon throws away the one thing
 * a percentage cannot express — a window projected to run out early is `danger`
 * at 40% — so the escalation is kept and only the floor is ours.
 */
export function resolveTone(reported: UsageTone | undefined, usedPct: number | null): UsageTone {
  const derived = deriveTone(usedPct);
  if (reported == null) {
    return derived;
  }
  return SEVERITY[reported] >= SEVERITY[derived] ? reported : derived;
}

/** A window reports either the consumed or the remaining share; normalize to consumed. */
export function windowUsedPct(window: UsageWindow): number | null {
  if (window.usedPct != null) {
    return window.usedPct;
  }
  if (window.remainingPct != null) {
    return 100 - window.remainingPct;
  }
  return null;
}

export function balanceReading(
  balance: UsageBalance,
  locale: Locale,
  messages: Messages,
): { amountText: string; usedPct: number | null } {
  const { used, remaining, limit, unit } = balance;
  if (limit != null && limit > 0) {
    const consumed = used ?? (remaining != null ? limit - remaining : null);
    return {
      amountText: `${consumed != null ? formatAmount(consumed, unit, locale) : "—"} / ${formatAmount(limit, unit, locale)}`,
      usedPct: consumed != null ? (consumed / limit) * 100 : null,
    };
  }
  if (remaining != null) {
    return { amountText: messages.balanceLeft(formatAmount(remaining, unit, locale)), usedPct: null };
  }
  if (used != null) {
    return { amountText: formatAmount(used, unit, locale), usedPct: null };
  }
  return { amountText: "—", usedPct: null };
}

export function statusLabel(
  status: "available" | "unavailable" | "error",
  messages: Messages,
): string | null {
  if (status === "available") {
    return null;
  }
  return status === "error" ? messages.error : messages.unavailable;
}
