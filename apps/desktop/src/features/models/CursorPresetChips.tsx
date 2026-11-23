import { modelPresets, requestFormatLabels, trimTrailingSlash, type ModelPreset, type ModelPresetEndpoint } from "../../shared/utils/modelPresets";
import styles from "./CursorPresetChips.module.scss";

export function CursorPresetChips({ baseUrl, onPick }: { baseUrl: string; onPick: (preset: ModelPreset, endpoint: ModelPresetEndpoint) => void }) {
  return <div className={styles.wrap}>
    <span className={styles.label}>{t("常用预设")}</span>
    <div className={styles.chips}>
      {modelPresets.flatMap((preset) => preset.endpoints.map((endpoint) => {
        const active = trimTrailingSlash(baseUrl) === trimTrailingSlash(endpoint.baseUrl);
        return <button
          type="button"
          key={`${preset.key}-${endpoint.format}`}
          className={active ? `${styles.chip} ${styles.active}` : styles.chip}
          title={preset.keyHint}
          onClick={() => onPick(preset, endpoint)}
        >
          <img className={styles.icon} src={preset.icon} alt="" />
          {preset.name} · {requestFormatLabels[endpoint.format]}
        </button>;
      }))}
    </div>
  </div>;
}
