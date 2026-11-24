import { useEffect, useRef, useState, type ReactNode } from "react";
import Sortable from "sortablejs";
import type { Model, PluginModelDescriptor, Provider, RequestFormat } from "../../shared/api";
import { resolveProviderIcon } from "../../shared/utils/providerIcons";
import { Card } from "../../shared/ui/Card";
import { Icon, type IconProps } from "../../shared/ui/Icon";
import { addIcon, chevronDownIcon, chevronRightIcon, claudeIcon, dragIcon, editIcon, openAiIcon, trashIcon } from "../../shared/ui/icons";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import { cursorModelGroups, replaceOrderedSubset, type CursorModelGroup, type CursorModelGrouping } from "./cursorModelGrouping";
import styles from "./CursorSettings.module.scss";

export { cursorModelGroups, type CursorModelGroup, type CursorModelGrouping };

type CursorModelCardsProps = {
  providers: Provider[];
  models: Model[];
  pluginModels: PluginModelDescriptor[];
  grouping: CursorModelGrouping;
  disabled: boolean;
  testingModelHashes: Set<string>;
  testResults: Map<string, CursorModelTestState>;
  onTest: (model: Model) => void;
  onEdit: (model: Model) => void;
  onDuplicate: (model: Model) => void;
  onDelete: (model: Model) => void;
  onTestPluginModel: (model: PluginModelDescriptor) => void;
  onPluginSettings: (model: PluginModelDescriptor) => void;
  onReorderProviders: (providerIds: string[]) => void;
  onReorderModels: (providerId: string, modelHashes: string[]) => void;
  onAddModelForProvider: (provider: Provider, format?: RequestFormat) => void;
  onEditProvider: (provider: Provider) => void;
  onDeleteProvider: (provider: Provider) => void;
};

type SortableListConfig = {
  ids: string[];
  enabled: boolean;
  disabled: boolean;
  draggableSelector: string;
  handleSelector: string;
  dataIdAttr: string;
  onReorder: (nextIds: string[]) => void;
};

/** Manages a SortableJS container while keeping React in control of final DOM order. */
function useSortableList<T extends HTMLElement>({
  ids,
  enabled,
  disabled,
  draggableSelector,
  handleSelector,
  dataIdAttr,
  onReorder,
}: SortableListConfig) {
  const containerRef = useRef<T>(null);
  const sortableRef = useRef<Sortable | null>(null);
  const currentIds = useRef(ids);
  const reorderRef = useRef(onReorder);
  currentIds.current = ids;
  reorderRef.current = onReorder;
  const idsKey = ids.join("\0");

  useEffect(() => {
    if (!enabled || !containerRef.current) return;
    sortableRef.current = Sortable.create(containerRef.current, {
      animation: 160,
      dataIdAttr,
      draggable: draggableSelector,
      handle: handleSelector,
      ghostClass: styles.sortGhost,
      chosenClass: styles.sortChosen,
      dragClass: styles.sortDragging,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      disabled,
      onEnd: (event) => {
        const expectedIds = currentIds.current;
        const oldIndex = event.oldDraggableIndex ?? event.oldIndex;
        const newIndex = event.newDraggableIndex ?? event.newIndex;
        // Restore React's current order synchronously before state updates or error rollbacks.
        sortableRef.current?.sort(expectedIds, false);
        if (
          typeof oldIndex !== "number"
          || typeof newIndex !== "number"
          || oldIndex === newIndex
        ) {
          return;
        }
        const reordered = expectedIds.slice();
        const [moved] = reordered.splice(oldIndex, 1);
        if (!moved || newIndex < 0 || newIndex > reordered.length) {
          return;
        }
        reordered.splice(newIndex, 0, moved);
        reorderRef.current(reordered);
      },
    });
    return () => {
      sortableRef.current?.destroy();
      sortableRef.current = null;
    };
  }, [dataIdAttr, draggableSelector, enabled, handleSelector]);

  useEffect(() => {
    const instance = sortableRef.current;
    if (!instance) return;
    instance.option("disabled", disabled);
    const currentDomOrder = instance.toArray();
    if (
      currentDomOrder.length !== currentIds.current.length
      || currentDomOrder.some((id, index) => id !== currentIds.current[index])
    ) {
      instance.sort(currentIds.current, false);
    }
  }, [disabled, idsKey]);

  return containerRef;
}

function SortHandle({ className, disabled }: { className: string; disabled: boolean }) {
  return <button
    type="button"
    className={`${styles.sortHandle} ${className}`}
    disabled={disabled}
    aria-label={t("拖动排序")}
    title={t("拖动排序")}
    onClick={(event) => event.stopPropagation()}
  >
    <Icon icon={dragIcon} size="1.15em" />
  </button>;
}

