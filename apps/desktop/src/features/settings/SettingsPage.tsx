import { useEffect, useId, useRef, useState } from "react";
import { api, MAX_CALLS_REFRESH_INTERVAL_SECONDS, MIN_CALLS_REFRESH_INTERVAL_SECONDS, type HomeMotionMode, type ProxySettings, type ProxySettingsInput, type StatisticsStorage, type StatisticsStorageScope, type TabSettings } from "../../shared/api";
import { PageContent } from "../../shell/layout/PageContent";
import { LegacyModelImport } from "../models/LegacyModelImport";
import { AppLifecycleSettingsCard } from "./AppLifecycleSettingsCard";
import { CommitSettingsCard } from "./CommitSettingsCard";
import { CurrencySettingsCard } from "./CurrencySettingsCard";
import { CostQuotaSettingsCard } from "./CostQuotaSettingsCard";
import { ExternalApiSettingsCard } from "./ExternalApiSettingsCard";
import { ModelPricingCard } from "./ModelPricingCard";
import { ProxySettingsCard } from "./ProxySettingsCard";
import { TabSettingsCard } from "./TabSettingsCard";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Select } from "../../shared/ui/Select";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useI18n, type LocalePreference } from "../../i18n/store";
import { useMessage } from "../../shared/ui/message";
import {
  appStore,
  DEFAULT_HOME_REFRESH_INTERVAL_SECONDS,
  parseHomeRefreshIntervalSeconds,
  useAppStore,
} from "../../shared/store/appStore";
import { themeOptions, type ThemeId } from "../../shared/theme/theme";
import styles from "./SettingsPage.module.scss";

function themeLabel(id: ThemeId): string {
  if (id === "system") return t("跟随系统");
  if (id === "default-dark") return t("默认暗色");
  return t("默认亮色");
}

function CallsRefreshSetting()
{
  const { callsRefreshIntervalSeconds } = useAppStore();
  const message = useMessage();
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () =>
  {
    if (saving || draft === null)
    {
      return;
    }
    setSaving(true);
    try
    {
      if (await appStore.saveCallsRefreshIntervalSeconds(Number(draft)))
      {
        setDraft(null);
        message(t("调用详细自动刷新间隔已保存"));
      }
    }
    finally
    {
      setSaving(false);
    }
  };

  return <div className={styles.refreshIntervalSection}>
    <div className={styles.refreshIntervalRow}>
      <div className={styles.refreshIntervalText}>
        <label htmlFor={inputId}>{t("调用详细自动刷新间隔（秒）")}</label>
        <small id={hintId}>{t("可设置为 {min}–{max} 秒，仅在调用详细页可见时自动刷新。", { min: MIN_CALLS_REFRESH_INTERVAL_SECONDS, max: MAX_CALLS_REFRESH_INTERVAL_SECONDS })}</small>
      </div>
      <form className={styles.refreshIntervalForm} onSubmit={(event) =>
      {
        event.preventDefault();
        void save();
      }}>
        <div className={styles.intervalInputWrap}>
          <TextInput id={inputId} aria-describedby={hintId} type="number" required min={MIN_CALLS_REFRESH_INTERVAL_SECONDS} max={MAX_CALLS_REFRESH_INTERVAL_SECONDS} step={1} value={draft ?? String(callsRefreshIntervalSeconds)} disabled={saving} onChange={(event) => setDraft(event.target.value)} />
        </div>
        <span className={styles.intervalUnit}>{t("秒")}</span>
        <Button variant="primary" size="small" type="submit" disabled={saving || draft === null}>{saving ? t("保存中…") : t("保存")}</Button>
      </form>
    </div>
  </div>;
}

