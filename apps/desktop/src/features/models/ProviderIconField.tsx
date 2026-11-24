import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { providerIconPresets, resolveProviderIcon } from "../../shared/utils/providerIcons";
import styles from "./ProviderIconField.module.scss";

const ICON_SIZE = 96;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function readProviderIcon(file: File): Promise<string>
{
  if (file.size > MAX_FILE_BYTES)
  {
    throw new Error(t("图标图片不能超过 2 MB"));
  }
  const header = new DataView(await file.slice(0, 12).arrayBuffer());
  const supported = header.byteLength === 12 && (
    (header.getUint32(0) === 0x89504e47 && header.getUint32(4) === 0x0d0a1a0a)
    || (header.getUint16(0) === 0xffd8 && header.getUint8(2) === 0xff)
    || (header.getUint32(0) === 0x52494646 && header.getUint32(8) === 0x57454250)
  );
  if (!supported)
  {
    throw new Error(t("请选择 PNG、JPEG 或 WebP 图片"));
  }

  try
  {
    const bitmap = await createImageBitmap(file);
    try
    {
      const canvas = document.createElement("canvas");
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      const context = canvas.getContext("2d");
      if (!context)
      {
        throw new Error("Canvas unavailable");
      }
      const scale = ICON_SIZE / Math.max(bitmap.width, bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, Math.floor((ICON_SIZE - width) / 2), Math.floor((ICON_SIZE - height) / 2), width, height);
      return canvas.toDataURL("image/png");
    }
    finally
    {
      bitmap.close();
    }
  }
  catch
  {
    throw new Error(t("无法读取图标图片"));
  }
}

export function ProviderIconField({ icon, baseUrl, disabled, uploading, onChange, onUploadingChange }: {
  icon: string | null;
  baseUrl: string;
  disabled: boolean;
  uploading: boolean;
  onChange: (icon: string | null) => void;
  onUploadingChange: (uploading: boolean) => void;
})
{
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | null>(null);
  const choicesId = useId();
  const locked = disabled || uploading;
  const { visual, name } = resolveProviderIcon(icon, baseUrl);
  const description = icon === null
    ? t("自动匹配 · {name}", { name: name ?? t("通用图标") })
    : name ?? (visual.src ? t("自定义图标") : t("通用图标"));

  useEffect(() => () => upload.current?.abort(), []);

  const close = () => {
    setError(null);
    setOpen(false);
    if (field.current?.contains(document.activeElement))
    {
      trigger.current?.focus({ preventScroll: true });
    }
  };

  const choose = (nextIcon: string | null) => {
    onChange(nextIcon);
    close();
  };

  const importIcon = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || disabled || upload.current)
    {
      return;
    }

    const task = new AbortController();
    upload.current = task;
    setError(null);
    onUploadingChange(true);
    try
    {
      const nextIcon = await readProviderIcon(file);
      if (!task.signal.aborted)
      {
        choose(nextIcon);
      }
    }
    catch (cause)
    {
      if (!task.signal.aborted)
      {
        setError(cause instanceof Error ? cause.message : t("无法读取图标图片"));
      }
    }
    finally
    {
      upload.current = null;
      if (!task.signal.aborted)
      {
        onUploadingChange(false);
      }
    }
  };

  return <div ref={field} className={styles.field} onKeyDown={(event) => {
    if (event.key === "Escape" && open && !locked)
    {
      event.stopPropagation();
      event.preventDefault();
      close();
    }
  }}>
    <div className={styles.label}>{t("供应商图标")}</div>
    <div className={styles.preview}>
      <Icon {...visual} size="1.5em" />
      <span>{description}</span>
      <Button ref={trigger} size="small" disabled={disabled} aria-disabled={uploading || undefined} aria-expanded={open} aria-controls={open ? choicesId : undefined} onClick={() => {
        if (locked)
        {
          return;
        }
        if (open)
        {
          close();
        }
        else
        {
          setOpen(true);
        }
      }}>{t("更换图标")}</Button>
    </div>
    {open && <div id={choicesId} className={styles.choices} role="group" aria-label={t("选择供应商图标")} aria-busy={locked || undefined}>
      <div className={styles.actions}>
        <Button size="small" disabled={locked} aria-pressed={icon === null} onClick={() => choose(null)}>{t("使用自动匹配")}</Button>
        <Button size="small" disabled={disabled} aria-disabled={uploading || undefined} onClick={() => {
          if (!locked)
          {
            fileInput.current?.click();
          }
        }}>{uploading ? t("正在处理图片…") : t("上传图片")}</Button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={locked} aria-label={t("上传图片")} onChange={(event) => void importIcon(event)} />
      </div>
      {error && <div role="alert" className={styles.error}>{error}</div>}
      <div className={styles.presets}>
        {providerIconPresets.map((preset) => <Button key={preset.key} size="small" disabled={locked} aria-pressed={icon === preset.key} onClick={() => choose(preset.key)}>
          <Icon {...preset.visual} />
          <span>{preset.name}</span>
        </Button>)}
      </div>
    </div>}
  </div>;
}