export function CursorModelCards(props: CursorModelCardsProps) {
  const groups = cursorModelGroups(props.models, props.grouping, props.providers);
  const providerGroups = props.grouping === "provider"
    ? groups.filter((group): group is CursorModelGroup & { provider: Provider } => Boolean(group.provider))
    : [];
  const orphanProviderGroups = props.grouping === "provider"
    ? groups.filter((group) => !group.provider)
    : [];
  const pluginsDefaultOpen = props.providers.length === 0;

  return <div className={styles.modelGroups}>
    {props.grouping === "provider"
      ? <>
        {providerGroups.length > 0 && <ProviderGroupsList groups={providerGroups} props={props} />}
        {orphanProviderGroups.length > 0 && <div className={styles.groupStack}>
          {orphanProviderGroups.map((group) => <CollapsibleGroup
            key={group.key}
            label={group.label}
            defaultOpen
          >
            <SortableModelList
              models={group.models}
              sortable={false}
              disabled={props.disabled}
              testingModelHashes={props.testingModelHashes}
              testResults={props.testResults}
              onTest={props.onTest}
              onEdit={props.onEdit}
              onDuplicate={props.onDuplicate}
              onDelete={props.onDelete}
              onReorder={() => undefined}
            />
          </CollapsibleGroup>)}
        </div>}
      </>
      : groups.length > 0 && <div className={styles.groupStack}>
        {groups.map((group) => <TypeGroupCard key={group.key} group={group} props={props} />)}
      </div>}
    {pluginGroups(props.pluginModels).map((group) => <CollapsibleGroup
      key={group.pluginId}
      label={group.pluginName}
      visual={group.icon ? { src: group.icon } : undefined}
      defaultOpen={pluginsDefaultOpen}
    >
      {group.models.map((model) => <PluginModelRow
        key={model.id}
        model={model}
        disabled={props.disabled}
        testing={props.testingModelHashes.has(model.id)}
        result={props.testResults.get(model.id)}
        onTest={() => props.onTestPluginModel(model)}
        onSettings={() => props.onPluginSettings(model)}
      />)}
    </CollapsibleGroup>)}
  </div>;
}

function ProviderGroupsList({
  groups,
  props,
}: {
  groups: Array<CursorModelGroup & { provider: Provider }>;
  props: CursorModelCardsProps;
}) {
  const canSortProviders = groups.length > 1;
  const listRef = useSortableList<HTMLDivElement>({
    ids: groups.map((group) => group.provider.provider_id),
    enabled: canSortProviders,
    disabled: props.disabled,
    draggableSelector: `.${styles.providerCard}`,
    handleSelector: `.${styles.providerSortHandle}`,
    dataIdAttr: "data-provider-id",
    onReorder: props.onReorderProviders,
  });

  return <div ref={listRef} className={styles.groupStack}>
    {groups.map((group) => <CollapsibleGroup
      key={group.key}
      className={styles.providerCard}
      providerId={group.provider.provider_id}
      label={group.label}
      visual={resolveProviderIcon(group.provider.icon, group.provider.base_url).visual}
      defaultOpen
      dragHandle={canSortProviders ? <SortHandle className={styles.providerSortHandle} disabled={props.disabled} /> : undefined}
      actions={<ProviderActionButtons
        provider={group.provider}
        disabled={props.disabled}
        onAddModel={props.onAddModelForProvider}
        onEdit={props.onEditProvider}
        onDelete={props.onDeleteProvider}
      />}
    >
      {group.models.length === 0
        ? <div className={styles.emptyGroupRow}>{t("该供应商下暂无模型，点击「添加模型」即可配置。")}</div>
        : <SortableModelList
          models={group.models}
          sortable
          disabled={props.disabled}
          testingModelHashes={props.testingModelHashes}
          testResults={props.testResults}
          onTest={props.onTest}
          onEdit={props.onEdit}
          onDuplicate={props.onDuplicate}
          onDelete={props.onDelete}
          onReorder={(modelHashes) => props.onReorderModels(group.provider.provider_id, modelHashes)}
        />}
    </CollapsibleGroup>)}
  </div>;
}

