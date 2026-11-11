import type { Locale } from "../../i18n/runtime";
import { pluginText, type OverviewFilterModel, type OverviewFilterSupplier, type PluginDescriptor } from "../api";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../ui/icons";
import type { ModelSelectOption } from "../ui/ModelSelect";
import type { SupplierFilterOption } from "../ui/SupplierFilter";

export function buildPluginLabelMap(plugins: PluginDescriptor[], locale: Locale): Map<string, string> {
  const labels = new Map<string, string>();
  for (const plugin of plugins) {
    for (const provider of plugin.providers) {
      const text = pluginText(provider.displayName, locale) || plugin.name;
      labels.set(`plugin://${plugin.id}/${provider.id}`, text);
    }
  }
  return labels;
}

export function buildSupplierFilterOptions(
  suppliers: OverviewFilterSupplier[],
  plugins: PluginDescriptor[],
  locale: Locale,
): SupplierFilterOption[] {
  const pluginLabels = buildPluginLabelMap(plugins, locale);
  return suppliers.map((supplier) => {
    const label = (supplier.source_kind === "plugin" ? pluginLabels.get(supplier.endpoint_key) : undefined)
      || supplier.label;
    return {
      value: supplier.supplier_id,
      label,
      endpointKey: supplier.endpoint_key,
      active: supplier.active,
      iconSrc: supplier.plugin_icon || undefined,
      icon: supplier.plugin_icon
        ? undefined
        : supplier.provider_type === "anthropic"
          ? claudeIcon
          : supplier.source_kind === "plugin"
            ? flatColorOrganizationIcon
            : openAiIcon,
    };
  });
}

export function buildModelFilterOptions(
  models: OverviewFilterModel[],
  plugins: PluginDescriptor[],
  locale: Locale,
): ModelSelectOption[] {
  const pluginGroups = buildPluginLabelMap(plugins, locale);
  return models.map((item) => ({
    value: item.supplier_key,
    label: item.active ? item.label : t("{label}（历史）", { label: item.label }),
    group: (item.source_kind === "plugin" ? pluginGroups.get(item.endpoint_key) : undefined) || item.group,
    iconSrc: item.plugin_icon || undefined,
    icon: item.plugin_icon
      ? undefined
      : item.provider_type === "anthropic"
        ? claudeIcon
        : item.source_kind === "plugin"
          ? flatColorOrganizationIcon
          : openAiIcon,
  }));
}
