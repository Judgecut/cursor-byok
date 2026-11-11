import { useKeepAliveContext } from "keepalive-for-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
import { quickPresetDurationMs, quickPresetRange, resolveTimeRange, type OverviewRangePreset, type QuickPreset, type TimeRange } from "../../shared/utils/timeRange";
import { PageActions } from "../../shell/PageActions";
import { PageContent } from "../../shell/layout/PageContent";
import type { VirtualPageSection } from "../../shell/layout/VirtualPage";
import { ContributionCalendarChart } from "./charts/ContributionCalendarChart";
import { DailyTokenUsageChart } from "./charts/DailyTokenUsageChart";
import { HomeMetrics } from "./metrics/HomeMetrics";
import { OverviewTabs, type OverviewTabId } from "./overview/OverviewTabs";
import { OverviewTimeRangeFilter } from "./overview/OverviewTimeRangeFilter";
import styles from "./HomePage.module.scss";

const DEFAULT_HOME_CALLS_PAGE_SIZE = 20;
const REFRESH_TIMER_CHUNK_MS = 2_000_000_000;

export function HomePage() {
  const {
    overview,
    busy,
    plugins,
    currency,
    cnyRate,
    overviewChartMode,
    overviewChartType,
    homeRefreshIntervalSeconds,
    refreshTick,
  } = useAppStore();
  const { locale } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const showMessage = useMessage();
  const keepAlive = useKeepAliveContext();

  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
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
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const [rangeState, setRangeState] = useState<{ filterKey: string; overview: Overview } | null>(null);
  const [rangeBusy, setRangeBusy] = useState(true);
  const [overviewErrorState, setOverviewErrorState] = useState<{ filterKey: string; message: string } | null>(null);
  const [supplierCatalog, setSupplierCatalog] = useState<OverviewFilterSupplier[]>([]);
  const [modelCatalog, setModelCatalog] = useState<OverviewFilterModel[]>([]);

  const [callsPage, setCallsPage] = useState(1);
  const [callsPageSize, setCallsPageSize] = useState(DEFAULT_HOME_CALLS_PAGE_SIZE);
  const [callsState, setCallsState] = useState<{
    filterKey: string;
    page: number;
    pageSize: number;
    items: LlmCall[];
    total: number;
  } | null>(null);
  const [callsLoading, setCallsLoading] = useState(true);
  const [callsErrorState, setCallsErrorState] = useState<{
    filterKey: string;
    page: number;
    pageSize: number;
    message: string;
  } | null>(null);

  const isHomeRoute = (keepAlive._cacheKey ? keepAlive.active : true) && location.pathname === "/";
  const isHomeActive = isHomeRoute && isDocumentVisible;

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
  const callsQueryKey = `${filterKey}|${callsPage}|${callsPageSize}`;

  const rangeStateRef = useRef(rangeState);
  rangeStateRef.current = rangeState;
  const callsStateRef = useRef(callsState);
  callsStateRef.current = callsState;

  const latestQueryRef = useRef({
    preset,
    quick,
    customRange,
    selectedSuppliers,
    appliedModels,
    filterKey,
    callsPage,
    callsPageSize,
  });
  latestQueryRef.current = {
    preset,
    quick,
    customRange,
    selectedSuppliers,
    appliedModels,
    filterKey,
    callsPage,
    callsPageSize,
  };

  const overviewSeq = useRef(0);
  const callsSeq = useRef(0);
  const roundSeqRef = useRef(0);
  const overviewInFlightRef = useRef<{
    filterKey: string;
    startMs: number;
    endMs: number;
    seq: number;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const callsInFlightRef = useRef<{
    filterKey: string;
    page: number;
    pageSize: number;
    startMs: number;
    endMs: number;
    seq: number;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const activeRoundRef = useRef<{
    filterKey: string;
    range: TimeRange;
    seq: number;
    promise: Promise<void>;
  } | null>(null);
  const lastFilterRangeRef = useRef<{
    filterKey: string;
    range: TimeRange;
  } | null>(null);

  const lastOverviewFetchKeyRef = useRef<string | null>(null);
  const lastCallsFetchKeyRef = useRef<string | null>(null);
  const wasInactiveRef = useRef(false);
  const hasInitializedMountRef = useRef(false);
  const prevRefreshTickRef = useRef(refreshTick);
  const manualRefreshPendingTickRef = useRef<number | null>(null);
  const lastRefreshErrorToastRef = useRef<{ message: string; at: number } | null>(null);

  const reportRefreshFailure = useCallback((errorMessage: string) => {
    const now = Date.now();
    const last = lastRefreshErrorToastRef.current;
    if (last && last.message === errorMessage && now - last.at < 1_000) return;
    lastRefreshErrorToastRef.current = { message: errorMessage, at: now };
    showMessage(t("概览数据刷新失败：{error}", { error: errorMessage }), { duration: 4_000 });
  }, [showMessage]);

  useEffect(() => {
    const syncVisibility = () => {
      setIsDocumentVisible(document.visibilityState === "visible");
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

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

  const abortAllQueries = useCallback(() => {
    activeRoundRef.current = null;
    overviewInFlightRef.current?.controller.abort();
    overviewInFlightRef.current = null;
    callsInFlightRef.current?.controller.abort();
    callsInFlightRef.current = null;
  }, []);

  const fetchOverview = useCallback((options?: { range?: TimeRange | null; notifyOnRefreshError?: boolean }) => {
    const {
      preset: currentPreset,
      quick: currentQuick,
      customRange: currentCustomRange,
      selectedSuppliers: currentSuppliers,
      appliedModels: currentModels,
      filterKey: requestFilterKey,
    } = latestQueryRef.current;

    const range = options?.range !== undefined
      ? options.range
      : resolveTimeRange(currentPreset, currentQuick, currentCustomRange);
    if (!range) return Promise.resolve();

    const existing = overviewInFlightRef.current;
    if (
      existing
      && existing.filterKey === requestFilterKey
      && existing.startMs === range.startMs
      && existing.endMs === range.endMs
    ) {
      return existing.promise;
    }
    if (existing) {
      existing.controller.abort();
      overviewInFlightRef.current = null;
    }

    const seq = ++overviewSeq.current;
    const controller = new AbortController();
    const hasExistingMatch = rangeStateRef.current?.filterKey === requestFilterKey;
    setRangeBusy(true);
    if (!hasExistingMatch) {
      setOverviewErrorState((current) => (current?.filterKey === requestFilterKey ? current : null));
    }

    const entry = {
      filterKey: requestFilterKey,
      startMs: range.startMs,
      endMs: range.endMs,
      seq,
      controller,
      promise: Promise.resolve(),
    };

    entry.promise = api.overview({
      startMs: range.startMs,
      endMs: range.endMs,
      suppliers: currentSuppliers,
      supplierKeys: currentModels,
    }, { signal: controller.signal }).then((next) => {
      if (seq !== overviewSeq.current || controller.signal.aborted) return;
      const nextState = { filterKey: requestFilterKey, overview: next };
      rangeStateRef.current = nextState;
      setRangeState(nextState);
      setOverviewErrorState((current) => (current?.filterKey === requestFilterKey ? null : current));
    }).catch((cause) => {
      if (seq !== overviewSeq.current || controller.signal.aborted) return;
      const errorMsg = cause instanceof Error ? cause.message : String(cause);
      if (hasExistingMatch) {
        if (options?.notifyOnRefreshError) {
          reportRefreshFailure(errorMsg);
        }
      } else {
        setOverviewErrorState({ filterKey: requestFilterKey, message: errorMsg });
      }
    }).finally(() => {
      if (overviewInFlightRef.current?.seq === seq) {
        overviewInFlightRef.current = null;
      }
      if (seq === overviewSeq.current) {
        setRangeBusy(false);
      }
    });

    overviewInFlightRef.current = entry;
    return entry.promise;
  }, [reportRefreshFailure]);

  const fetchCalls = useCallback((options?: { range?: TimeRange | null; notifyOnRefreshError?: boolean }) => {
    const {
      preset: currentPreset,
      quick: currentQuick,
      customRange: currentCustomRange,
      selectedSuppliers: currentSuppliers,
      appliedModels: currentModels,
      filterKey: requestFilterKey,
      callsPage: requestPage,
      callsPageSize: requestPageSize,
    } = latestQueryRef.current;

    const range = options?.range !== undefined
      ? options.range
      : resolveTimeRange(currentPreset, currentQuick, currentCustomRange);
    if (!range) return Promise.resolve();

    const existing = callsInFlightRef.current;
    if (
      existing
      && existing.filterKey === requestFilterKey
      && existing.page === requestPage
      && existing.pageSize === requestPageSize
      && existing.startMs === range.startMs
      && existing.endMs === range.endMs
    ) {
      return existing.promise;
    }
    if (existing) {
      existing.controller.abort();
      callsInFlightRef.current = null;
    }

    const seq = ++callsSeq.current;
    const controller = new AbortController();
    const currentSnapshot = callsStateRef.current;
    const hasExistingMatch = currentSnapshot?.filterKey === requestFilterKey
      && currentSnapshot.page === requestPage
      && currentSnapshot.pageSize === requestPageSize;
    setCallsLoading(true);
    if (!hasExistingMatch) {
      setCallsErrorState((current) => (
        current?.filterKey === requestFilterKey
          && current.page === requestPage
          && current.pageSize === requestPageSize
          ? current
          : null
      ));
    }

    const entry = {
      filterKey: requestFilterKey,
      page: requestPage,
      pageSize: requestPageSize,
      startMs: range.startMs,
      endMs: range.endMs,
      seq,
      controller,
      promise: Promise.resolve(),
    };

    entry.promise = api.calls({
      startMs: range.startMs,
      endMs: range.endMs,
      suppliers: currentSuppliers,
      supplierKeys: currentModels,
      limit: requestPageSize,
      offset: (requestPage - 1) * requestPageSize,
    }, { signal: controller.signal }).then((result) => {
      if (seq !== callsSeq.current || controller.signal.aborted) return;
      const nextState = {
        filterKey: requestFilterKey,
        page: requestPage,
        pageSize: requestPageSize,
        items: result.items,
        total: result.total,
      };
      callsStateRef.current = nextState;
      setCallsState(nextState);
      setCallsErrorState((current) => (
        current?.filterKey === requestFilterKey
          && current.page === requestPage
          && current.pageSize === requestPageSize
          ? null
          : current
      ));
    }).catch((cause) => {
      if (seq !== callsSeq.current || controller.signal.aborted) return;
      const errorMsg = cause instanceof Error ? cause.message : String(cause);
      if (hasExistingMatch) {
        if (options?.notifyOnRefreshError) {
          reportRefreshFailure(errorMsg);
        }
      } else {
        setCallsErrorState({
          filterKey: requestFilterKey,
          page: requestPage,
          pageSize: requestPageSize,
          message: errorMsg,
        });
      }
    }).finally(() => {
      if (callsInFlightRef.current?.seq === seq) {
        callsInFlightRef.current = null;
      }
      if (seq === callsSeq.current) {
        setCallsLoading(false);
      }
    });

    callsInFlightRef.current = entry;
    return entry.promise;
  }, [reportRefreshFailure]);

  const refreshHomeData = useCallback((options?: { notifyOnRefreshError?: boolean }) => {
    const {
      preset: currentPreset,
      quick: currentQuick,
      customRange: currentCustomRange,
      filterKey: currentFilterKey,
      callsPage: currentPage,
      callsPageSize: currentPageSize,
    } = latestQueryRef.current;

    const existingRound = activeRoundRef.current;
    const currentOverview = overviewInFlightRef.current;
    const currentCalls = callsInFlightRef.current;

    if (
      (existingRound && existingRound.filterKey !== currentFilterKey)
      || (currentOverview && currentOverview.filterKey !== currentFilterKey)
      || (currentCalls && currentCalls.filterKey !== currentFilterKey)
    ) {
      abortAllQueries();
    } else {
      const samePageCallsInFlight = currentCalls
        && currentCalls.filterKey === currentFilterKey
        && currentCalls.page === currentPage
        && currentCalls.pageSize === currentPageSize
        ? currentCalls
        : null;

      if (existingRound) {
        if (samePageCallsInFlight) {
          return Promise.all([existingRound.promise, samePageCallsInFlight.promise]).then(() => undefined);
        }
        return existingRound.promise;
      }

      if (samePageCallsInFlight) {
        return samePageCallsInFlight.promise;
      }
    }

    const sharedRange = resolveTimeRange(currentPreset, currentQuick, currentCustomRange, new Date());
    if (!sharedRange) return Promise.resolve();

    lastOverviewFetchKeyRef.current = currentFilterKey;
    lastCallsFetchKeyRef.current = `${currentFilterKey}|${currentPage}|${currentPageSize}`;
    lastFilterRangeRef.current = { filterKey: currentFilterKey, range: sharedRange };

    const roundSeq = ++roundSeqRef.current;
    const overviewPromise = fetchOverview({ range: sharedRange, notifyOnRefreshError: options?.notifyOnRefreshError });
    const callsPromise = fetchCalls({ range: sharedRange, notifyOnRefreshError: options?.notifyOnRefreshError });
    const roundPromise = Promise.all([overviewPromise, callsPromise]).then(() => undefined).finally(() => {
      if (activeRoundRef.current?.seq === roundSeq) {
        activeRoundRef.current = null;
      }
    });

    activeRoundRef.current = {
      filterKey: currentFilterKey,
      range: sharedRange,
      seq: roundSeq,
      promise: roundPromise,
    };
    return roundPromise;
  }, [abortAllQueries, fetchCalls, fetchOverview]);

  // Synchronize initial load, return-from-inactive refresh, and filter/page query changes.
  useEffect(() => {
    if (!isHomeActive) {
      wasInactiveRef.current = true;
      abortAllQueries();
      return;
    }

    hasInitializedMountRef.current = true;
    const resumed = wasInactiveRef.current;
    wasInactiveRef.current = false;

    if (resumed) {
      void refreshHomeData({ notifyOnRefreshError: true });
      return;
    }

    const overviewChanged = lastOverviewFetchKeyRef.current !== filterKey;
    const callsChanged = lastCallsFetchKeyRef.current !== callsQueryKey;
    if (!overviewChanged && !callsChanged) return;

    if (overviewChanged) {
      void refreshHomeData();
      return;
    }

    const paginationRange = activeRoundRef.current?.filterKey === filterKey
      ? activeRoundRef.current.range
      : lastFilterRangeRef.current?.filterKey === filterKey
        ? lastFilterRangeRef.current.range
        : resolveTimeRange(
          latestQueryRef.current.preset,
          latestQueryRef.current.quick,
          latestQueryRef.current.customRange,
          new Date(),
        );
    lastCallsFetchKeyRef.current = callsQueryKey;
    void fetchCalls({ range: paginationRange });
  }, [abortAllQueries, callsQueryKey, fetchCalls, filterKey, isHomeActive, refreshHomeData]);

  // Manage a single route- and visibility-aware auto-refresh timer without blur pauses or drift pileups.
  useEffect(() => {
    if (!isHomeActive) return;
    let disposed = false;
    let timerId: number | null = null;
    const intervalMs = Math.max(1, homeRefreshIntervalSeconds) * 1000;

    const scheduleAfter = (remainingMs: number) => {
      if (disposed) return;
      const stepMs = Math.min(remainingMs, REFRESH_TIMER_CHUNK_MS);
      timerId = window.setTimeout(() => {
        timerId = null;
        if (disposed) return;
        const nextRemaining = remainingMs - stepMs;
        if (nextRemaining > 0) {
          scheduleAfter(nextRemaining);
          return;
        }
        if (document.visibilityState === "visible") {
          void refreshHomeData({ notifyOnRefreshError: true });
        }
        scheduleAfter(intervalMs);
      }, stepMs);
    };

    scheduleAfter(intervalMs);
    return () => {
      disposed = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [homeRefreshIntervalSeconds, isHomeActive, refreshHomeData]);

  // Propagate external store refreshes (e.g. model pricing changes or storage clear).
  useEffect(() => {
    if (refreshTick === prevRefreshTickRef.current) return;
    const previousTick = prevRefreshTickRef.current;
    prevRefreshTickRef.current = refreshTick;
    if (manualRefreshPendingTickRef.current === refreshTick) {
      manualRefreshPendingTickRef.current = null;
      return;
    }
    if (previousTick === 0 && refreshTick === 1 && hasInitializedMountRef.current) {
      return;
    }
    if (!isHomeActive) {
      wasInactiveRef.current = true;
      return;
    }
    void refreshHomeData({ notifyOnRefreshError: true });
  }, [isHomeActive, refreshHomeData, refreshTick]);

  // Ensure in-flight Home queries abort when the component fully unmounts.
  useEffect(() => abortAllQueries, [abortAllQueries]);

  const hasMatchingOverview = rangeState?.filterKey === filterKey;
  const filteredOverview = hasMatchingOverview ? rangeState.overview : null;
  const effectiveOverviewError = !hasMatchingOverview && overviewErrorState?.filterKey === filterKey
    ? overviewErrorState.message
    : null;

  const hasMatchingCallsFilter = callsState?.filterKey === filterKey;
  const hasMatchingCallsPage = hasMatchingCallsFilter
    && callsState.page === callsPage
    && callsState.pageSize === callsPageSize;
  const callsItems = hasMatchingCallsPage ? callsState.items : [];
  const callsTotal = hasMatchingCallsFilter ? callsState.total : 0;
  const effectiveCallsError = !hasMatchingCallsPage
    && callsErrorState?.filterKey === filterKey
    && callsErrorState.page === callsPage
    && callsErrorState.pageSize === callsPageSize
    ? callsErrorState.message
    : null;
  const callsTableLoading = !hasMatchingCallsPage && !effectiveCallsError && callsLoading;

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
      if (preset === "custom" && quick) {
        const range = quickPresetRange(quick);
        setCustomEnd(formatTimeInput(new Date(range.endMs)));
        setCustomStart(formatTimeInput(new Date(range.startMs)));
      } else if (!customStart && !customEnd) {
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
    const nextQuick: QuickPreset = durationMs === quickPresetDurationMs("four-hours")
      ? "four-hours"
      : "twenty-four-hours";
    const range = quickPresetRange(nextQuick);
    const modelsChanged = appliedModels.length !== selectedModels.length
      || appliedModels.some((model, index) => model !== selectedModels[index]);
    const filterUnchanged = preset === "custom"
      && quick === nextQuick
      && customRange === null
      && !modelsChanged
      && callsPage === 1;
    setCustomStart(formatTimeInput(new Date(range.startMs)));
    setCustomEnd(formatTimeInput(new Date(range.endMs)));
    setCustomRange(null);
    setAppliedModels(selectedModels);
    setQuick(nextQuick);
    setPreset("custom");
    setCustomOpen(false);
    setCallsPage(1);
    if (filterUnchanged) {
      void refreshHomeData();
    }
  };

  const selectPreset = (value: Exclude<OverviewRangePreset, "custom">) => {
    setPreset(value);
    setQuick(null);
    setCustomOpen(false);
    setCallsPage(1);
  };

  const refresh = async () => {
    const tickBefore = appStore.getSnapshot().refreshTick;
    setManualRefreshing(true);
    try {
      manualRefreshPendingTickRef.current = tickBefore + 1;
      const homePromise = refreshHomeData({ notifyOnRefreshError: true });
      const storePromise = appStore.getSnapshot().busy ? Promise.resolve() : appStore.refresh();
      await Promise.all([homePromise, storePromise]);
    } finally {
      if (appStore.getSnapshot().refreshTick <= tickBefore) {
        manualRefreshPendingTickRef.current = null;
      }
      setManualRefreshing(false);
    }
  };

  const openAllCalls = () => {
    const activeQuickRange = preset === "custom" && quick ? quickPresetRange(quick) : null;
    appStore.handoffCallsFilter({
      preset,
      quick,
      customRange,
      customStart: activeQuickRange ? formatTimeInput(new Date(activeQuickRange.startMs)) : customStart,
      customEnd: activeQuickRange ? formatTimeInput(new Date(activeQuickRange.endMs)) : customEnd,
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
      estimatedHeight: 210,
      content: <ContributionCalendarChart
        data={contribution}
        loading={rangeBusy && !hasMatchingOverview}
        error={effectiveOverviewError}
      />,
    },
    {
      key: "tabs",
      estimatedHeight: 360,
      content: <OverviewTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        calls={callsItems}
        callsTotal={callsTotal}
        callsReady={hasMatchingCallsFilter && !effectiveCallsError}
        callsQueryKey={callsQueryKey}
        callsPageReady={hasMatchingCallsPage && !effectiveCallsError}
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
        callsError={effectiveCallsError}
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
          onClick={() => appStore.selectCurrency("USD")}
        >USD</button>
        <button
          type="button"
          aria-pressed={currency === "CNY"}
          onClick={() => appStore.selectCurrency("CNY")}
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
          disabled={busy || manualRefreshing}
          onClick={() => void refresh()}
        >
          <Icon className={(busy || manualRefreshing) ? controls.spin : ""} icon={refreshIcon} size="1.1em" />
        </button>
      </TooltipTrigger>
    </PageActions>
    <PageContent title={t("概览")} sections={sections} />
  </>;
}
