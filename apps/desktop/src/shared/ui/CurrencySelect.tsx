import { Select } from "./Select";
import type { DisplayCurrency } from "../utils/costFormat";

export function CurrencySelect({ value, disabled, onChange }: { value: DisplayCurrency; disabled?: boolean; onChange: (currency: DisplayCurrency) => void })
{
  const options = [
    { value: "USD", label: `USD · ${t("美元")}` },
    { value: "CNY", label: `CNY · ${t("人民币")}` },
    { value: "EUR", label: `EUR · ${t("欧元")}` },
    { value: "JPY", label: `JPY · ${t("日元")}` },
    { value: "TWD", label: `TWD · ${t("新台币")}` },
    { value: "TRY", label: `TRY · ${t("土耳其里拉")}` },
    { value: "KRW", label: `KRW · ${t("韩元")}` },
  ] satisfies { value: DisplayCurrency; label: string }[];

  return <Select value={value} options={options} ariaLabel={t("显示币种")} disabled={disabled} onChange={(value) => onChange(value as DisplayCurrency)} />;
}
