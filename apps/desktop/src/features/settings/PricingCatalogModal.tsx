import { useEffect, useMemo, useRef, useState } from "react";
import { api, type CatalogModel, type CatalogSearchResult, type SupplierPricingView } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/FormControls";
import { Modal } from "../../shared/ui/Modal";
import { Select } from "../../shared/ui/Select";
import { formatRatePerMillion } from "../../shared/utils/costFormat";
import { VirtualList } from "../../shared/virtual/VirtualList";
import styles from "./PricingCatalogModal.module.scss";

const PAGE_LIMIT = 200;

export function PricingCatalogModal({
  open,
  target,
  busy,
  onClose,
  onSelect,
}: {
  open: boolean;
  target: SupplierPricingView | null;
  busy: boolean;
  onClose: () => void;
  onSelect: (catalog: CatalogModel) => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogSearchResult | null>(null);
  const [items, setItems] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const activeTargetKey = open && target ? target.supplier_key : null;

  useEffect(() => {
    requestSeqRef.current += 1;
    setLoading(false);
    setLoadingMore(false);
    setError(null);
    setCatalog(null);
    setItems([]);
    if (!open || !target) {
      setProviderId("");
      setQuery("");
      setDebouncedQuery("");
      setReadyKey(null);
      return;
    }
    setProviderId("");
    setQuery(target.model_id);
    setDebouncedQuery(target.model_id.trim());
    setReadyKey(target.supplier_key);
  }, [activeTargetKey, open]);

  useEffect(() => {
    if (!open || !activeTargetKey) return;
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [activeTargetKey, open, query]);

  useEffect(() => {
    if (!open || !activeTargetKey || readyKey !== activeTargetKey) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    void api.pricingCatalog({
      query: debouncedQuery || undefined,
      providerId: providerId || undefined,
      limit: PAGE_LIMIT,
      offset: 0,
    }).then((result) => {
      if (requestSeqRef.current !== seq) return;
      setCatalog(result);
      setItems(result.items);
    }).catch((cause) => {
      if (requestSeqRef.current !== seq) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (requestSeqRef.current === seq) setLoading(false);
    });
    return () => {
      if (requestSeqRef.current === seq) {
        requestSeqRef.current += 1;
      }
    };
  }, [activeTargetKey, debouncedQuery, open, providerId, readyKey]);

  const loadMore = async () => {
    if (!open || !activeTargetKey || !catalog || loading || loadingMore || items.length >= catalog.total) return;
    const seq = ++requestSeqRef.current;
    const requestOffset = items.length;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await api.pricingCatalog({
        query: debouncedQuery || undefined,
        providerId: providerId || undefined,
        limit: PAGE_LIMIT,
        offset: requestOffset,
      });
      if (requestSeqRef.current !== seq) return;
      setCatalog(next);
      setItems((current) => [...current, ...next.items]);
    } catch (cause) {
      if (requestSeqRef.current !== seq) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestSeqRef.current === seq) setLoadingMore(false);
    }
  };

  const providerOptions = useMemo(() => [
    { value: "", label: t("全部厂商") },
    ...(catalog?.providers ?? []).map((provider) => ({
      value: provider.provider_id,
      label: `${provider.provider_name} (${provider.model_count})`,
    })),
  ], [catalog?.providers]);

  const total = catalog?.total ?? 0;
  const hasMore = items.length < total;
  const banner = target && <div className={styles.banner}>
    <div className={styles.targetInfo}>
      <strong>{target.display_name}</strong>
      <code>{target.model_id}</code>
      <code>{target.endpoint_key}</code>
    </div>
    <div className={styles.controls}>
      <Select
        value={providerId}
        ariaLabel={t("目录厂商筛选")}
        options={providerOptions}
        onChange={setProviderId}
      />
      <TextInput
        value={query}
        placeholder={t("搜索厂商、模型 ID、名称或 API 地址")}
        aria-label={t("搜索公开目录模型")}
        onChange={(event) => setQuery(event.target.value)}
      />
    </div>
    <div className={styles.summary}>
      <span>{loading ? t("正在搜索公开目录…") : t("共 {total} 条匹配条目（已加载 {shown} 条）", { total, shown: items.length })}</span>
      {error && <span className={styles.error} role="alert">{error}</span>}
    </div>
  </div>;

  return <Modal
    open={open && target !== null}
    title={t("选择公开价目表条目")}
    banner={banner}
    wide
    fullHeight
    scrollable={false}
    busy={busy}
    closeLabel={t("关闭")}
    secondaryAction={hasMore
      ? <Button size="small" disabled={busy || loading || loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? t("加载中…") : t("加载更多")}
        </Button>
      : undefined}
    onClose={onClose}
  >
    <div className={styles.listFrame}>
      <VirtualList
        items={items}
        itemKey={(item) => `${item.provider_id}::${item.model_id}`}
        estimatedItemHeight={86}
        itemGap={8}
        className={styles.list}
        empty={<div className={styles.empty}>
          {loading
            ? t("正在加载公开目录…")
            : debouncedQuery || providerId
              ? t("未找到匹配的公开目录模型")
              : t("公开目录暂无数据，请先在设置页点击“立即刷新”。")}
        </div>}
      >
        {(item) => {
          const isMatched = Boolean(
            target?.matched_provider_id === item.provider_id
            && target?.matched_model_id === item.model_id,
          );
          return <div className={[styles.row, isMatched && styles.rowSelected].filter(Boolean).join(" ")}>
            <div className={styles.rowMain}>
              <div className={styles.rowHeader}>
                <span className={styles.providerBadge}>{item.provider_name}</span>
                <strong>{item.model_name}</strong>
                <code>{item.provider_id} / {item.model_id}</code>
              </div>
              {item.provider_api && <span className={styles.apiUrl}>{item.provider_api}</span>}
              <div className={styles.rates}>
                <span>{t("输入")} {formatRatePerMillion(item.rates.input_per_million)}</span>
                <span>{t("输出")} {formatRatePerMillion(item.rates.output_per_million)}</span>
                <span>{t("缓存读")} {formatRatePerMillion(item.rates.cache_read_per_million)}</span>
                <span>{t("缓存写")} {formatRatePerMillion(item.rates.cache_write_per_million)}</span>
              </div>
            </div>
            <Button
              size="small"
              variant={isMatched ? "secondary" : "primary"}
              disabled={busy}
              onClick={() => onSelect(item)}
            >
              {isMatched ? t("当前已选") : t("选择")}
            </Button>
          </div>;
        }}
      </VirtualList>
    </div>
  </Modal>;
}
