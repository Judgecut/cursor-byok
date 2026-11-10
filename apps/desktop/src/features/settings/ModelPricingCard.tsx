import { useEffect, useMemo, useState } from "react";
import type { CatalogModel, PricingRates, SupplierPricingView } from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Icon } from "../../shared/ui/Icon";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../../shared/ui/icons";
import { Select } from "../../shared/ui/Select";
import { Switch } from "../../shared/ui/Switch";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import { formatRatePerMillion, isValidCustomPriceInput } from "../../shared/utils/costFormat";
import { VirtualList } from "../../shared/virtual/VirtualList";
import { PricingCatalogModal } from "./PricingCatalogModal";
import styles from "./ModelPricingCard.module.scss";

type FilterMode = "all" | "unpriced" | "custom" | "catalog" | "historical";

type RatesDraft = {
  input_per_million: string;
  output_per_million: string;
  cache_read_per_million: string;
  cache_write_per_million: string;
};

const EMPTY_RATES: PricingRates = {
  input_per_million: null,
  output_per_million: null,
  cache_read_per_million: null,
  cache_write_per_million: null,
};

function hasAnyRate(rates: PricingRates) {
  return Boolean(
    rates.input_per_million != null
    || rates.output_per_million != null
    || rates.cache_read_per_million != null
    || rates.cache_write_per_million != null,
  );
}

function toDraft(rates: PricingRates): RatesDraft {
  return {
    input_per_million: rates.input_per_million ?? "",
    output_per_million: rates.output_per_million ?? "",
    cache_read_per_million: rates.cache_read_per_million ?? "",
    cache_write_per_million: rates.cache_write_per_million ?? "",
  };
}

function parseCustomRatesDraft(draft: RatesDraft): PricingRates {
  const fields: Array<[keyof RatesDraft, string]> = [
    ["input_per_million", t("输入价格")],
    ["output_per_million", t("输出价格")],
    ["cache_read_per_million", t("缓存读取价格")],
    ["cache_write_per_million", t("缓存写入价格")],
  ];
  for (const [key, label] of fields) {
    if (!isValidCustomPriceInput(draft[key])) {
      throw new Error(t("{label}必须是非负十进制数字或留空", { label }));
    }
  }
  const clean = (value: string) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };
  return {
    input_per_million: clean(draft.input_per_million),
    output_per_million: clean(draft.output_per_million),
    cache_read_per_million: clean(draft.cache_read_per_million),
    cache_write_per_million: clean(draft.cache_write_per_million),
  };
}

function effectiveSourceLabel(item: SupplierPricingView) {
  if (item.effective_source === "custom") return t("自定义定价");
  if (item.effective_source === "catalog") return t("公开目录");
  return t("未定价");
}

function catalogMatchSummary(item: SupplierPricingView) {
  const target = item.matched_provider_id && item.matched_model_id
    ? `${item.matched_provider_name ?? item.matched_provider_id} / ${item.matched_model_id}`
    : null;
  switch (item.catalog_match_kind) {
    case "manual":
      return t("手动绑定：{target}", { target: target ?? "" });
    case "manual_missing":
      return t("手动绑定缺失（未在当前目录找到）：{target}", { target: target ?? "" });
    case "auto_exact":
      return t("自动精确匹配：{target}", { target: target ?? "" });
    case "auto_unique":
      return t("自动模型唯一匹配：{target}", { target: target ?? "" });
    case "auto_default":
      return t("自动默认匹配：{target}", { target: target ?? "" });
    case "none":
      return t("未匹配到公开目录条目");
  }
}

