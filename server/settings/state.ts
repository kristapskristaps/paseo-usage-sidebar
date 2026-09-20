import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSettings, WindowDuration } from "../../shared/usage/settings";

function stateFile(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "paseo-usage-sidebar", "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Re-checks RPC input before writing, so direct handler calls cannot bypass bounds. */
export function validateSettings(value: unknown): UsageSettings {
  if (!isRecord(value) || !isRecord(value.monthlyFees) || !isRecord(value.windowDurations)) {
    throw new Error("Invalid usage settings");
  }

  const monthlyFees: Record<string, number | null> = {};
  for (const [providerId, fee] of Object.entries(value.monthlyFees)) {
    if (fee !== null && (typeof fee !== "number" || !Number.isFinite(fee) || fee <= 0)) {
      throw new Error("Monthly fee must be a finite positive number or blank");
    }
    monthlyFees[providerId] = fee;
  }

  const windowDurations: Record<string, WindowDuration> = {};
  for (const [key, duration] of Object.entries(value.windowDurations)) {
    if (duration !== "five_hours" && duration !== "seven_days") {
      throw new Error("Invalid usage window duration");
    }
    windowDurations[key] = duration;
  }

  return { monthlyFees, windowDurations };
}

export function readSettingsState(): UsageSettings {
  try {
    return validateSettings(JSON.parse(readFileSync(stateFile(), "utf8")));
  } catch {
    return { monthlyFees: {}, windowDurations: {} };
  }
}

export function writeSettingsState(value: unknown): UsageSettings {
  const next = validateSettings(value);
  const path = stateFile();
  const directory = join(path, "..");
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The original error is more useful than cleanup failure.
    }
    console.error("[usage-sidebar] Could not persist usage settings");
    throw new Error("Could not persist usage settings");
  }
  return next;
}
