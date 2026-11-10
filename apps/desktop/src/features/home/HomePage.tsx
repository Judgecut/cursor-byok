import { useEffect, useMemo, useState } from "react";
import { api, pluginText, type Overview } from "../../shared/api";
import { ContributionCalendarChart } from "./charts/ContributionCalendarChart";
import { DailyTokenUsageChart } from "./charts/DailyTokenUsageChart";
import { HomeMetrics } from "./metrics/HomeMetrics";
import { HomeModelBreakdown } from "./models/HomeModelBreakdown";
import { PageContent } from "../../shell/layout/PageContent";
import type { VirtualPageSection } from "../../shell/layout/VirtualPage";
import { OverviewTimeRangeFilter, type OverviewRangePreset, type QuickPreset } from "./overview/OverviewTimeRangeFilter";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { formatTimeInput, parseTimeInput } from "../../shared/utils/parseTimeInput";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../../shared/ui/icons";
import { useI18n } from "../../i18n/store";

type TimeRange = { startMs: number; endMs: number };

const CALENDAR_DAYS = 365;
const DAY_MS = 24 * 60 * 60_000;

function contributionCalendarData(overview: Overview, endMs: number) {
  const tokensByDate = new Map<string, number>();
  for (const bucket of overview.token_usage_series) {
    const date = new Date(bucket.bucket_start_ms).toISOString().slice(0, 10);
    const tokens = bucket.input_tokens + bucket.cache_read_tokens + bucket.cache_write_tokens + bucket.output_tokens;
    tokensByDate.set(date, (tokensByDate.get(date) ?? 0) + tokens);
  }
  const lastDay = new Date(Math.max(0, endMs - 1));
  lastDay.setUTCHours(0, 0, 0, 0);
  const firstDayMs = lastDay.getTime() - (CALENDAR_DAYS - 1) * DAY_MS;
  return Array.from({ length: CALENDAR_DAYS }, (_, offset) => {
    const date = new Date(firstDayMs + offset * DAY_MS).toISOString().slice(0, 10);
    return { date, tokens: tokensByDate.get(date) ?? 0 };
  });
}

function presetRange(preset: Exclude<OverviewRangePreset, "custom">, now = new Date()): TimeRange {
  const endMs = now.getTime();
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }
  if (preset === "month") {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 1);
    return { startMs: start.getTime(), endMs };
  }
  const duration = preset === "ten-minutes" ? 10 * 60_000
    : preset === "hour" ? 60 * 60_000
    : 7 * 24 * 60 * 60_000;
  return { startMs: now.getTime() - duration, endMs };
}

