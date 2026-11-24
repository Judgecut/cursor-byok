import { useCallback, useEffect, useMemo, useState } from "react";
import { useKeepAliveContext } from "keepalive-for-react";
import { useI18n } from "../../i18n/store";
import {
  api,
  type LlmCall,
  type OverviewFilterModel,
  type OverviewFilterSupplier,
} from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { SupplierFilter } from "../../shared/ui/SupplierFilter";
import { buildModelFilterOptions, buildSupplierFilterOptions } from "../../shared/utils/supplierOptions";
import { resolveTimeRange, type CustomRange, type OverviewRangePreset, type QuickPreset } from "../../shared/utils/timeRange";
import { PageActions } from "../../shell/PageActions";
import { PageContent } from "../../shell/layout/PageContent";
import { OverviewTimeRangeFilter } from "../home/overview/OverviewTimeRangeFilter";
import { CallTable } from "./CallTable";
import styles from "./CallsPage.module.scss";

const DEFAULT_CALLS_PAGE_SIZE = 100;

export function CallsPage() {
  const { overview, plugins, providers, pendingCallsFilter, refreshTick, callsRefreshIntervalSeconds } = useAppStore();
  const { active } = useKeepAliveContext();
  const { locale } = useI18n();
  const [preset, setPreset] = useState<OverviewRangePreset | "all">("all");
  const [quick, setQuick] = useState<QuickPreset | null>(null);
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [appliedModels, setAppliedModels] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_CALLS_PAGE_SIZE);
  const [callsResult, setCallsResult] = useState<{
    filterKey: string;
    page: number;
    pageSize: number;
    items: LlmCall[];
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [supplierCatalog, setSupplierCatalog] = useState<OverviewFilterSupplier[]>([]);
  const [modelCatalog, setModelCatalog] = useState<OverviewFilterModel[]>([]);
  const [manualRefreshTick, setManualRefreshTick] = useState(0);

  const filterKey = useMemo(
    () => JSON.stringify({
      preset,
      quick,
      customRange,
      suppliers: selectedSuppliers,
      models: appliedModels,
    }),
    [appliedModels, customRange, preset, quick, selectedSuppliers],
  );

  // Sync supplier & model catalogs when opened directly before/without visiting Overview.
  useEffect(() => {
    if (overview.available_suppliers.length > 0) {
      setSupplierCatalog(overview.available_suppliers);
    }
    if (overview.available_models.length > 0) {
      setModelCatalog(overview.available_models);
    }
  }, [overview.available_models, overview.available_suppliers]);

  // Accept one-shot handoff from Overview on jump without coupling subsequent edits.
  useEffect(() => {
    if (!pendingCallsFilter) return;
    setPreset(pendingCallsFilter.preset);
    setQuick(pendingCallsFilter.quick);
    setCustomRange(pendingCallsFilter.customRange);
    setSelectedSuppliers(pendingCallsFilter.suppliers);
    setSelectedModels(pendingCallsFilter.models);
    setAppliedModels(pendingCallsFilter.models);
    setCustomOpen(false);
    setPage(1);
    appStore.consumeCallsFilter(pendingCallsFilter.nonce);
  }, [pendingCallsFilter]);

  const activeRange = useMemo(() => {
    if (preset === "all") return undefined;
    return resolveTimeRange(preset, quick, customRange) ?? undefined;
  }, [customRange, preset, quick]);

  const loadCalls = useCallback((signal: AbortSignal, showLoadingState: boolean) => {
    const requestFilterKey = filterKey;
    const requestPage = page;
    const requestPageSize = pageSize;
    const range = preset === "all"
      ? undefined
      : (resolveTimeRange(preset, quick, customRange) ?? undefined);
    if (showLoadingState) setLoading(true);
    setError(null);
    return api.calls({
      startMs: range?.startMs,
      endMs: range?.endMs,
      suppliers: selectedSuppliers,
      supplierKeys: appliedModels,
      limit: requestPageSize,
      offset: (requestPage - 1) * requestPageSize,
    }, { signal }).then((result) => {
      if (signal.aborted)
      {
        return;
      }
      setCallsResult({
        filterKey: requestFilterKey,
        page: requestPage,
        pageSize: requestPageSize,
        items: result.items,
        total: result.total,
      });
      setError(null);
    }).catch((cause) => {
      if (signal.aborted)
      {
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!signal.aborted)
      {
        setLoading(false);
      }
    });
  }, [appliedModels, customRange, filterKey, page, pageSize, preset, quick, selectedSuppliers]);

  useEffect(() =>
  {
    if (!active)
    {
      return;
    }
    const controller = new AbortController();
    let pending = false;

    const refresh = async (showLoading: boolean) =>
    {
      if (pending)
      {
        return;
      }
      pending = true;
      await loadCalls(controller.signal, showLoading);
      pending = false;
    };
    const refreshIfVisible = () =>
    {
      if (document.visibilityState === "visible")
      {
        void refresh(false);
      }
    };
    void refresh(true);
    const interval = window.setInterval(refreshIfVisible, callsRefreshIntervalSeconds * 1_000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () =>
    {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [active, callsRefreshIntervalSeconds, loadCalls, manualRefreshTick, refreshTick]);

  const supplierOptions = useMemo(
    () => buildSupplierFilterOptions(
      supplierCatalog.length > 0 ? supplierCatalog : overview.available_suppliers,
      plugins,
      locale,
      new Map(providers.map((provider) => [provider.provider_id, provider.icon])),
    ),
    [locale, overview.available_suppliers, plugins, providers, supplierCatalog],
  );

  const modelOptions = useMemo(
    () => buildModelFilterOptions(
      modelCatalog.length > 0 ? modelCatalog : overview.available_models,
      plugins,
      locale,
    ),
    [locale, modelCatalog, overview.available_models, plugins],
  );

  const openCustom = (open: boolean) => {
    if (open) setSelectedModels(appliedModels);
    setCustomOpen(open);
  };

  const applyCustom = (range: CustomRange) => {
    setCustomRange(range);
    setAppliedModels(selectedModels);
    setQuick(null);
    setPreset("custom");
    setCustomOpen(false);
    setPage(1);
  };

  const selectQuick = (nextQuick: QuickPreset) => {
    const modelsChanged = appliedModels.length !== selectedModels.length
      || appliedModels.some((model, index) => model !== selectedModels[index]);
    const filterUnchanged = preset === "custom"
      && quick === nextQuick
      && customRange === null
      && !modelsChanged
      && page === 1;
    setCustomRange(null);
    setAppliedModels(selectedModels);
    setQuick(nextQuick);
    setPreset("custom");
    setCustomOpen(false);
    setPage(1);
    if (filterUnchanged)
    {
      setManualRefreshTick((tick) => tick + 1);
    }
  };

  const selectPreset = (nextPreset: Exclude<OverviewRangePreset, "custom">) => {
    setPreset(nextPreset);
    setQuick(null);
    setCustomOpen(false);
    setPage(1);
  };

  const selectAllTime = () => {
    setPreset("all");
    setQuick(null);
    setCustomOpen(false);
    setPage(1);
  };

  const changeSuppliers = (nextSuppliers: string[]) => {
    setSelectedSuppliers(nextSuppliers);
    setPage(1);
  };

  const hasMatchingCallsFilter = callsResult?.filterKey === filterKey;
  const hasMatchingCallsPage = hasMatchingCallsFilter
    && callsResult.page === page
    && callsResult.pageSize === pageSize;
  const keepPreviousCalls = callsResult !== null && !hasMatchingCallsPage && !error;
  const calls = hasMatchingCallsPage && !error
    ? callsResult.items
    : keepPreviousCalls
      ? callsResult.items
      : [];
  const total = hasMatchingCallsFilter && !error
    ? callsResult.total
    : keepPreviousCalls
      ? callsResult.total
      : 0;
  const callsTableLoading = !error && (loading || !hasMatchingCallsPage);

  const emptyText = error
    ? t("调用记录加载失败：{error}", { error })
    : (selectedSuppliers.length > 0 || appliedModels.length > 0 || activeRange !== undefined)
      ? t("当前筛选范围内暂无调用记录")
      : t("暂无数据");

  const content = <div className={styles.page}>
    <CallTable
      calls={calls}
      queryKey={`${filterKey}|${page}|${pageSize}`}
      ready={hasMatchingCallsPage && !error}
      onDetails={(call) => void appStore.openCallDetails(call.call_id)}
      loading={callsTableLoading}
      emptyText={emptyText}
      serverPagination={{
        page,
        pageSize,
        total,
        onPageChange: setPage,
        onPageSizeChange: (nextSize) => {
          setPageSize(nextSize);
          setPage(1);
        },
      }}
    />
  </div>;

  return <>
    <PageActions position="left">
      <OverviewTimeRangeFilter
        value={preset}
        allowAll
        allSelected={preset === "all"}
        quick={quick}
        customRange={customRange}
        customOpen={customOpen}
        modelOptions={modelOptions}
        selectedModels={selectedModels}
        onSelectAll={selectAllTime}
        onSelect={selectPreset}
        onQuickSelect={selectQuick}
        onCustomOpenChange={openCustom}
        onSelectedModelsChange={setSelectedModels}
        onCustomApply={applyCustom}
      />
      <SupplierFilter
        value={selectedSuppliers}
        options={supplierOptions}
        onChange={changeSuppliers}
      />
    </PageActions>
    <PageContent fixed title={t("调用")} sections={[{ key: "calls", estimatedHeight: 720, content }]} />
  </>;
}
