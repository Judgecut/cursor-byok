import type { IconifyIcon } from "@iconify/react/offline";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Sortable from "sortablejs";
import type { Model, PluginModelDescriptor, Provider } from "../../shared/api";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { addIcon, chevronDownIcon, chevronRightIcon, claudeIcon, dragIcon, editIcon, flatColorOrganizationIcon, openAiIcon, trashIcon } from "../../shared/ui/icons";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import { cursorModelGroups, typeGroupDescriptor, type CursorModelGroup, type CursorModelGrouping } from "./cursorModelGrouping";
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
  onReorder: (modelHashes: string[]) => void;
  onAddModelForProvider: (provider: Provider) => void;
  onEditProvider: (provider: Provider) => void;
  onDeleteProvider: (provider: Provider) => void;
};

type ModelGridProps = {
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
};

export function CursorModelCards(props: CursorModelCardsProps) {
  const modelsByProvider = new Map<string, Model[]>();
  for (const model of props.models) {
    const list = modelsByProvider.get(model.provider_id);
    if (list) list.push(model);
    else modelsByProvider.set(model.provider_id, [model]);
  }
  const hasEmptyProvider = props.providers.some((provider) => !modelsByProvider.has(provider.provider_id));
  const builtins = props.grouping === "flat"
    ? <>
      {props.models.length > 0 && <div style={{ paddingTop: "10px" }}>
        <ModelGrid
          models={props.models}
          sortable
          disabled={props.disabled}
          testingModelHashes={props.testingModelHashes}
          testResults={props.testResults}
          onTest={props.onTest}
          onEdit={props.onEdit}
          onDuplicate={props.onDuplicate}
          onDelete={props.onDelete}
          onReorder={props.onReorder}
        />
      </div>}
      {props.providers.length > 0 && <CollapsibleGroup
        key={hasEmptyProvider ? "flat:providers:empty" : "flat:providers"}
        label={t("供应商")}
        icon={flatColorOrganizationIcon}
        defaultOpen={hasEmptyProvider || props.models.length === 0}
      >
        {props.providers.map((provider) => {
          const providerModels = modelsByProvider.get(provider.provider_id) ?? [];
          return <div className={styles.modelRow} key={provider.provider_id}>
            <div className={styles.providerSubheaderTitle}>
              <Icon icon={provider.type === "anthropic" ? claudeIcon : openAiIcon} size="1em" />
              <span className={styles.providerSubheaderName}>{provider.name}</span>
              <span className={styles.providerSubheaderMeta}>
                {providerModels.length === 0
                  ? t("该供应商下暂无模型，点击「添加模型」即可配置。")
                  : t("{count} 个模型", { count: providerModels.length })}
              </span>
            </div>
            <ProviderActionButtons
              provider={provider}
              disabled={props.disabled}
              onAddModel={props.onAddModelForProvider}
              onEdit={props.onEditProvider}
              onDelete={props.onDeleteProvider}
            />
          </div>;
        })}
      </CollapsibleGroup>}
    </>
    : <div className={styles.modelGroups}>
      {cursorModelGroups(props.models, props.grouping, props.providers).map((group) => (
        props.grouping === "type"
          ? renderTypeGroupCard(group, props)
          : renderGroupCard(group, true, props)
      ))}
    </div>;
  return <div className={styles.modelGroups}>
    {builtins}
    {pluginGroups(props.pluginModels).map((group) => <CollapsibleGroup
      key={`${props.grouping}:${group.pluginId}`}
      label={group.pluginName}
      iconSrc={group.icon}
      defaultOpen={props.grouping === "flat"}
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

function renderGroupCard(group: CursorModelGroup, defaultOpen: boolean, props: CursorModelCardsProps) {
  const provider = group.provider;
  return <CollapsibleGroup
    key={group.key}
    label={group.label}
    icon={group.protocol === "anthropic" ? claudeIcon : openAiIcon}
    defaultOpen={defaultOpen}
    actions={provider ? <ProviderActionButtons
      provider={provider}
      disabled={props.disabled}
      onAddModel={props.onAddModelForProvider}
      onEdit={props.onEditProvider}
      onDelete={props.onDeleteProvider}
    /> : undefined}
  >
    {group.models.length === 0
      ? <div className={styles.emptyGroupRow}>{t("该供应商下暂无模型，点击「添加模型」即可配置。")}</div>
      : renderModelRows(group.models, props)}
  </CollapsibleGroup>;
}

function renderTypeGroupCard(group: CursorModelGroup, props: CursorModelCardsProps) {
  const providersInType = props.providers.filter((provider) => typeGroupDescriptor(provider).key === group.key);
  const matchedProviderIds = new Set(providersInType.map((provider) => provider.provider_id));
  const orphanModels = group.models.filter((model) => !matchedProviderIds.has(model.provider_id));
  return <CollapsibleGroup
    key={group.key}
    label={group.label}
    icon={group.protocol === "anthropic" ? claudeIcon : openAiIcon}
    defaultOpen
  >
    {providersInType.map((provider) => {
      const providerModels = group.models.filter((model) => model.provider_id === provider.provider_id);
      return <div className={styles.providerSubgroup} key={provider.provider_id}>
        <div className={styles.providerSubheader}>
          <div className={styles.providerSubheaderTitle}>
            <Icon icon={provider.type === "anthropic" ? claudeIcon : openAiIcon} size="1em" />
            <span className={styles.providerSubheaderName}>{provider.name}</span>
          </div>
          <ProviderActionButtons
            provider={provider}
            disabled={props.disabled}
            onAddModel={props.onAddModelForProvider}
            onEdit={props.onEditProvider}
            onDelete={props.onDeleteProvider}
          />
        </div>
        {providerModels.length === 0
          ? <div className={styles.emptyGroupRow}>{t("该供应商下暂无模型，点击「添加模型」即可配置。")}</div>
          : renderModelRows(providerModels, props)}
      </div>;
    })}
    {renderModelRows(orphanModels, props)}
  </CollapsibleGroup>;
}

function renderModelRows(models: Model[], props: CursorModelCardsProps) {
  return models.map((model) => <ModelListRow
    key={model.model_hash}
    model={model}
    disabled={props.disabled}
    testing={props.testingModelHashes.has(model.model_hash)}
    result={props.testResults.get(model.model_hash)}
    onTest={() => props.onTest(model)}
    onEdit={() => props.onEdit(model)}
    onDuplicate={() => props.onDuplicate(model)}
    onDelete={() => props.onDelete(model)}
  />);
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

function CollapsibleGroup({ label, icon, iconSrc, defaultOpen = true, actions, children }: {
  label: string;
  icon?: IconifyIcon;
  iconSrc?: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <Card className={styles.groupCard}>
    <div className={styles.groupHeader}>
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {icon && <Icon icon={icon} size="1.1em" />}
        {iconSrc && <Icon src={iconSrc} size="1.1em" />}
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

function ModelListRow({ model, disabled, testing, result, onTest, onEdit, onDuplicate, onDelete }: {
  model: Model;
  disabled: boolean;
  testing: boolean;
  result: CursorModelTestState | undefined;
  onTest: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return <div className={styles.modelRow}>
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

function ModelGrid({
  models,
  sortable: sortableEnabled,
  disabled,
  testingModelHashes,
  testResults,
  onTest,
  onEdit,
  onDuplicate,
  onDelete,
  onReorder,
}: ModelGridProps) {
  const grid = useRef<HTMLDivElement>(null);
  const sortable = useRef<Sortable | null>(null);
  const currentModels = useRef(models);
  const reorder = useRef(onReorder);
  currentModels.current = models;
  reorder.current = onReorder;

  useEffect(() => {
    if (!sortableEnabled || !grid.current) return;
    sortable.current = Sortable.create(grid.current, {
      animation: 160,
      dataIdAttr: "data-model-hash",
      draggable: `.${styles.modelCard}`,
      handle: `.${styles.sortHandle}`,
      ghostClass: styles.sortGhost,
      chosenClass: styles.sortChosen,
      dragClass: styles.sortDragging,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      onEnd: (event) => {
        const oldIndex = event.oldDraggableIndex ?? event.oldIndex;
        const newIndex = event.newDraggableIndex ?? event.newIndex;
        if (typeof oldIndex !== "number"
          || typeof newIndex !== "number"
          || oldIndex === newIndex) {
          sortable.current?.sort(currentModels.current.map((model) => model.model_hash), false);
          return;
        }
        const reordered = currentModels.current.slice();
        const [moved] = reordered.splice(oldIndex, 1);
        if (!moved || newIndex < 0 || newIndex > reordered.length) {
          sortable.current?.sort(currentModels.current.map((model) => model.model_hash), false);
          return;
        }
        reordered.splice(newIndex, 0, moved);
        reorder.current(reordered.map((model) => model.model_hash));
      },
    });
    return () => {
      sortable.current?.destroy();
      sortable.current = null;
    };
  }, [sortableEnabled]);

  useEffect(() => {
    sortable.current?.option("disabled", disabled);
    sortable.current?.sort(models.map((model) => model.model_hash), false);
  }, [disabled, models]);

  return <div ref={grid} className={styles.modelGrid}>
    {models.map((model) => {
      const result = testResults.get(model.model_hash);
      const testing = testingModelHashes.has(model.model_hash);
      return <Card className={styles.modelCard} data-model-hash={model.model_hash} key={model.model_hash}>
        {sortableEnabled && <button type="button" className={styles.sortHandle} disabled={disabled} aria-label={t("拖动排序")} title={t("拖动排序")} onClick={(event) => event.stopPropagation()}>
          <Icon icon={dragIcon} size="1.25em" />
        </button>}
        <div className={styles.modelCardContent}>
          <div className={styles.modelCardTop}>
            <div className={styles.modelCardName}>
              <span className={styles.modelCardNameText}>{model.display_name}</span>
              <span className={styles.modelCardModelId}>{model.model_id}</span>
            </div>
            <span className={styles.modelTypeBadge} title={model.provider_name}>
              <Icon icon={model.type === "anthropic" ? claudeIcon : openAiIcon} />
              <span className={styles.modelTypeBadgeLabel}>{model.provider_name}</span>
            </span>
          </div>
          <div className={styles.modelCardTest}>
            <CursorModelTestResult state={result} testing={testing} />
          </div>
          <div className={styles.modelCardActions}>
            <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={() => onTest(model)} />
            <TruncatedButton size="small" disabled={disabled} label={t("编辑")} onClick={() => onEdit(model)} />
            <TruncatedButton size="small" disabled={disabled} label={t("复制")} onClick={() => onDuplicate(model)} />
            <TruncatedButton size="small" className={styles.deleteButton} disabled={disabled} label={t("删除")} onClick={() => onDelete(model)} />
          </div>
        </div>
      </Card>;
    })}
  </div>;
}