export function ModelPricingCard() {
  const { pricingModels, pricingSync } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [syncingNow, setSyncingNow] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RatesDraft>(() => toDraft(EMPTY_RATES));
  const [catalogTarget, setCatalogTarget] = useState<SupplierPricingView | null>(null);

  useEffect(() => {
    const activeWork = Boolean(pricingSync?.syncing || pricingSync?.backfilling);
    if (!activeWork) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void appStore.refreshPricingSyncOnly().then((next) => {
        if (!disposed && next && !next.syncing && !next.backfilling) {
          void appStore.refreshPricing();
        }
      });
    }, 800);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pricingSync?.backfilling, pricingSync?.syncing]);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pricingModels.filter((item) => {
      if (filterMode === "unpriced" && item.effective_source !== "unpriced") return false;
      if (filterMode === "custom" && item.effective_source !== "custom") return false;
      if (filterMode === "catalog" && item.effective_source !== "catalog") return false;
      if (filterMode === "historical" && item.active) return false;
      if (!q) return true;
      return [
        item.display_name,
        item.model_id,
        item.endpoint_key,
        item.matched_provider_id ?? "",
        item.matched_provider_name ?? "",
        item.matched_model_id ?? "",
      ].some((field) => field.toLowerCase().includes(q));
    });
  }, [filterMode, pricingModels, query]);

  const handleSyncNow = async () => {
    setSyncingNow(true);
    const next = await appStore.syncPricingNow();
    setSyncingNow(false);
    if (!next) {
      const error = appStore.getSnapshot().error;
      if (error) message(error);
      return;
    }
    if (next.last_error) {
      message(t("同步失败：{error}", { error: next.last_error }));
    } else {
      message(t("已同步公开目录（{count} 个模型），如有历史未定价记录将自动回填", { count: next.catalog_model_count }));
    }
  };

  const handleAutoSyncToggle = async (enabled: boolean) => {
    setToggleBusy(true);
    const next = await appStore.setPricingAutoSync(enabled);
    setToggleBusy(false);
    if (!next) {
      const error = appStore.getSnapshot().error;
      if (error) message(error);
    }
  };

  const startEdit = (item: SupplierPricingView) => {
    setEditingKey(item.supplier_key);
    setDraft(toDraft(item.custom_rates));
  };

  const saveEdit = async (item: SupplierPricingView) => {
    try {
      const customRates = parseCustomRatesDraft(draft);
      setSavingKey(item.supplier_key);
      const saved = await appStore.savePricingModel({
        source_kind: item.source_kind,
        endpoint_key: item.endpoint_key,
        model_id: item.model_id,
        binding_mode: item.binding_mode,
        catalog_provider_id: item.binding_mode === "manual" ? item.matched_provider_id : null,
        catalog_model_id: item.binding_mode === "manual" ? item.matched_model_id : null,
        custom_rates: customRates,
      });
      if (!saved) {
        const error = appStore.getSnapshot().error;
        if (error) message(error);
        return;
      }
      setEditingKey(null);
      message(t("模型单价已保存，新调用立即生效并将在后台回填未定价记录"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingKey(null);
    }
  };

  const clearCustomRates = async (item: SupplierPricingView) => {
    setSavingKey(item.supplier_key);
    const saved = await appStore.savePricingModel({
      source_kind: item.source_kind,
      endpoint_key: item.endpoint_key,
      model_id: item.model_id,
      binding_mode: item.binding_mode,
      catalog_provider_id: item.binding_mode === "manual" ? item.matched_provider_id : null,
      catalog_model_id: item.binding_mode === "manual" ? item.matched_model_id : null,
      custom_rates: EMPTY_RATES,
    });
    setSavingKey(null);
    if (!saved) {
      const error = appStore.getSnapshot().error;
      if (error) message(error);
      return;
    }
    if (editingKey === item.supplier_key) setEditingKey(null);
    message(t("已恢复为所绑定的公开目录定价"));
  };

  const restoreAutoBinding = async (item: SupplierPricingView) => {
    setSavingKey(item.supplier_key);
    const saved = await appStore.savePricingModel({
      source_kind: item.source_kind,
      endpoint_key: item.endpoint_key,
      model_id: item.model_id,
      binding_mode: "auto",
      catalog_provider_id: null,
      catalog_model_id: null,
      custom_rates: item.custom_rates,
    });
    setSavingKey(null);
    if (!saved) {
      const error = appStore.getSnapshot().error;
      if (error) message(error);
      return;
    }
    message(t("已恢复自动目录匹配"));
  };

  const bindCatalogModel = async (catalog: CatalogModel) => {
    if (!catalogTarget) return;
    setSavingKey(catalogTarget.supplier_key);
    const saved = await appStore.savePricingModel({
      source_kind: catalogTarget.source_kind,
      endpoint_key: catalogTarget.endpoint_key,
      model_id: catalogTarget.model_id,
      binding_mode: "manual",
      catalog_provider_id: catalog.provider_id,
      catalog_model_id: catalog.model_id,
      custom_rates: EMPTY_RATES,
    });
    setSavingKey(null);
    if (!saved) {
      const error = appStore.getSnapshot().error;
      if (error) message(error);
      return;
    }
    setCatalogTarget(null);
    if (editingKey === catalogTarget.supplier_key) setEditingKey(null);
    message(t("已绑定公开价目表：{provider} / {model}", { provider: catalog.provider_name, model: catalog.model_id }));
  };

  const syncAction = (
    <Button
      size="small"
      disabled={syncingNow || Boolean(pricingSync?.syncing)}
      onClick={() => void handleSyncNow()}
    >
      {syncingNow || pricingSync?.syncing ? t("刷新中…") : t("立即刷新")}
    </Button>
  );

  const listHeight = Math.min(460, Math.max(120, filteredModels.length * 144 + (editingKey ? 136 : 0)));
  const lastSynced = pricingSync?.last_synced_at_ms
    ? new Date(pricingSync.last_synced_at_ms).toLocaleString(locale)
    : t("尚未同步");

  return <>
    <TitledCard title={t("模型定价")} action={syncAction}>
      <div className={styles.content}>
        <div className={styles.syncRow}>
          <div className={styles.syncText}>
            <strong>{t("自动同步公开定价（每 {hours} 小时）", { hours: pricingSync?.sync_interval_hours ?? 6 })}</strong>
            <div className={styles.syncMeta}>
              <span>{t("公开目录：{count} 个模型", { count: pricingSync?.catalog_model_count ?? 0 })}</span>
              <span>·</span>
              <span>{t("上次同步：{time}", { time: lastSynced })}</span>
              {pricingSync?.syncing && <span className={[styles.badge, styles.badgePrimary].join(" ")}>{t("同步目录中…")}</span>}
              {pricingSync?.backfilling && <span className={[styles.badge, styles.badgePrimary].join(" ")}>{t("历史回填中…")}</span>}
            </div>
          </div>
          <Switch
            checked={pricingSync?.auto_sync_enabled ?? true}
            disabled={toggleBusy}
            label={t("自动同步公开定价")}
            onChange={(enabled) => void handleAutoSyncToggle(enabled)}
          />
        </div>

        {pricingSync?.last_error && <div className={styles.errorBanner} role="alert">
          {t("上次目录同步失败：{error}（当前仍保留已缓存目录与自定义单价）", { error: pricingSync.last_error })}
        </div>}

        <div className={styles.toolbar}>
          <TextInput
            value={query}
            placeholder={t("搜索模型名称、Model ID、端点或目录匹配")}
            aria-label={t("搜索模型定价")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            value={filterMode}
            ariaLabel={t("定价状态筛选")}
            options={[
              { value: "all", label: t("全部状态（{count}）", { count: pricingModels.length }) },
              { value: "unpriced", label: t("未定价") },
              { value: "custom", label: t("自定义定价") },
              { value: "catalog", label: t("公开目录") },
              { value: "historical", label: t("历史调用记录") },
            ]}
            onChange={(value) => setFilterMode(value as FilterMode)}
          />
        </div>

        <div className={styles.listFrame} style={{ height: listHeight }}>
          <VirtualList
            items={filteredModels}
            itemKey="supplier_key"
            estimatedItemHeight={132}
            itemGap={10}
            className={styles.list}
            empty={<div className={styles.empty}>{t("没有符合条件的模型或历史调用记录")}</div>}
          >
            {(item) => {
              const busy = savingKey === item.supplier_key;
              const isEditing = editingKey === item.supplier_key;
              const hasCustom = hasAnyRate(item.custom_rates);
              const icon = item.plugin_icon
                ? undefined
                : item.provider_type === "anthropic"
                  ? claudeIcon
                  : item.source_kind === "plugin"
                    ? flatColorOrganizationIcon
                    : openAiIcon;
              const rates: Array<{ label: string; value: string | null; custom: boolean }> = [
                { label: t("输入"), value: item.effective_rates.input_per_million, custom: item.custom_rates.input_per_million != null },
                { label: t("输出"), value: item.effective_rates.output_per_million, custom: item.custom_rates.output_per_million != null },
                { label: t("缓存读"), value: item.effective_rates.cache_read_per_million, custom: item.custom_rates.cache_read_per_million != null },
                { label: t("缓存写"), value: item.effective_rates.cache_write_per_million, custom: item.custom_rates.cache_write_per_million != null },
              ];

              return <div className={styles.itemCard}>
                <div className={styles.itemTop}>
                  <div className={styles.itemIdentity}>
                    <div className={styles.itemTitle}>
                      <Icon icon={icon} src={item.plugin_icon || undefined} size="1em" />
                      <strong>{item.display_name}</strong>
                      <code>{item.model_id}</code>
                      <span className={styles.badge}>
                        {item.source_kind === "plugin" ? t("插件") : t("配置")}
                      </span>
                      {!item.active && <span className={styles.badge}>{t("历史")}</span>}
                      <span className={[
                        styles.badge,
                        item.effective_source === "unpriced" ? styles.badgeWarn : styles.badgePrimary,
                      ].join(" ")}>{effectiveSourceLabel(item)}</span>
                    </div>
                    <div className={styles.itemMeta}>
                      <code>{item.endpoint_key}</code>
                      <span>·</span>
                      <span>{catalogMatchSummary(item)}</span>
                      <span>·</span>
                      <span>
                        {item.unpriced_call_count > 0
                          ? t("{calls} 次调用（{unpriced} 未定价）", { calls: item.call_count, unpriced: item.unpriced_call_count })
                          : t("{calls} 次调用", { calls: item.call_count })}
                      </span>
                    </div>
                  </div>
                  <div className={styles.itemActions}>
                    <Button size="small" disabled={busy} onClick={() => setCatalogTarget(item)}>
                      {t("选择公开价目")}
                    </Button>
                    <Button size="small" disabled={busy} onClick={() => isEditing ? setEditingKey(null) : startEdit(item)}>
                      {isEditing ? t("收起编辑") : t("自定义单价")}
                    </Button>
                    {hasCustom && <Button size="small" disabled={busy} onClick={() => void clearCustomRates(item)}>
                      {t("恢复公开价")}
                    </Button>}
                    {item.binding_mode === "manual" && <Button size="small" disabled={busy} onClick={() => void restoreAutoBinding(item)}>
                      {t("恢复自动匹配")}
                    </Button>}
                  </div>
                </div>

                <div className={styles.ratesGrid}>
                  {rates.map((rate) => <div key={rate.label} className={styles.rateCell}>
                    <span>{rate.label}</span>
                    <strong>
                      {formatRatePerMillion(rate.value)}
                      {rate.custom && <span className={styles.customTag}>{t("自定义")}</span>}
                    </strong>
                  </div>)}
                </div>

                {isEditing && <div className={styles.editor}>
                  <div className={styles.editorGrid}>
                    <FormField label={t("输入价格（$/1M）")}>
                      <TextInput
                        inputMode="decimal"
                        placeholder={item.matched_rates?.input_per_million ?? t("留空回退目录")}
                        value={draft.input_per_million}
                        onChange={(event) => setDraft({ ...draft, input_per_million: event.target.value })}
                      />
                    </FormField>
                    <FormField label={t("输出价格（$/1M）")}>
                      <TextInput
                        inputMode="decimal"
                        placeholder={item.matched_rates?.output_per_million ?? t("留空回退目录")}
                        value={draft.output_per_million}
                        onChange={(event) => setDraft({ ...draft, output_per_million: event.target.value })}
                      />
                    </FormField>
                    <FormField label={t("缓存读取价格（$/1M）")}>
                      <TextInput
                        inputMode="decimal"
                        placeholder={item.matched_rates?.cache_read_per_million ?? t("留空回退目录")}
                        value={draft.cache_read_per_million}
                        onChange={(event) => setDraft({ ...draft, cache_read_per_million: event.target.value })}
                      />
                    </FormField>
                    <FormField label={t("缓存写入价格（$/1M）")}>
                      <TextInput
                        inputMode="decimal"
                        placeholder={item.matched_rates?.cache_write_per_million ?? t("留空回退目录")}
                        value={draft.cache_write_per_million}
                        onChange={(event) => setDraft({ ...draft, cache_write_per_million: event.target.value })}
                      />
                    </FormField>
                  </div>
                  <span className={styles.editorHint}>
                    {t("仅填需要覆盖的字段（单位：美元 / 百万 Token）。输入 0 表示免费；留空将使用绑定公开目录的单价。")}
                  </span>
                  <div className={styles.editorActions}>
                    <Button size="small" disabled={busy} onClick={() => setDraft(toDraft(EMPTY_RATES))}>
                      {t("清空输入")}
                    </Button>
                    <Button size="small" disabled={busy} onClick={() => setEditingKey(null)}>
                      {t("取消")}
                    </Button>
                    <Button size="small" variant="primary" disabled={busy} onClick={() => void saveEdit(item)}>
                      {busy ? t("保存中…") : t("保存")}
                    </Button>
                  </div>
                </div>}
              </div>;
            }}
          </VirtualList>
        </div>
      </div>
    </TitledCard>

    <PricingCatalogModal
      open={catalogTarget !== null}
      target={catalogTarget}
      busy={Boolean(catalogTarget && savingKey === catalogTarget.supplier_key)}
      onClose={() => setCatalogTarget(null)}
      onSelect={(catalog) => void bindCatalogModel(catalog)}
    />
  </>;
}
