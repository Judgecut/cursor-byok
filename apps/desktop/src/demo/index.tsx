import { installDemoApi } from "./api";

installDemoApi();

const params = new URLSearchParams(window.location.search);
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
const rawTheme = params.get("theme");
const theme = rawTheme === "system" || rawTheme === "default-light" || rawTheme === "default-dark" ? rawTheme : "default-dark";

document.documentElement.dataset.platform = "macos";
localStorage.setItem("cursor-byok.locale", locale);
localStorage.setItem("cursor-byok.theme", theme);

void import("../index");
