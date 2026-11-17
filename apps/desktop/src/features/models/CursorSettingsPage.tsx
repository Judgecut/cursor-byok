import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, configuredPluginModels, type Model, type Provider } from "../../shared/api";
import { CursorCaGate, CursorCaProvider, CursorModelGate, CursorModelProvider } from "./CursorGates";
import { CursorModelCards } from "./CursorModelCards";
import { cursorModelGroups, resolveCursorModelGrouping, type CursorModelGrouping } from "./cursorModelGrouping";
import { CursorModelEditor, emptyCursorModelDraft, modelDraftFrom, modelDraftInput, type CursorModelDraft } from "./CursorModelEditor";
import { CursorProviderEditor, emptyCursorProviderDraft, providerDraftFrom, providerDraftInput, type CursorProviderDraft } from "./CursorProviderEditor";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import styles from "./CursorSettings.module.scss";
import { PageContent } from "../../shell/layout/PageContent";
import { LegacyModelImport } from "./LegacyModelImport";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { addIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";

export function CursorSettingsPage() {
  const { providers, models, cursorHarness, cursorBusy, plugins } = useAppStore();
  const navigate = useNavigate();
  const message = useMessage();
  const [draft, setDraft] = useState<CursorModelDraft | null>(null);
  const [editing, setEditing] = useState<Model | null>(null);
  const [providerDraft, setProviderDraft] = useState<CursorProviderDraft | null>(null);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<Provider | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [modelOptionsByProvider, setModelOptionsByProvider] = useState<Record<string, string[]>>({});
  const [discovering, setDiscovering] = useState(false);
  const [caCommand, setCaCommand] = useState<string | null>(null);
  const [waitingForCaRefresh, setWaitingForCaRefresh] = useState(false);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const [confirmDisableTakeover, setConfirmDisableTakeover] = useState(false);
  const [testingModelHashes, setTestingModelHashes] = useState<Set<string>>(() => new Set());
  const [modelTestResults, setModelTestResults] = useState<Map<string, CursorModelTestState>>(() => new Map());
  const [savingAndTesting, setSavingAndTesting] = useState(false);
  const [batchTesting, setBatchTesting] = useState(false);
  const [grouping, setGrouping] = useState<CursorModelGrouping>("provider");
  const activeModelTests = useRef(new Map<string, { testId: string; controller: AbortController; cancelling: boolean }>());
  const caReady = cursorHarness?.ca === "ready";
  const cursorTakenOver = cursorHarness?.settings_applied ?? false;
  const takeoverLabel = cursorTakenOver ? t("关闭接管Cursor") : t("开启接管Cursor");
  const pluginModels = configuredPluginModels(plugins);
  const testTargets = [
    ...models.map((model) => ({ model_hash: model.model_hash, display_name: model.display_name })),
    ...pluginModels.map((model) => ({ model_hash: model.id, display_name: model.displayName })),
  ];
  const typeGroups = cursorModelGroups(models, "type", providers);
  const canGroupByProvider = providers.length > 0;
  const canGroupByType = typeGroups.length > 1;
  const effectiveGrouping = resolveCursorModelGrouping(grouping, canGroupByProvider, canGroupByType);

  useEffect(() => {
    if (caCommand) void api.copyCursorText(caCommand);
  }, [caCommand]);

  const initializeCa = async () => {
    const status = await appStore.initializeCursorCa();
    if (status?.ca === "untrusted" && status.ca_install_command) setCaCommand(status.ca_install_command);
  };
  const openNewProvider = () => {
    const next = emptyCursorProviderDraft();
    next.provider.sort_order = providers.length + 1;
    setEditingProvider(null);
    setProviderDraft(next);
  };
  const openEditProvider = (provider: Provider) => {
    setEditingProvider(provider);
    setProviderDraft(providerDraftFrom(provider));
  };
  const saveProvider = async () => {
    if (!providerDraft || savingProvider) return;
    setSavingProvider(true);
    try {
      const input = providerDraftInput(providerDraft);
      const saved = editingProvider
        ? await appStore.updateProvider(editingProvider.provider_id, input)
        : await appStore.createProvider(input);
      if (saved) {
        setProviderDraft(null);
        setEditingProvider(null);
      }
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSavingProvider(false);
    }
  };
  const openNewModel = (provider?: Provider) => {
    const target = provider ?? providers[0];
    if (!target) {
      openNewProvider();
      return;
    }
    const next = emptyCursorModelDraft(target);
    next.model.sort_order = models.length + 1;
    setEditing(null);
    setDraft(next);
  };
  const openEdit = (model: Model) => {
    setEditing(model);
    setModelOptionsByProvider((current) => {
      const existing = current[model.provider_id] ?? [];
      if (existing.includes(model.model_id)) return current;
      return { ...current, [model.provider_id]: [model.model_id, ...existing] };
    });
    setDraft(modelDraftFrom(model));
  };
  const discover = async (providerId: string): Promise<boolean> => {
    setDiscovering(true);
    try {
      const result = await api.discoverProviderModels(providerId);
      setModelOptionsByProvider((current) => ({
        ...current,
        [providerId]: [...new Set(result.models)],
      }));
      return true;
    } catch (cause) {
      message(errorText(cause));
      return false;
    } finally {
      setDiscovering(false);
    }
  };
  const persist = async (): Promise<Model | null> => {
    if (!draft) return null;
    const input = modelDraftInput(draft);
    if (editing) return appStore.updateCursorModel(editing.model_hash, input);
    return (await appStore.createModels([input]))?.[0] ?? null;
  };
  const save = async () => {
    try {
      if (await persist()) {
        setDraft(null);
        setEditing(null);
      }
    } catch (cause) {
      message(errorText(cause));
    }
  };
  const cancelModelTest = async (modelHash: string) => {
    const active = activeModelTests.current.get(modelHash);
    if (!active || active.cancelling) return;
    active.cancelling = true;
    active.controller.abort();
    try {
      await api.cancelModelTest(modelHash, active.testId);
    } catch (cause) {
      message(t("取消测试失败：{error}", { error: errorText(cause) }), { duration: 5000 });
    }
  };
  const cancelAllModelTests = async () => {
    await Promise.all([...activeModelTests.current.keys()].map((modelHash) => cancelModelTest(modelHash)));
  };
  const testModel = async (model: { model_hash: string; display_name: string }, notify = true): Promise<"success" | "failure" | "cancelled"> => {
    if (activeModelTests.current.has(model.model_hash)) {
      await cancelModelTest(model.model_hash);
      return "cancelled";
    }
    const active = { testId: crypto.randomUUID(), controller: new AbortController(), cancelling: false };
    activeModelTests.current.set(model.model_hash, active);
    setTestingModelHashes((current) => new Set(current).add(model.model_hash));
    try {
      const result = await api.testModel(model.model_hash, active.testId, active.controller.signal);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "success", result }));
      if (notify) message(t("模型 {model} 连通性测试成功（{duration} ms）", { model: model.display_name, duration: result.duration_ms }));
      return "success";
    } catch (cause) {
      if (active.cancelling || active.controller.signal.aborted) {
        setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "cancelled" }));
        return "cancelled";
      }
      const error = errorText(cause);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "error", error }));
      if (notify) message(t("连通性测试失败：{error}", { error }), { duration: 5000 });
      return "failure";
    } finally {
      if (activeModelTests.current.get(model.model_hash) === active) activeModelTests.current.delete(model.model_hash);
      setTestingModelHashes((current) => {
        const next = new Set(current);
        next.delete(model.model_hash);
        return next;
      });
    }
  };
  const saveAndTest = async () => {
    setSavingAndTesting(true);
    let saved: Model | null = null;
    try {
      saved = await persist();
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSavingAndTesting(false);
    }
    if (!saved) return;
    setEditing(saved);
    await testModel(saved);
    await appStore.refresh();
  };
  const testAllModels = async () => {
    if (!testTargets.length || batchTesting) return;
    setBatchTesting(true);
    try {
      const results = await Promise.all(testTargets.map((model) => testModel(model, false)));
      const successful = results.filter((result) => result === "success").length;
      const failed = results.filter((result) => result === "failure").length;
      const cancelled = results.filter((result) => result === "cancelled").length;
      message(cancelled > 0
        ? t("连通性测试已取消：成功 {successful}，失败 {failed}", { successful, failed })
        : failed === 0
          ? t("全部 {count} 个模型连通性测试成功", { count: testTargets.length })
          : t("连通性测试完成：成功 {successful}，失败 {failed}", { successful, failed }),
      { duration: failed === 0 && cancelled === 0 ? 2400 : 5000 });
    } finally {
      setBatchTesting(false);
    }
  };
  const duplicateModel = async (model: Model) => {
    const names = new Set(models.map((item) => item.display_name));
    const baseName = t("{name} 副本", { name: model.display_name });
    let displayName = baseName;
    let suffix = 2;
    while (names.has(displayName)) {
      displayName = `${baseName} ${suffix}`;
      suffix += 1;
    }
    const created = await appStore.createModels([{
      ...modelDraftFrom(model).model,
      sort_order: models.length + 1,
      display_name: displayName,
    }]);
    if (created) message(t("模型已复制"));
  };
  const reorderModels = useCallback(async (modelHashes: string[]) => {
    if (!await appStore.reorderCursorModels(modelHashes)) {
      message(appStore.getSnapshot().error || t("排序失败"));
    }
  }, [message]);

  const list = <CursorModelCards
    providers={providers}
    models={models}
    pluginModels={pluginModels}
    grouping={effectiveGrouping}
    disabled={cursorBusy}
    testingModelHashes={testingModelHashes}
    testResults={modelTestResults}
    onTest={(model) => void testModel(model)}
    onEdit={openEdit}
    onDuplicate={(model) => void duplicateModel(model)}
    onDelete={setDeleting}
    onTestPluginModel={(model) => void testModel({ model_hash: model.id, display_name: model.displayName })}
    onPluginSettings={() => navigate("/plugins")}
    onReorder={reorderModels}
    onAddModelForProvider={openNewModel}
    onEditProvider={openEditProvider}
    onDeleteProvider={setDeletingProvider}
  />;

  const refreshCa = async () => {
    await appStore.refresh();
    if (appStore.getSnapshot().cursorHarness?.ca !== "ready") setWaitingForCaRefresh(false);
  };
  const openCaTerminal = () => {
    if (caCommand) void api.openCursorCaInstallTerminal(caCommand).catch((cause) => message(errorText(cause)));
    setCaCommand(null);
    setWaitingForCaRefresh(true);
  };
  const content = <CursorCaProvider><CursorCaGate busy={cursorBusy} waitingForRefresh={waitingForCaRefresh} onInitialize={() => void initializeCa()} onRefresh={() => void refreshCa()}>
    <div className={styles.page}>
      <LegacyModelImport>{({ busy: importingLegacyModels, previewing, open }) =>
        <CursorModelProvider><CursorModelGate busy={cursorBusy || importingLegacyModels} previewingImport={previewing} onAddProvider={openNewProvider} onImport={open}>{list}</CursorModelGate></CursorModelProvider>
      }</LegacyModelImport>
    </div>
  </CursorCaGate></CursorCaProvider>;

  const editorTestState = editing ? modelTestResults.get(editing.model_hash) : undefined;
  const editorTesting = Boolean(editing && testingModelHashes.has(editing.model_hash));
  const activeModelOptions = draft ? (modelOptionsByProvider[draft.model.provider_id || providers[0]?.provider_id || ""] ?? []) : [];

  return <>
    <PageActions position="left">
      <div className={styles.takeoverActions}>
        <span className={styles.takeoverStatus}>{cursorTakenOver ? t("已接管") : t("未接管")}</span>
        <TooltipTrigger label={takeoverLabel}>
          <Switch
            checked={cursorTakenOver}
            disabled={cursorBusy || (!cursorTakenOver && !caReady)}
            label={takeoverLabel}
            onChange={(enabled) => {
              if (enabled) void appStore.setCursorEnabled(true);
              else setConfirmDisableTakeover(true);
            }}
          />
        </TooltipTrigger>
        {(providers.length > 0 || testTargets.length > 0) && <div className={styles.groupActions} role="group" aria-label={t("操作")}>
          <button type="button" aria-pressed={effectiveGrouping === "flat"} onClick={() => setGrouping("flat")}>{t("默认平铺")}</button>
          {canGroupByProvider && <button type="button" aria-pressed={effectiveGrouping === "provider"} onClick={() => setGrouping("provider")}>{t("按供应商")}</button>}
          {canGroupByType && <button type="button" aria-pressed={effectiveGrouping === "type"} onClick={() => setGrouping("type")}>{t("按类型")}</button>}
          {testTargets.length > 0 && <button type="button" disabled={cursorBusy || (!batchTesting && testingModelHashes.size > 0)} onClick={() => void (batchTesting ? cancelAllModelTests() : testAllModels())}>{batchTesting ? t("取消全部测试") : t("一键测试")}</button>}
        </div>}
      </div>
    </PageActions>
    <PageActions>
      <div className={styles.groupActions}>
        <button type="button" disabled={!caReady || cursorBusy} title={caReady ? t("添加供应商") : t("请先初始化 CA")} onClick={openNewProvider}>
          <Icon icon={addIcon} size="1em" />
          {t("添加供应商")}
        </button>
        <button type="button" disabled={!caReady || cursorBusy} title={caReady ? t("添加模型") : t("请先初始化 CA")} onClick={() => openNewModel()}>
          <Icon icon={addIcon} size="1em" />
          {t("添加模型")}
        </button>
      </div>
    </PageActions>
    <PageContent title="Cursor" sections={[{ key: "cursor-settings", estimatedHeight: 380, content }]} />
    <ConfirmDialog
      open={confirmDisableTakeover}
      title={t("关闭接管Cursor？")}
      cancelLabel={t("取消")}
      confirmLabel={t("关闭接管")}
      onCancel={() => setConfirmDisableTakeover(false)}
      onConfirm={() => {
        setConfirmDisableTakeover(false);
        void appStore.setCursorEnabled(false);
      }}
    >
      <p>{t("关闭后将移除 Cursor 本地代理配置。如果你需要登陆官方账号，通常不需要关闭操作，推荐直接登陆你的账号即可(byok模型与官方账号的模型已支持无缝衔接)，是否继续关闭并清理代理？")}</p>
    </ConfirmDialog>
    <Modal
      fullHeight
      open={providerDraft !== null}
      title={editingProvider ? t("编辑供应商") : t("添加供应商")}
      busy={cursorBusy || savingProvider}
      onClose={() => { setProviderDraft(null); setEditingProvider(null); }}
      onSubmit={() => void saveProvider()}
      submitLabel={t("保存")}
    >
      {providerDraft && <CursorProviderEditor draft={providerDraft} onChange={setProviderDraft} />}
    </Modal>
    <Modal fullHeight open={draft !== null} title={editing ? t("编辑模型") : t("添加模型")} banner={draft && (editorTesting || editorTestState) ? <CursorModelTestResult state={editorTestState} testing={editorTesting} /> : undefined} busy={cursorBusy || savingAndTesting} onClose={() => { if (editing && editorTesting) void cancelModelTest(editing.model_hash); setDraft(null); setEditing(null); }} onSubmit={() => void save()} submitLabel={t("保存")} secondaryAction={<button type="button" className={controls.secondary} disabled={cursorBusy || savingAndTesting} onClick={() => void (editorTesting && editing ? cancelModelTest(editing.model_hash) : saveAndTest())}>{savingAndTesting ? t("处理中…") : editorTesting ? t("取消测试") : t("保存并测试")}</button>}>
      {draft && <CursorModelEditor draft={draft} providers={providers} modelOptions={activeModelOptions} discovering={discovering} onChange={setDraft} onDiscover={discover} />}
    </Modal>
    <ConfirmDialog open={caCommand !== null} title={t("安装本地 CA")} cancelLabel={t("关闭")} confirmLabel={t("打开终端")} onCancel={() => setCaCommand(null)} onConfirm={openCaTerminal}>
      <div className={styles.editor}><strong>{t("需要授权安装证书")}</strong><span>{t("安装命令已自动复制。点击“打开终端”，将命令粘贴到终端中执行，并按提示输入密码。")}</span><pre className={styles.command}>{caCommand}</pre></div>
    </ConfirmDialog>
    <ConfirmDialog
      open={deletingProvider !== null}
      title={t("删除供应商")}
      cancelLabel={t("取消")}
      confirmLabel={t("删除")}
      onCancel={() => setDeletingProvider(null)}
      onConfirm={() => { if (deletingProvider) void appStore.deleteProvider(deletingProvider.provider_id); setDeletingProvider(null); }}
    >
      <p>{t("确定删除供应商“{name}”吗？其下配置的全部模型也会一并删除。", { name: deletingProvider?.name ?? "" })}</p>
    </ConfirmDialog>
    <ConfirmDialog open={deleting !== null} title={t("删除模型")} cancelLabel={t("取消")} confirmLabel={t("删除")} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void appStore.deleteModel(deleting.model_hash); setDeleting(null); }}><p>{t("确定删除这个模型吗？")}</p></ConfirmDialog>
  </>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
