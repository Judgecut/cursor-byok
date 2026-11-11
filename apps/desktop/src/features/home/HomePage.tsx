import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n/store";
import {
  api,
  type LlmCall,
  type Overview,
  type OverviewFilterModel,
  type OverviewFilterSupplier,
} from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { SupplierFilter } from "../../shared/ui/SupplierFilter";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { refreshIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { formatTimeInput, parseTimeInput } from "../../shared/utils/parseTimeInput";
import { buildModelFilterOptions, buildSupplierFilterOptions } from "../../shared/utils/supplierOptions";
import { presetRange, type OverviewRangePreset, type QuickPreset, type TimeRange } from "../../shared/utils/timeRange";
import { PageActions } from "../../shell/PageActions";
import { PageContent } from "../../shell/layout/PageContent";
import type { VirtualPageSection } from "../../shell/layout/VirtualPage";
import { ContributionCalendarChart } from "./charts/ContributionCalendarChart";
import { DailyTokenUsageChart } from "./charts/DailyTokenUsageChart";
import { HomeMetrics } from "./metrics/HomeMetrics";
import { OverviewTabs, type OverviewTabId } from "./overview/OverviewTabs";
import { OverviewTimeRangeFilter } from "./overview/OverviewTimeRangeFilter";
import styles from "./HomePage.module.scss";

export function HomePage() {
  const {
    overview,
    busy,
    plugins,
    currency,
    cnyRate,
    overviewChartMode,
    overviewChartType,
    refreshTick,
  } = useAppStore();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const showMessage = useMessage();

  const [activeTab, setActiveTab] = useState<OverviewTabId>("models");
  const [preset, setPreset] = useState<OverviewRangePreset>("month");
  const [quick, setQuick] = useState<QuickPreset | null>(null);
  const [customRange, setCustomRange] = useState<TimeRange | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [appliedModels, setAppliedModels] = useState<string[]>([]);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const [rangeState, setRangeState] = useState<{ filterKey: string; overview: Overview } | null>(null);
  const [rangeBusy, setRangeBusy] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [supplierCatalog, setSupplierCatalog] = useState<OverviewFilterSupplier[]>([]);
  const [modelCatalog, setModelCatalog] = useState<OverviewFilterModel[]>([]);

  const [callsPage, setCallsPage] = useState(1);
  const [callsPageSize, setCallsPageSize] = useState(20);
  const [callsState, setCallsState] = useState<{
    filterKey: string;
    page: number;
    pageSize: number;
    items: LlmCall[];
    total: number;
  } | null>(null);
  const [callsLoading, setCallsLoading] = useState(true);
  const [callsError, setCallsError] = useState<string | null>(null);

  const overviewSeq = useRef(0);
  const callsSeq = useRef(0);

  const selectedRange = useMemo(
    () => (preset === "custom" ? customRange : presetRange(preset)),
    [customRange, preset, refreshTick, refreshVersion],
  );

  const filterKey = useMemo(
    () => JSON.stringify({
      preset,
      quick,
      customStartMs: customRange?.startMs ?? null,
      customEndMs: customRange?.endMs ?? null,
      suppliers: selectedSuppliers,
      models: appliedModels,
    }),
    [appliedModels, customRange?.endMs, customRange?.startMs, preset, quick, selectedSuppliers],
  );

  // Preserve full supplier & model lists even if a specific filter yields zero calls.
  useEffect(() => {
    const suppliersCandidate = rangeState?.overview.available_suppliers.length
      ? rangeState.overview.available_suppliers
      : overview.available_suppliers;
    if (suppliersCandidate.length > 0) {
      setSupplierCatalog(suppliersCandidate);
    }
    const modelsCandidate = rangeState?.overview.available_models.length
      ? rangeState.overview.available_models
      : overview.available_models;
    if (modelsCandidate.length > 0) {
      setModelCatalog(modelsCandidate);
    }
  }, [
    overview.available_models,
    overview.available_suppliers,
    rangeState?.overview.available_models,
    rangeState?.overview.available_suppliers,
  ]);

  // Reset call pagination to page 1 whenever filters change.
  const changeSuppliers = useCallback((nextSuppliers: string[]) => {
    setSelectedSuppliers(nextSuppliers);
    setCallsPage(1);
  }, []);

  useEffect(() => {
    if (!selectedRange) return;
    const seq = ++overviewSeq.current;
    const requestFilterKey = filterKey;
    const controller = new AbortController();
    setRangeBusy(true);
    setOverviewError(null);
    void api.overview({
      startMs: selectedRange.startMs,
      endMs: selectedRange.endMs,
      suppliers: selectedSuppliers,
      supplierKeys: appliedModels,
    }, { signal: controller.signal }).then((next) => {
      if (seq !== overviewSeq.current) return;
      setRangeState({ filterKey: requestFilterKey, overview: next });
      setOverviewError(null);
    }).catch((cause) => {
      if (seq !== overviewSeq.current || controller.signal.aborted) return;
      setOverviewError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (seq === overviewSeq.current) setRangeBusy(false);
    });
    return () => {
      controller.abort();
    };
  }, [appliedModels, filterKey, refreshTick, refreshVersion, selectedRange, selectedSuppliers]);

  useEffect(() => {
    if (!selectedRange) return;
    const seq = ++callsSeq.current;
    const requestFilterKey = filterKey;
    const requestPage = callsPage;
    const requestPageSize = callsPageSize;
    const controller = new AbortController();
    setCallsLoading(true);
    setCallsError(null);
    void api.calls({
      startMs: selectedRange.startMs,
      endMs: selectedRange.endMs,
      suppliers: selectedSuppliers,
      supplierKeys: appliedModels,
      limit: requestPageSize,
      offset: (requestPage - 1) * requestPageSize,
    }, { signal: controller.signal }).then((result) => {
      if (seq !== callsSeq.current) return;
      setCallsState({
        filterKey: requestFilterKey,
        page: requestPage,
        pageSize: requestPageSize,
        items: result.items,
        total: result.total,
      });
      setCallsError(null);
    }).catch((cause) => {
      if (seq !== callsSeq.current || controller.signal.aborted) return;
      setCallsError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (seq === callsSeq.current) setCallsLoading(false);
    });
    return () => {
      controller.abort();
    };
  }, [appliedModels, callsPage, callsPageSize, filterKey, refreshTick, refreshVersion, selectedRange, selectedSuppliers]);

  const hasMatchingOverview = rangeState?.filterKey === filterKey;
  const filteredOverview = hasMatchingOverview ? rangeState.overview : null;
  const effectiveOverviewError = overviewError;

  const hasMatchingCallsFilter = callsState?.filterKey === filterKey;
  const hasMatchingCallsPage = hasMatchingCallsFilter
    && callsState.page === callsPage
    && callsState.pageSize === callsPageSize;
  const callsItems = hasMatchingCallsPage && !callsError ? callsState.items : [];
  const callsTotal = hasMatchingCallsFilter && !callsError ? callsState.total : 0;
  const callsTableLoading = !callsError && (callsLoading || !hasMatchingCallsPage);

  const dailyTokenUsage = useMemo(
    () => (filteredOverview?.token_usage_series ?? []).map((bucket) => ({
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
    })),
    [filteredOverview],
  );

  const contribution = useMemo(
    () => (filteredOverview?.activity_series ?? []).map((day) => ({
      date: day.date,
      tokens: day.token_usage,
    })),
    [filteredOverview],
  );

  const metrics = filteredOverview ? {
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
    speed: filteredOverview.metrics.speed,
  } : null;

  const openCustom = (open: boolean) => {
    if (open) {
      setSelectedModels(appliedModels);
      if (!customStart && !customEnd) {
        const now = new Date();
        setCustomEnd(formatTimeInput(now));
        setCustomStart(formatTimeInput(new Date(now.getTime() - 60 * 60_000)));
      }
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
    setCallsPage(1);
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
    setCallsPage(1);
  };

  const selectPreset = (value: Exclude<OverviewRangePreset, "custom">) => {
    setPreset(value);
    setQuick(null);
    setCustomOpen(false);
    setCallsPage(1);
  };

  const refresh = async () => {
    await appStore.refresh();
    setRefreshVersion((version) => version + 1);
  };

  const switchCurrency = (nextCurrency: "USD" | "CNY") => {
    if (!appStore.selectCurrency(nextCurrency)) {
      showMessage(t("尚未配置有效人民币汇率，请先在设置中配置大于 0 的汇率"), { duration: 4_000 });
      navigate("/settings", { state: { focusCurrencyRate: Date.now() } });
    }
  };

  const openAllCalls = () => {
    appStore.handoffCallsFilter({
      preset,
      quick,
      customRange,
      customStart,
      customEnd,
      suppliers: selectedSuppliers,
      models: appliedModels,
    });
    navigate("/calls");
  };

  const supplierOptions = useMemo(
    () => buildSupplierFilterOptions(
      supplierCatalog.length > 0 ? supplierCatalog : (filteredOverview?.available_suppliers ?? []),
      plugins,
      locale,
    ),
    [filteredOverview?.available_suppliers, locale, plugins, supplierCatalog],
  );

  const modelOptions = useMemo(
    () => buildModelFilterOptions(
      modelCatalog.length > 0 ? modelCatalog : (filteredOverview?.available_models ?? []),
      plugins,
      locale,
    ),
    [filteredOverview?.available_models, locale, modelCatalog, plugins],
  );

  const sections: VirtualPageSection[] = [
    {
      key: "metrics",
      estimatedHeight: 124,
      content: <HomeMetrics
        data={effectiveOverviewError ? null : metrics}
        currency={currency}
        cnyRate={cnyRate}
        loading={rangeBusy && !hasMatchingOverview}
        error={effectiveOverviewError}
      />,
    },
    {
      key: "daily-token-usage",
      estimatedHeight: 244,
      content: <DailyTokenUsageChart
        data={dailyTokenUsage}
        granularity={filteredOverview?.token_usage_granularity ?? "day"}
        mode={overviewChartMode}
        chartType={overviewChartType}
        currency={currency}
        cnyRate={cnyRate}
        loading={!hasMatchingOverview && !effectiveOverviewError}
        error={effectiveOverviewError}
      />,
    },
    {
      key: "activity",
      estimatedHeight: 132,
      content: <ContributionCalendarChart
        data={contribution}
        loading={rangeBusy && !hasMatchingOverview}
        error={effectiveOverviewError}
      />,
    },
    {
      key: "tabs",
      estimatedHeight: Math.max(220, 88 + Math.max(filteredOverview?.models.length ?? 0, filteredOverview?.suppliers.length ?? 0, callsItems.length) * 44),
      content: <OverviewTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        calls={callsItems}
        callsTotal={callsTotal}
        callsReady={hasMatchingCallsFilter && !callsError}
        callsPagination={{
          page: callsPage,
          pageSize: callsPageSize,
          total: callsTotal,
          onPageChange: setCallsPage,
          onPageSizeChange: (nextSize) => {
            setCallsPageSize(nextSize);
            setCallsPage(1);
          },
        }}
        callsLoading={callsTableLoading}
        callsError={callsError}
        onCallDetails={(call) => void appStore.openCallDetails(call.call_id)}
        onOpenAllCalls={openAllCalls}
        suppliers={filteredOverview?.suppliers ?? []}
        models={filteredOverview?.models ?? []}
        overviewReady={hasMatchingOverview && !effectiveOverviewError}
        plugins={plugins}
        overallTokenUsage={filteredOverview?.metrics.token_usage ?? 0}
        currency={currency}
        cnyRate={cnyRate}
        overviewLoading={!hasMatchingOverview && !effectiveOverviewError}
        overviewError={effectiveOverviewError}
      />,
    },
  ];

  return <>
    <PageActions>
      <OverviewTimeRangeFilter
        value={preset}
        quick={quick}
        customOpen={customOpen}
        customStart={customStart}
        customEnd={customEnd}
        modelOptions={modelOptions}
        selectedModels={selectedModels}
        onSelect={selectPreset}
        onQuickSelect={selectQuick}
        onCustomOpenChange={openCustom}
        onCustomStartChange={setCustomStart}
        onCustomEndChange={setCustomEnd}
        onSelectedModelsChange={setSelectedModels}
        onCustomApply={applyCustom}
      />
      <SupplierFilter
        value={selectedSuppliers}
        options={supplierOptions}
        onChange={changeSuppliers}
      />
      <span className={styles.divider} aria-hidden="true" />
      <div className={styles.segmentGroup} role="group" aria-label={t("显示币种")}>
        <button
          type="button"
          aria-pressed={currency === "USD"}
          onClick={() => switchCurrency("USD")}
        >USD</button>
        <button
          type="button"
          aria-pressed={currency === "CNY"}
          onClick={() => switchCurrency("CNY")}
        >CNY</button>
      </div>
      <div className={styles.segmentGroup} role="group" aria-label={t("趋势统计维度")}>
        <button
          type="button"
          aria-pressed={overviewChartMode === "tokens"}
          onClick={() => appStore.selectOverviewChartMode("tokens")}
        >Token</button>
        <button
          type="button"
          aria-pressed={overviewChartMode === "cost"}
          onClick={() => appStore.selectOverviewChartMode("cost")}
        >{t("费用")}</button>
      </div>
      <div className={styles.segmentGroup} role="group" aria-label={t("趋势图表样式")}>
        <button
          type="button"
          aria-pressed={overviewChartType === "bar"}
          onClick={() => appStore.selectOverviewChartType("bar")}
        >{t("柱状")}</button>
        <button
          type="button"
          aria-pressed={overviewChartType === "line"}
          onClick={() => appStore.selectOverviewChartType("line")}
        >{t("曲线")}</button>
      </div>
      <TooltipTrigger label={t("刷新")}>
        <button
          type="button"
          className={controls.iconButton}
          aria-label={t("刷新")}
          disabled={busy || rangeBusy}
          onClick={() => void refresh()}
        >
          <Icon className={(busy || rangeBusy) ? controls.spin : ""} icon={refreshIcon} size="1.1em" />
        </button>
      </TooltipTrigger>
    </PageActions>
    <PageContent title={t("概览")} sections={sections} />
  </>;
}
