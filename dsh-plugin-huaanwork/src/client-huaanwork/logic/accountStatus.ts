export type SidecarTone = "ok" | "wait" | "dead";
export type ThemePref = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "huaanwork.theme";

export function sidecarStatus(ready: boolean, dead: boolean): { tone: SidecarTone; label: string } {
  if (dead) return { tone: "dead", label: "sidecar 已退出，请重启应用" };
  if (ready) return { tone: "ok", label: "sidecar 就绪" };
  return { tone: "wait", label: "sidecar 启动中…" };
}

export function parseTheme(value: unknown): ThemePref {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  if (pref === "light" || pref === "dark") return pref;
  return systemDark ? "dark" : "light";
}

export function applyHtmlTheme(resolved: "light" | "dark"): void {
  document.documentElement.dataset.theme = resolved;
}

export function persistThemeMirror(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* ignore quota / private mode */
  }
}
