import { useSyncExternalStore } from "react";
import { setRuntimeLocale, type Locale, type LocalePreference } from "./runtime";

export type { LocalePreference } from "./runtime";

type I18nSnapshot = {
  preference: LocalePreference;
  locale: Locale;
};

const listeners = new Set<() => void>();
let initialized = false;
let snapshot: I18nSnapshot = { preference: "system", locale: "en-US" };

export function resolveSystemLocale(
  languages: readonly string[] = navigator.languages.length
    ? navigator.languages
    : [navigator.language],
): Locale {
  const normalized = languages[0]?.toLowerCase() ?? "";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return "en-US";
}

function applyPreference(preference: LocalePreference, notify: boolean) {
  const locale = preference === "system" ? resolveSystemLocale() : preference;
  const changed = snapshot.preference !== preference || snapshot.locale !== locale;
  snapshot = { preference, locale };
  setRuntimeLocale(locale);
  document.documentElement.lang = locale;
  if (notify && changed) listeners.forEach((listener) => listener());
}

export function initializeI18n(initialPreference: LocalePreference = "system") {
  applyPreference(initialPreference, false);
  if (initialized) return;
  initialized = true;
  window.addEventListener("languagechange", () => {
    if (snapshot.preference === "system") applyPreference("system", true);
  });
}

export function applyLocalePreference(preference: LocalePreference) {
  applyPreference(preference, true);
}

export function getLocalePreference(): LocalePreference {
  return snapshot.preference;
}

export function useI18n(): I18nSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