export function SettingsPage() {
  const { detailed, ports, theme, homeMotionMode, homeAutoRefreshEnabled, homeRefreshIntervalSeconds } = useAppStore();
  const { preference, locale } = useI18n();
  const message = useMessage();
  const [proxyPort, setProxyPort] = useState(String(ports.proxy_port));
  const [servicePort, setServicePort] = useState(String(ports.service_port));
  const [editingPorts, setEditingPorts] = useState(false);
  const [savingPorts, setSavingPorts] = useState(false);
  const [storage, setStorage] = useState<StatisticsStorage | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearScope, setClearScope] = useState<StatisticsStorageScope>("details");
  const [clearing, setClearing] = useState(false);
  const [outboundProxy, setOutboundProxy] = useState<ProxySettings | null>(null);
  const [proxyDraft, setProxyDraft] = useState<ProxySettingsInput>({ mode: "default", address: "", auth_enabled: false, username: "", password: "" });
  const [editingProxy, setEditingProxy] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);
  const [tabSettings, setTabSettings] = useState<TabSettings | null>(null);
  const [tabDraft, setTabDraft] = useState<TabSettings>({ mode: "public", address: "" });
  const [editingTab, setEditingTab] = useState(false);
  const [savingTab, setSavingTab] = useState(false);
  const [refreshIntervalDraft, setRefreshIntervalDraft] = useState(String(homeRefreshIntervalSeconds));
  const [refreshIntervalError, setRefreshIntervalError] = useState<string | null>(null);
  const [savingRefreshInterval, setSavingRefreshInterval] = useState(false);
  const refreshIntervalInputId = useId();
  const refreshIntervalInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const report = (cause: unknown) => message(cause instanceof Error ? cause.message : String(cause));
    void api.statisticsStorage().then(setStorage).catch(report);
    void api.proxySettings().then((next) => {
      setOutboundProxy(next);
      setProxyDraft({ mode: next.mode, address: next.address, auth_enabled: next.auth_enabled, username: next.username, password: "" });
    }).catch(report);
    void api.tabSettings().then((next) => {
      setTabSettings(next);
      setTabDraft(next);
    }).catch(report);
  }, [message]);
  useEffect(() => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
  }, [ports.proxy_port, ports.service_port]);
  useEffect(() => {
    setRefreshIntervalDraft(String(homeRefreshIntervalSeconds));
    setRefreshIntervalError(null);
  }, [homeRefreshIntervalSeconds]);

  const parsePort = (value: string, label: string) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`${label}${t("必须是 0–65535 之间的整数")}`);
    }
    return port;
  };
  const savePorts = async () => {
    try {
      const next = {
        proxy_port: parsePort(proxyPort, t("代理端口")),
        service_port: parsePort(servicePort, t("服务端口")),
      };
      setSavingPorts(true);
      if (await appStore.updatePorts(next)) {
        setEditingPorts(false);
        message(t("端口设置已保存，重启软件后生效"), { duration: 4_000 });
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingPorts(false);
    }
  };
  const editPorts = () => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
    setEditingPorts(true);
  };
  const cancelPortEdit = () => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
    setEditingPorts(false);
  };
  const clearStorage = async () => {
    try {
      setClearing(true);
      setStorage(await api.clearStatisticsStorage(clearScope));
      setConfirmClear(false);
      await appStore.refresh();
      message(clearScope === "all" ? t("全部统计数据已清理") : t("详细记录已清理"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClearing(false);
    }
  };
  const editProxy = () => {
    if (!outboundProxy) return;
    setProxyDraft({ mode: outboundProxy.mode, address: outboundProxy.address, auth_enabled: outboundProxy.auth_enabled, username: outboundProxy.username, password: "" });
    setEditingProxy(true);
  };
  const cancelProxyEdit = () => {
    if (outboundProxy) {
      setProxyDraft({ mode: outboundProxy.mode, address: outboundProxy.address, auth_enabled: outboundProxy.auth_enabled, username: outboundProxy.username, password: "" });
    }
    setEditingProxy(false);
  };
  const saveProxy = async () => {
    try {
      setSavingProxy(true);
      const saved = await api.setProxySettings({ ...proxyDraft, password: proxyDraft.password || undefined });
      setOutboundProxy(saved);
      setProxyDraft({ mode: saved.mode, address: saved.address, auth_enabled: saved.auth_enabled, username: saved.username, password: "" });
      setEditingProxy(false);
      message(t("代理设置已保存"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingProxy(false);
    }
  };
  const editTab = () => {
    if (!tabSettings) return;
    setTabDraft(tabSettings);
    setEditingTab(true);
  };
  const cancelTabEdit = () => {
    if (tabSettings) setTabDraft(tabSettings);
    setEditingTab(false);
  };
  const saveTab = async () => {
    try {
      if (tabDraft.mode === "custom" && !tabDraft.address.trim()) throw new Error(t("TAB 服务地址不能为空"));
      setSavingTab(true);
      const saved = await api.setTabSettings({ ...tabDraft, address: tabDraft.address.trim() });
      setTabSettings(saved);
      setTabDraft(saved);
      setEditingTab(false);
      message(t("TAB 设置已保存"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingTab(false);
    }
  };
  const saveHomeRefreshInterval = async () => {
    if (savingRefreshInterval) return;
    const trimmed = refreshIntervalDraft.trim();
    if (!trimmed) {
      setRefreshIntervalError(t("请输入大于 0 的整数秒数"));
      refreshIntervalInputRef.current?.focus();
      return;
    }
    if (!/^\d+$/.test(trimmed)) {
      setRefreshIntervalError(t("主页自动刷新间隔必须是大于 0 的整数秒数"));
      refreshIntervalInputRef.current?.focus();
      refreshIntervalInputRef.current?.select();
      return;
    }
    const parsed = parseHomeRefreshIntervalSeconds(trimmed);
    if (parsed === null) {
      setRefreshIntervalError(Number(trimmed) === 0
        ? t("主页自动刷新间隔必须是大于 0 的整数秒数")
        : t("主页自动刷新间隔超出有效整数范围"));
      refreshIntervalInputRef.current?.focus();
      refreshIntervalInputRef.current?.select();
      return;
    }
    setSavingRefreshInterval(true);
    try {
      const saved = await appStore.saveHomeRefreshIntervalSeconds(parsed);
      if (saved === null) {
        return;
      }
      setRefreshIntervalDraft(String(saved));
      setRefreshIntervalError(null);
      message(t("主页自动刷新间隔已保存（每 {seconds} 秒）", { seconds: saved }));
    } finally {
      setSavingRefreshInterval(false);
    }
  };
  const clearTitle = clearScope === "all" ? t("确定要清理全部统计数据吗？") : t("确定要清理详细记录吗？");
  const clearDescription = clearScope === "all"
    ? t("所有调用汇总、详细内容和追踪记录都会被删除。模型配置、CA 和应用设置不会受到影响，此操作无法撤销。")
    : t("仅删除请求、响应和追踪附件等详细内容，保留调用汇总、统计指标和配置。");
  const content = (
    <div className={styles.page}>
      <TitledCard title={t("调用观测")}>
        <div className={styles.settingRow}>
          <div>
            <strong>{t("详细模式")}</strong>
            <small>
              {t("额外保存完整请求和流响应；默认只保存时间、状态与用量。")}
            </small>
          </div>
          <Checkbox
            label={t("详细模式")}
            checked={detailed}
            onChange={(checked) => void appStore.updateDetailed(checked)}
          />
        </div>
        <CallsRefreshSetting />
      </TitledCard>
      <TitledCard title={t("数据概览")}>
        <div className={styles.settingRow}>
          <div>
            <strong>{t("主页动画")}</strong>
            <small>{t("控制主页图表和更新提示的动画。")}</small>
          </div>
          <div className={styles.languageControl}>
            <Select
              value={homeMotionMode}
              ariaLabel={t("主页动画")}
              options={[
                { value: "system", label: t("跟随系统") },
                { value: "on", label: t("开启") },
                { value: "off", label: t("关闭动画") },
              ]}
              onChange={(value) => appStore.selectHomeMotionMode(value as HomeMotionMode)}
            />
          </div>
        </div>
        <div className={styles.settingRow}>
          <div>
            <strong>{t("主页自动刷新")}</strong>
            <small>{t("关闭后可通过主页刷新按钮更新统计数据。")}</small>
          </div>
          <Checkbox label={t("自动刷新")} checked={homeAutoRefreshEnabled} onChange={appStore.selectHomeAutoRefresh} />
        </div>
        <div className={styles.refreshIntervalSection}>
          <div className={styles.refreshIntervalRow}>
            <div className={styles.refreshIntervalText}>
              <label htmlFor={refreshIntervalInputId}>{t("主页自动刷新间隔（秒）")}</label>
              <small>
                {t("默认 {seconds} 秒。仅在数据概览页处于当前页面且窗口可见时按该间隔刷新。", {
                  seconds: DEFAULT_HOME_REFRESH_INTERVAL_SECONDS,
                })}
              </small>
            </div>
            <form
              className={styles.refreshIntervalForm}
              onSubmit={(event) => {
                event.preventDefault();
                void saveHomeRefreshInterval();
              }}
            >
              <div className={styles.intervalInputWrap}>
                <TextInput
                  id={refreshIntervalInputId}
                  ref={refreshIntervalInputRef}
                  type="text"
                  inputMode="numeric"
                  value={refreshIntervalDraft}
                  disabled={!homeAutoRefreshEnabled}
                  aria-label={t("主页自动刷新间隔（秒）")}
                  aria-invalid={refreshIntervalError ? true : undefined}
                  placeholder={String(DEFAULT_HOME_REFRESH_INTERVAL_SECONDS)}
                  onChange={(event) => {
                    setRefreshIntervalDraft(event.target.value);
                    if (refreshIntervalError) setRefreshIntervalError(null);
                  }}
                />
              </div>
              <span className={styles.intervalUnit}>{t("秒")}</span>
              <Button variant="primary" size="small" type="submit" disabled={savingRefreshInterval || !homeAutoRefreshEnabled}>
                {savingRefreshInterval ? t("保存中…") : t("保存")}
              </Button>
            </form>
          </div>
          {refreshIntervalError && <div className={styles.rateError} role="alert">{refreshIntervalError}</div>}
        </div>
      </TitledCard>
      <TitledCard title={t("端口设置")} action={editingPorts ? (
        <div className={styles.cardActions}>
          <Button size="small" disabled={savingPorts} onClick={cancelPortEdit}>{t("取消")}</Button>
          <Button variant="primary" size="small" disabled={savingPorts} onClick={() => void savePorts()}>{savingPorts ? t("保存中…") : t("保存")}</Button>
        </div>
      ) : (
        <button type="button" className={styles.textButton} onClick={editPorts}>{t("编辑")}</button>
      )}>
        <div className={styles.portSettings}>
          <div className={styles.portFields}>
            {editingPorts ? <><FormField
              label={t("代理端口")}
              hint={t("Cursor 使用的本地代理端口；填写 0 时启动时随机选择。")}
            >
              <TextInput
                type="number"
                min={0}
                max={65535}
                step={1}
                value={proxyPort}
                onChange={(event) => setProxyPort(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("服务端口")}
              hint={t(
                "桌面前端连接的本地管理服务端口；填写 0 时启动时随机选择。",
              )}
            >
              <TextInput
                type="number"
                min={0}
                max={65535}
                step={1}
                value={servicePort}
                onChange={(event) => setServicePort(event.target.value)}
              />
            </FormField></> : <>
              <div className={styles.portValue}><strong>{t("代理端口")}</strong><span>{ports.proxy_port}</span></div>
              <div className={styles.portValue}><strong>{t("服务端口")}</strong><span>{ports.service_port}</span></div>
            </>}
          </div>
          <div className={styles.portFooter}>
            <small>
              {t(
                "端口被占用时会自动选择新的随机端口并保存。修改后需要重启软件才会生效。",
              )}
            </small>
          </div>
        </div>
      </TitledCard>
      <ExternalApiSettingsCard servicePort={ports.service_port} />
      <ProxySettingsCard settings={outboundProxy} draft={proxyDraft} editing={editingProxy} saving={savingProxy} onDraftChange={setProxyDraft} onEdit={editProxy} onCancel={cancelProxyEdit} onSave={() => void saveProxy()} />
      <TabSettingsCard settings={tabSettings} draft={tabDraft} editing={editingTab} saving={savingTab} onDraftChange={setTabDraft} onEdit={editTab} onCancel={cancelTabEdit} onSave={() => void saveTab()} />
      <CommitSettingsCard />
      <ModelPricingCard />
      <AppLifecycleSettingsCard />
      <LegacyModelImport>{({ busy, previewing, open }) => <TitledCard title={t("导入")}>
        <div className={styles.importRow}>
          <div>
            <strong>{t("旧版配置")}</strong>
            <small>{t("从本机旧版配置读取模型；确认前会显示新增和已存在的模型。")}</small>
          </div>
          <Button size="small" disabled={busy} onClick={open}>
            {previewing ? t("读取中…") : t("查看并导入")}
          </Button>
        </div>
      </TitledCard>}</LegacyModelImport>
      <TitledCard title={t("语言")}>
        <div className={styles.settingRow}>
          <div>
            <strong>{t("界面语言")}</strong>
            <small>{t("默认跟随操作系统；不支持的系统语言使用英文。当前：{language}", { language: locale === "zh-CN" ? "简体中文" : locale === "pt-BR" ? "Português (Brasil)" : "English" })}</small>
          </div>
          <div className={styles.languageControl}>
            <Select
              value={preference}
              ariaLabel={t("界面语言")}
              options={[
                { value: "system", label: t("跟随系统") },
                { value: "zh-CN", label: "简体中文" },
                { value: "en-US", label: "English" },
                { value: "pt-BR", label: "Português (Brasil)" },
              ]}
              onChange={(value) => appStore.selectLocalePreference(value as LocalePreference)}
            />
          </div>
        </div>
      </TitledCard>
      <TitledCard title={t("主题")}>
        <div className={styles.themeSection}>
          <div className={styles.themeActions}>
            {themeOptions.map(({ id }) => (
              <button
                type="button"
                className={theme === id ? styles.selected : ""}
                aria-pressed={theme === id}
                key={id}
                onClick={() => appStore.selectTheme(id)}
              >
                {themeLabel(id)}
              </button>
            ))}
          </div>
          <small>{t("选择“跟随系统”时，系统深浅色切换后界面将同步更新，无需重启。")}</small>
        </div>
      </TitledCard>
      <CurrencySettingsCard />
      <CostQuotaSettingsCard />
      <TitledCard title={t("存储管理")}>
        <div className={styles.storageRow}>
          <div>
            <strong>{t("统计数据")}</strong>
            <small>{storage ? t("调用记录 {calls} 条 · 追踪记录 {traces} 条", { calls: storage.call_count, traces: storage.trace_count }) : t("计算中…")}</small>
          </div>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => { setClearScope("details"); setConfirmClear(true); }}
          >
            {t("清理存储空间")}
          </button>
        </div>
      </TitledCard>
      <ConfirmDialog
        open={confirmClear}
        title={clearTitle}
        busy={clearing}
        cancelLabel={t("取消")}
        confirmLabel={t("确认清理")}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearStorage()}
      >
        <div className={styles.confirmContent}>
          <Select
            value={clearScope}
            ariaLabel={t("清理范围")}
            options={[
              { value: "details", label: t("仅清理详细记录") },
              { value: "all", label: t("清理全部统计数据") },
            ]}
            onChange={(value) => setClearScope(value as StatisticsStorageScope)}
          />
          <small>{clearDescription}</small>
        </div>
      </ConfirmDialog>
    </div>
  );
  return <PageContent title={t("设置")} sections={[{ key: "settings", estimatedHeight: 1200, content }]} />;
}
