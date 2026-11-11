export const themeIds = ["system", "default-dark", "default-light"] as const;
export type ThemeId = (typeof themeIds)[number];
export type ResolvedThemeId = "default-dark" | "default-light";

export const themeOptions = [
  { id: "system" },
  { id: "default-dark" },
  { id: "default-light" },
] satisfies { id: ThemeId }[];

let activeSystemMedia: MediaQueryList | null = null;
let systemChangeListener: ((event: MediaQueryListEvent) => void) | null = null;

export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && themeIds.some((id) => id === value);
}

export function resolveSystemTheme(): ResolvedThemeId {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "default-dark" : "default-light";
  }
  return "default-dark";
}

export function resolveTheme(themeId: ThemeId): ResolvedThemeId {
  return themeId === "system" ? resolveSystemTheme() : themeId;
}

function applyResolvedTheme(resolved: ResolvedThemeId) {
  const light = resolved === "default-light";
  const background = light ? "#f5f5f5" : "#141414";
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.setProperty("--startup-background", background);
  document.documentElement.style.colorScheme = light ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
}

function stopSystemThemeListener() {
  if (!activeSystemMedia || !systemChangeListener) return;
  if (typeof activeSystemMedia.removeEventListener === "function") {
    activeSystemMedia.removeEventListener("change", systemChangeListener);
  } else {
    activeSystemMedia.removeListener(systemChangeListener);
  }
  activeSystemMedia = null;
  systemChangeListener = null;
}

export function applyTheme(themeId: ThemeId) {
  stopSystemThemeListener();
  applyResolvedTheme(resolveTheme(themeId));
  if (themeId !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = () => {
    applyResolvedTheme(media.matches ? "default-dark" : "default-light");
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleChange);
  } else {
    media.addListener(handleChange);
  }
  activeSystemMedia = media;
  systemChangeListener = handleChange;
}
