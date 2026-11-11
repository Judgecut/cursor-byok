import { installDemoApi } from "./api";
import type { LocalePreference } from "../i18n/runtime";
import type { ThemeId } from "../shared/theme/theme";

const params = new URLSearchParams(window.location.search);
const rawLocale = params.get("locale");
const locale: LocalePreference = rawLocale === "en-US" || rawLocale === "pt-BR" || rawLocale === "system"
  ? rawLocale
  : "zh-CN";
const rawTheme = params.get("theme");
const theme: ThemeId = rawTheme === "system" || rawTheme === "default-light" || rawTheme === "default-dark"
  ? rawTheme
  : "default-dark";

document.documentElement.dataset.platform = "macos";
installDemoApi({ locale, theme });

void import("../index");