function TypeGroupCard({ group, props }: { group: CursorModelGroup; props: CursorModelCardsProps }) {
  const groupProviderIds = new Set(group.models.map((model) => model.provider_id));
  const providersInType = props.providers.filter((provider) => groupProviderIds.has(provider.provider_id));
  const matchedProviderIds = new Set(providersInType.map((provider) => provider.provider_id));
  const orphanModels = group.models.filter((model) => !matchedProviderIds.has(model.provider_id));

  return <CollapsibleGroup
    label={group.label}
    visual={group.protocol === "gemini" ? undefined : { icon: group.protocol === "anthropic" ? claudeIcon : openAiIcon }}
    defaultOpen
  >
    {providersInType.length > 0 && <TypeProviderSubgroups
      providersInType={providersInType}
      groupModels={group.models}
      format={group.protocol}
      props={props}
    />}
    {orphanModels.length > 0 && <SortableModelList
      models={orphanModels}
      sortable={false}
      disabled={props.disabled}
      testingModelHashes={props.testingModelHashes}
      testResults={props.testResults}
      onTest={props.onTest}
      onEdit={props.onEdit}
      onDuplicate={props.onDuplicate}
      onDelete={props.onDelete}
      onReorder={() => undefined}
    />}
  </CollapsibleGroup>;
}

function TypeProviderSubgroups({
  providersInType,
  groupModels,
  format,
  props,
}: {
  providersInType: Provider[];
  groupModels: Model[];
  format: RequestFormat | undefined;
  props: CursorModelCardsProps;
}) {
  const canSortProviders = providersInType.length > 1;
  const subgroupListRef = useSortableList<HTMLDivElement>({
    ids: providersInType.map((provider) => provider.provider_id),
    enabled: canSortProviders,
    disabled: props.disabled,
    draggableSelector: `.${styles.providerSubgroup}`,
    handleSelector: `.${styles.providerSortHandle}`,
    dataIdAttr: "data-provider-id",
    onReorder: (reorderedTypeIds) => {
      props.onReorderProviders(
        replaceOrderedSubset(props.providers.map((provider) => provider.provider_id), reorderedTypeIds),
      );
    },
  });

  return <div ref={subgroupListRef} className={styles.providerSubgroups}>
    {providersInType.map((provider) => {
      const providerModels = groupModels.filter((model) => model.provider_id === provider.provider_id);
      return <div className={styles.providerSubgroup} data-provider-id={provider.provider_id} key={provider.provider_id}>
        <div className={styles.providerSubheader}>
          {canSortProviders && <SortHandle className={styles.providerSortHandle} disabled={props.disabled} />}
          <div className={styles.providerSubheaderTitle}>
            <Icon {...resolveProviderIcon(provider.icon, provider.base_url).visual} size="1.1em" />
            <span className={styles.providerSubheaderName}>{provider.name}</span>
          </div>
          <ProviderActionButtons
            provider={provider}
            disabled={props.disabled}
            onAddModel={(target) => props.onAddModelForProvider(target, format)}
            onEdit={props.onEditProvider}
            onDelete={props.onDeleteProvider}
          />
        </div>
        {providerModels.length === 0
          ? <div className={styles.emptyGroupRow}>{t("该供应商下暂无模型，点击「添加模型」即可配置。")}</div>
          : <SortableModelList
            models={providerModels}
            sortable
            disabled={props.disabled}
            testingModelHashes={props.testingModelHashes}
            testResults={props.testResults}
            onTest={props.onTest}
            onEdit={props.onEdit}
            onDuplicate={props.onDuplicate}
            onDelete={props.onDelete}
            onReorder={(modelHashes) => props.onReorderModels(provider.provider_id, replaceOrderedSubset(props.models.filter((model) => model.provider_id === provider.provider_id).map((model) => model.model_hash), modelHashes))}
          />}
      </div>;
    })}
  </div>;
}

function SortableModelList({
  models,
  sortable,
  disabled,
  testingModelHashes,
  testResults,
  onTest,
  onEdit,
  onDuplicate,
  onDelete,
  onReorder,
}: {
  models: Model[];
  sortable: boolean;
  disabled: boolean;
  testingModelHashes: Set<string>;
  testResults: Map<string, CursorModelTestState>;
  onTest: (model: Model) => void;
  onEdit: (model: Model) => void;
  onDuplicate: (model: Model) => void;
  onDelete: (model: Model) => void;
  onReorder: (modelHashes: string[]) => void;
}) {
  const canSort = sortable && models.length > 1;
  const listRef = useSortableList<HTMLDivElement>({
    ids: models.map((model) => model.model_hash),
    enabled: canSort,
    disabled,
    draggableSelector: `.${styles.modelRow}`,
    handleSelector: `.${styles.modelSortHandle}`,
    dataIdAttr: "data-model-hash",
    onReorder,
  });

  return <div ref={listRef} className={styles.modelList}>
    {models.map((model) => <ModelListRow
      key={model.model_hash}
      model={model}
      sortable={canSort}
      disabled={disabled}
      testing={testingModelHashes.has(model.model_hash)}
      result={testResults.get(model.model_hash)}
      onTest={() => onTest(model)}
      onEdit={() => onEdit(model)}
      onDuplicate={() => onDuplicate(model)}
      onDelete={() => onDelete(model)}
    />)}
  </div>;
}