export function HomePage() {
  const { overview, busy, plugins } = useAppStore();
  const { locale } = useI18n();
  const [preset, setPreset] = useState<OverviewRangePreset>("month");
  const [quick, setQuick] = useState<QuickPreset | null>(null);
  const [customRange, setCustomRange] = useState<TimeRange | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [appliedModels, setAppliedModels] = useState<string[]>([]);
  const [rangeOverview, setRangeOverview] = useState<Overview | null>(null);
  const [rangeBusy, setRangeBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const selectedRange = preset === "custom" ? customRange : presetRange(preset);

  useEffect(() => {
    if (!selectedRange) return;
    let active = true;
    setRangeBusy(true);
    void api.overview({
      ...selectedRange,
      supplierKeys: appliedModels,
    }).then((next) => {
      if (active) setRangeOverview(next);
    }).finally(() => {
      if (active) setRangeBusy(false);
    });
    return () => { active = false; };
  }, [preset, customRange, overview, refreshVersion, appliedModels]);

  const filteredOverview = rangeOverview ?? overview;
  const dailyTokenUsage = filteredOverview.token_usage_series.map((bucket) => ({
    bucketStartMs: bucket.bucket_start_ms,
    inputTokens: bucket.input_tokens,
    cacheReadTokens: bucket.cache_read_tokens,
    cacheWriteTokens: bucket.cache_write_tokens,
    outputTokens: bucket.output_tokens,
    inputCost: bucket.input_cost,
    outputCost: bucket.output_cost,
    cacheReadCost: bucket.cache_read_cost,
    cacheWriteCost: bucket.cache_write_cost,
    totalCost: bucket.total_cost,
    pricedCalls: bucket.priced_calls,
    unpricedCalls: bucket.unpriced_calls,
    incompleteUsageCalls: bucket.incomplete_usage_calls,
  }));
  const contribution = contributionCalendarData(filteredOverview, selectedRange?.endMs ?? Date.now());
  const metrics = {
    llmCalls: filteredOverview.metrics.llm_calls,
    successfulCalls: filteredOverview.metrics.successful_calls,
    failedCalls: filteredOverview.metrics.failed_calls,
    tokenUsage: filteredOverview.metrics.token_usage,
    promptTokens: filteredOverview.metrics.prompt_tokens,
    inputTokens: filteredOverview.metrics.input_tokens,
    cacheReadTokens: filteredOverview.metrics.cache_read_tokens,
    cacheWriteTokens: filteredOverview.metrics.cache_write_tokens,
    outputTokens: filteredOverview.metrics.output_tokens,
    totalCost: filteredOverview.metrics.total_cost,
    inputCost: filteredOverview.metrics.input_cost,
    outputCost: filteredOverview.metrics.output_cost,
    cacheReadCost: filteredOverview.metrics.cache_read_cost,
    cacheWriteCost: filteredOverview.metrics.cache_write_cost,
    averagePricedCost: filteredOverview.metrics.average_priced_cost,
    pricedCalls: filteredOverview.metrics.priced_calls,
    unpricedCalls: filteredOverview.metrics.unpriced_calls,
    incompleteUsageCalls: filteredOverview.metrics.incomplete_usage_calls,
  };
  const openCustom = (open: boolean) => {
    if (open && !customStart && !customEnd) {
      const now = new Date();
      setCustomEnd(formatTimeInput(now));
      setCustomStart(formatTimeInput(new Date(now.getTime() - 60 * 60_000)));
    }
    setCustomOpen(open);
  };
  const applyCustom = () => {
    const startMs = parseTimeInput(customStart);
    const endMs = parseTimeInput(customEnd);
    if (startMs === null || endMs === null || startMs >= endMs) return;
    setCustomRange({ startMs, endMs });
    setAppliedModels(selectedModels);
    setQuick(null);
    setPreset("custom");
    setCustomOpen(false);
  };
  const selectQuick = (durationMs: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - durationMs);
    setCustomStart(formatTimeInput(start));
    setCustomEnd(formatTimeInput(end));
    setCustomRange({ startMs: start.getTime(), endMs: end.getTime() });
    setAppliedModels(selectedModels);
    setQuick(durationMs === 4 * 60 * 60_000 ? "four-hours" : "twenty-four-hours");
    setPreset("custom");
    setCustomOpen(false);
  };
  const selectPreset = (value: Exclude<OverviewRangePreset, "custom">) => {
    setPreset(value);
    setQuick(null);
    setCustomOpen(false);
  };
  const refresh = async () => {
    await appStore.refresh();
    setRefreshVersion((version) => version + 1);
  };

  const modelOptions = useMemo(() => {
    const available = filteredOverview.available_models.length
      ? filteredOverview.available_models
      : overview.available_models;
    const pluginGroups = new Map<string, string>();
    for (const plugin of plugins) {
      for (const provider of plugin.providers) {
        pluginGroups.set(
          `plugin://${plugin.id}/${provider.id}`,
          pluginText(provider.displayName, locale) || plugin.name,
        );
      }
    }
    return available.map((item) => ({
      value: item.supplier_key,
      label: item.active ? item.label : t("{label}（历史）", { label: item.label }),
      group: (item.source_kind === "plugin" ? pluginGroups.get(item.endpoint_key) : undefined) || item.group,
      iconSrc: item.plugin_icon || undefined,
      icon: item.plugin_icon
        ? undefined
        : item.provider_type === "anthropic"
          ? claudeIcon
          : item.source_kind === "plugin"
            ? flatColorOrganizationIcon
            : openAiIcon,
    }));
  }, [filteredOverview.available_models, locale, overview.available_models, plugins]);

  const sections: VirtualPageSection[] = [
    {
      key: "daily-token-usage",
      estimatedHeight: 236,
      content: <DailyTokenUsageChart
        data={dailyTokenUsage}
        granularity={filteredOverview.token_usage_granularity}
      />,
    },
    {
      key: "metrics",
      estimatedHeight: 130,
      content: <HomeMetrics data={metrics} refreshVersion={refreshVersion} />,
    },
    {
      key: "activity",
      estimatedHeight: 106,
      content: <ContributionCalendarChart data={contribution} />,
    },
    {
      key: "model-breakdown",
      estimatedHeight: Math.max(120, 48 + filteredOverview.models.length * 42),
      content: <HomeModelBreakdown models={filteredOverview.models} />,
    },
  ];

  return <>
    <PageActions><OverviewTimeRangeFilter
      value={preset}
      quick={quick}
      customOpen={customOpen}
      customStart={customStart}
      customEnd={customEnd}
      modelOptions={modelOptions}
      selectedModels={selectedModels}
      busy={busy || rangeBusy}
      onSelect={selectPreset}
      onQuickSelect={selectQuick}
      onCustomOpenChange={openCustom}
      onCustomStartChange={setCustomStart}
      onCustomEndChange={setCustomEnd}
      onSelectedModelsChange={setSelectedModels}
      onCustomApply={applyCustom}
      onRefresh={() => void refresh()}
    /></PageActions>
    <PageContent title={t("概览")} sections={sections} />
  </>;
}
