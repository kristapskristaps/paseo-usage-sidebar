import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Messages, Locale } from "../../shared/i18n/messages";
import { formatEstimatedCost, formatTokenCost, formatTokenCount, formatTokenMix, formatTokenSummary } from "../../shared/usage/format";
import type { TokenUsage } from "../../shared/usage/contract";
import type { WindowDuration } from "../../shared/usage/settings";

const SPACE = { one: 4, two: 8, three: 12 } as const;

function useStyles(theme: PluginTheme) {
  return StyleSheet.create({
    root: { gap: SPACE.two, paddingTop: SPACE.two },
    title: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" },
    line: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    warning: { color: theme.colors.statusWarning, fontSize: 12, lineHeight: 17 },
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
    disclaimer: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
    models: { gap: SPACE.one, paddingTop: SPACE.one },
    modelRow: { gap: 2, paddingVertical: 3 },
    modelName: { color: theme.colors.foreground, fontSize: 12, fontWeight: "500" },
    modelDetail: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
    settings: { gap: SPACE.two, paddingTop: SPACE.two },
    label: { color: theme.colors.foreground, fontSize: 12, fontWeight: "500" },
    hint: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
    inputRow: { flexDirection: "row", alignItems: "center", gap: SPACE.two },
    input: {
      flex: 1,
      minHeight: 44,
      paddingHorizontal: SPACE.two,
      paddingVertical: SPACE.one,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface1,
      fontSize: 14,
    },
    inputFocused: { borderColor: theme.colors.accent },
    saveButton: {
      minHeight: 44,
      paddingHorizontal: SPACE.three,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.accent,
    },
    saveButtonDisabled: { opacity: 0.55 },
    saveLabel: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" },
    saved: { color: theme.colors.statusSuccess, fontSize: 11 },
    choices: { flexDirection: "row", gap: SPACE.one, flexWrap: "wrap" },
    choice: {
      minHeight: 44,
      paddingHorizontal: SPACE.two,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      justifyContent: "center",
    },
    choiceActive: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.accent },
    choiceLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
    choiceLabelActive: { color: theme.colors.foreground, fontWeight: "600" },
  });
}

type TokenStatsProps = {
  stats: TokenUsage | null | undefined;
  theme: PluginTheme;
  locale: Locale;
  messages: Messages;
};

export function TokenStats({ stats, theme, locale, messages }: TokenStatsProps) {
  const styles = useStyles(theme);
  if (!stats) {
    return null;
  }

  const summary = formatTokenSummary(stats, locale, messages);
  const cost = formatTokenCost(stats, locale, messages);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>{messages.tokenUsage}</Text>
      {summary ? <Text style={stats.status === "available" ? styles.line : styles.warning}>{summary}</Text> : null}
      {stats.calls > 0 && cost ? <Text style={styles.line}>{cost}</Text> : null}
      {stats.calls > 0 ? <Text style={styles.disclaimer}>{messages.tokenCostDisclaimer}</Text> : null}
      {stats.models.length > 0 ? (
        <View style={styles.models}>
          {stats.models.map((model) => {
            const detail =
              model.knownCalls === 0
                ? messages.tokenModelUnknown(formatTokenCount(model.calls, locale))
                : `${formatTokenMix(model, locale, messages)}${model.unknownCalls > 0 ? ` · ${messages.tokenModelUnknown(formatTokenCount(model.unknownCalls, locale))}` : ""}`;
            const modelCost =
              model.estimatedCost == null
                ? messages.tokenCostUnknown
                : model.costStatus === "partial"
                  ? `${messages.tokenCost(formatEstimatedCost(model.estimatedCost, locale))} · ${messages.tokenCostPartial}`
                  : messages.tokenCost(formatEstimatedCost(model.estimatedCost, locale));
            return (
              <View key={model.model} style={styles.modelRow}>
                <Text style={styles.modelName} numberOfLines={1}>
                  {model.model}
                </Text>
                <Text style={styles.modelDetail}>
                  {detail} · {modelCost}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

type ProviderUsageSettingsProps = {
  theme: PluginTheme;
  messages: Messages;
  monthlyFee: number | null;
  sessionDuration: WindowDuration | null;
  hasAmbiguousSession: boolean;
  saving: boolean;
  saveError: boolean;
  onSave: (value: { monthlyFee: number | null; sessionDuration: WindowDuration | null }) => Promise<void>;
};

export function ProviderUsageSettings({
  theme,
  messages,
  monthlyFee,
  sessionDuration,
  hasAmbiguousSession,
  saving,
  saveError,
  onSave,
}: ProviderUsageSettingsProps) {
  const styles = useStyles(theme);
  const [feeDraft, setFeeDraft] = useState(monthlyFee == null ? "" : String(monthlyFee));
  const [durationDraft, setDurationDraft] = useState<WindowDuration | null>(sessionDuration);
  const [focused, setFocused] = useState(false);
  const [validationError, setValidationError] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setFeeDraft(monthlyFee == null ? "" : String(monthlyFee));
    setDurationDraft(sessionDuration);
  }, [monthlyFee, sessionDuration]);

  async function save(): Promise<void> {
    const value = feeDraft.trim();
    const fee = value === "" ? null : Number(value);
    if (fee !== null && (!Number.isFinite(fee) || fee <= 0)) {
      setValidationError(true);
      setSaved(false);
      return;
    }
    setValidationError(false);
    setSaved(false);
    try {
      await onSave({ monthlyFee: fee, sessionDuration: durationDraft });
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }

  return (
    <View style={styles.settings}>
      <Text style={styles.label}>{messages.monthlyFeeLabel}</Text>
      <Text style={styles.hint}>{messages.monthlyFeeHint}</Text>
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel={messages.monthlyFeeLabel}
          value={feeDraft}
          onChangeText={(value) => {
            setFeeDraft(value);
            setValidationError(false);
            setSaved(false);
          }}
          placeholder={messages.monthlyFeePlaceholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          keyboardType="decimal-pad"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.input, focused ? styles.inputFocused : null]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={saving ? messages.saving : messages.saveSettings}
          accessibilityState={{ busy: saving, disabled: saving }}
          disabled={saving}
          onPress={() => void save()}
          style={[styles.saveButton, saving ? styles.saveButtonDisabled : null]}
        >
          <Text style={styles.saveLabel}>{saving ? messages.saving : messages.saveSettings}</Text>
        </Pressable>
      </View>
      {validationError ? <Text style={styles.error}>{messages.monthlyFeeInvalid}</Text> : null}
      {saveError ? <Text style={styles.error}>{messages.settingsSaveError}</Text> : null}
      {saved && !saving ? <Text style={styles.saved}>{messages.saved}</Text> : null}

      {hasAmbiguousSession ? (
        <View style={styles.settings}>
          <Text style={styles.label}>{messages.durationLabel}</Text>
          <Text style={styles.hint}>{messages.durationHint}</Text>
          <View style={styles.choices}>
            {(
              [
                [null, messages.durationUnset],
                ["five_hours", messages.durationFiveHours],
                ["seven_days", messages.durationSevenDays],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ selected: durationDraft === value }}
                onPress={() => {
                  setDurationDraft(value);
                  setSaved(false);
                }}
                style={[styles.choice, durationDraft === value ? styles.choiceActive : null]}
              >
                <Text style={[styles.choiceLabel, durationDraft === value ? styles.choiceLabelActive : null]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