function ProviderActionButtons({ provider, disabled, onAddModel, onEdit, onDelete }: {
  provider: Provider;
  disabled: boolean;
  onAddModel: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
}) {
  return <div className={styles.groupHeaderActions}>
    <button type="button" className={styles.groupSettings} disabled={disabled} onClick={() => onAddModel(provider)}>
      <Icon icon={addIcon} size="1em" />
      {t("添加模型")}
    </button>
    <button type="button" className={styles.groupSettings} disabled={disabled} onClick={() => onEdit(provider)}>
      <Icon icon={editIcon} size="1em" />
      {t("编辑")}
    </button>
    <button type="button" className={`${styles.groupSettings} ${styles.groupSettingsDelete}`} disabled={disabled} onClick={() => onDelete(provider)}>
      <Icon icon={trashIcon} size="1em" />
      {t("删除")}
    </button>
  </div>;
}

function pluginGroups(models: PluginModelDescriptor[]) {
  const groups: { pluginId: string; pluginName: string; icon: string; models: PluginModelDescriptor[] }[] = [];
  for (const model of models) {
    let group = groups.find((candidate) => candidate.pluginId === model.pluginId);
    if (!group) {
      group = { pluginId: model.pluginId, pluginName: model.pluginName, icon: model.icon, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

function CollapsibleGroup({ label, visual, defaultOpen = true, className, providerId, dragHandle, actions, children }: {
  label: string;
  visual?: Pick<IconProps, "icon" | "src">;
  defaultOpen?: boolean;
  className?: string;
  providerId?: string;
  dragHandle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <Card className={[styles.groupCard, className].filter(Boolean).join(" ")} data-provider-id={providerId}>
    <div className={styles.groupHeader}>
      {dragHandle}
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {visual && <Icon {...visual} size="1.1em" />}
        <span className={styles.groupLabel}>{label}</span>
      </button>
      {actions}
      <button
        type="button"
        className={styles.groupChevron}
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon icon={open ? chevronDownIcon : chevronRightIcon} size="1em" />
      </button>
    </div>
    {open && <div className={styles.modelList}>{children}</div>}
  </Card>;
}

function ModelListRow({ model, sortable, disabled, testing, result, onTest, onEdit, onDuplicate, onDelete }: {
  model: Model;
  sortable: boolean;
  disabled: boolean;
  testing: boolean;
  result: CursorModelTestState | undefined;
  onTest: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return <div className={styles.modelRow} data-model-hash={model.model_hash}>
    {sortable && <SortHandle className={styles.modelSortHandle} disabled={disabled} />}
    <div className={styles.modelRowName}>
      <span className={styles.modelRowNameText}>{model.display_name}</span>
      <span className={styles.modelRowModelId}>{model.model_id}</span>
    </div>
    <CursorModelTestResult compact state={result} testing={testing} />
    <div className={styles.modelCardActions}>
      <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={onTest} />
      <TruncatedButton size="small" disabled={disabled} label={t("编辑")} onClick={onEdit} />
      <TruncatedButton size="small" disabled={disabled} label={t("复制")} onClick={onDuplicate} />
      <TruncatedButton size="small" className={styles.deleteButton} disabled={disabled} label={t("删除")} onClick={onDelete} />
    </div>
  </div>;
}

function PluginModelRow({ model, disabled, testing, result, onTest, onSettings }: {
  model: PluginModelDescriptor;
  disabled: boolean;
  testing: boolean;
  result: CursorModelTestState | undefined;
  onTest: () => void;
  onSettings: () => void;
}) {
  return <div className={styles.modelRow}>
    <div className={styles.modelRowName}>
      <span className={styles.modelRowNameText}>{model.displayName}</span>
      <span className={styles.modelRowModelId}>{model.modelId}</span>
    </div>
    <CursorModelTestResult compact state={result} testing={testing} />
    <div className={styles.modelCardActions}>
      <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={onTest} />
      <TruncatedButton size="small" disabled={disabled} label={t("设置")} onClick={onSettings} />
    </div>
  </div>;
}
