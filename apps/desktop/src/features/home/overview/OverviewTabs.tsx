import type {
  LlmCall,
  OverviewModelSummary,
  OverviewSupplierBreakdown,
  PluginDescriptor,
} from "../../../shared/api";
import controls from "../../../shared/ui/Controls.module.scss";
import { Tabs, type TabItem } from "../../../shared/ui/Tabs";
import type { ServerPagination } from "../../../shared/ui/DataTable";
import type { DisplayCurrency, DisplayExchangeRate } from "../../../shared/utils/costFormat";
import { CallTable } from "../../calls/CallTable";
import { HomeModelBreakdown } from "../models/HomeModelBreakdown";
import { HomeSupplierBreakdown } from "../suppliers/HomeSupplierBreakdown";

export type OverviewTabId = "calls" | "suppliers" | "models";

export function OverviewTabs({
  activeTab,
  onTabChange,
  calls,
  animate,
  filterKey,
  callsTotal,
  callsReady,
  callsQueryKey,
  callsPageReady,
  callsPagination,
  callsLoading,
  callsError,
  onCallDetails,
  onOpenAllCalls,
  suppliers,
  providerIcons,
  models,
  overviewReady,
  plugins,
  overallTokenUsage,
  currency,
  exchangeRate,
  overviewLoading,
  overviewError,
}: {
  activeTab: OverviewTabId;
  onTabChange: (tab: OverviewTabId) => void;
  calls: LlmCall[];
  animate: boolean;
  filterKey: string;
  callsTotal: number;
  callsReady: boolean;
  callsQueryKey: string;
  callsPageReady: boolean;
  callsPagination: ServerPagination;
  callsLoading: boolean;
  callsError: string | null;
  onCallDetails: (call: LlmCall) => void;
  onOpenAllCalls: () => void;
  suppliers: OverviewSupplierBreakdown[];
  providerIcons: ReadonlyMap<string, string | null>;
  models: OverviewModelSummary[];
  overviewReady: boolean;
  plugins: PluginDescriptor[];
  overallTokenUsage: number;
  currency: DisplayCurrency;
  exchangeRate: DisplayExchangeRate | null;
  overviewLoading: boolean;
  overviewError: string | null;
}) {
  const items: TabItem[] = [
    {
      value: "calls",
      label: t("调用记录"),
      badge: callsReady ? callsTotal : undefined,
      content: <CallTable
        calls={calls}
        animate={animate}
        queryKey={callsQueryKey}
        ready={callsPageReady}
        onDetails={onCallDetails}
        serverPagination={callsPagination}
        loading={callsLoading}
        emptyText={callsError
          ? t("调用记录加载失败：{error}", { error: callsError })
          : t("当前筛选范围内暂无调用记录")}
      />,
    },
    {
      value: "suppliers",
      label: t("供应商"),
      badge: overviewReady ? suppliers.length : undefined,
      content: <HomeSupplierBreakdown
        suppliers={suppliers}
        providerIcons={providerIcons}
        plugins={plugins}
        overallTokenUsage={overallTokenUsage}
        currency={currency}
        exchangeRate={exchangeRate}
        animate={animate}
        filterKey={filterKey}
        loading={overviewLoading}
        error={overviewError}
      />,
    },
    {
      value: "models",
      label: t("模型"),
      badge: overviewReady ? models.length : undefined,
      content: <HomeModelBreakdown
        models={models}
        overallTokenUsage={overallTokenUsage}
        currency={currency}
        exchangeRate={exchangeRate}
        animate={animate}
        filterKey={filterKey}
        loading={overviewLoading}
        error={overviewError}
      />,
    },
  ];

  return <Tabs
    items={items}
    value={activeTab}
    onChange={(next) => onTabChange(next as OverviewTabId)}
    actions={<button
      type="button"
      className={[controls.secondary, controls.small].join(" ")}
      onClick={onOpenAllCalls}
    >
      {t("查看完整调用记录 →")}
    </button>}
  />;
}
