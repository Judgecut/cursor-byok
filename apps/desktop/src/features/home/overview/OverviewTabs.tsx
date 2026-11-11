import type {
  LlmCall,
  OverviewModelSummary,
  OverviewSupplierBreakdown,
  PluginDescriptor,
} from "../../../shared/api";
import controls from "../../../shared/ui/Controls.module.scss";
import { Tabs, type TabItem } from "../../../shared/ui/Tabs";
import type { ServerPagination } from "../../../shared/ui/DataTable";
import type { DisplayCurrency } from "../../../shared/utils/costFormat";
import { CallTable } from "../../calls/CallTable";
import { HomeModelBreakdown } from "../models/HomeModelBreakdown";
import { HomeSupplierBreakdown } from "../suppliers/HomeSupplierBreakdown";

export type OverviewTabId = "calls" | "suppliers" | "models";

export function OverviewTabs({
  activeTab,
  onTabChange,
  calls,
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
  models,
  overviewReady,
  plugins,
  overallTokenUsage,
  currency,
  cnyRate,
  overviewLoading,
  overviewError,
}: {
  activeTab: OverviewTabId;
  onTabChange: (tab: OverviewTabId) => void;
  calls: LlmCall[];
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
  models: OverviewModelSummary[];
  overviewReady: boolean;
  plugins: PluginDescriptor[];
  overallTokenUsage: number;
  currency: DisplayCurrency;
  cnyRate: string | null;
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
        plugins={plugins}
        overallTokenUsage={overallTokenUsage}
        currency={currency}
        cnyRate={cnyRate}
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
        cnyRate={cnyRate}
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
