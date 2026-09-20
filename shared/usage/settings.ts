import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Explicit duration choices for SDK windows whose public id is ambiguous. */
export const WindowDurationSchema = z.enum(["five_hours", "seven_days"]);

const MonthlyFeeSchema = z.number().finite().positive().nullable();

export const UsageSettingsSchema = z.object({
  /** Provider ids are keys so fees for unrelated providers never mix. */
  monthlyFees: z.record(z.string(), MonthlyFeeSchema).default({}),
  /** Keys use the same providerId:windowId identity as sidebar pins. */
  windowDurations: z.record(z.string(), WindowDurationSchema).default({}),
});

export type WindowDuration = z.output<typeof WindowDurationSchema>;
export type UsageSettings = z.output<typeof UsageSettingsSchema>;

export function windowDurationKey(providerId: string, windowId: string): string {
  return `${providerId}:${windowId}`;
}

export const readSettings = defineRpc({
  name: "settings.read",
  input: z.object({}),
  output: UsageSettingsSchema,
});

export const writeSettings = defineRpc({
  name: "settings.write",
  input: UsageSettingsSchema,
  output: UsageSettingsSchema,
});
