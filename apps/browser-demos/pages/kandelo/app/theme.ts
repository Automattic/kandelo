export type ThemeFamily = "ubuntu" | "wordpress" | "kandelo";
export type ResolvedThemeMode = "light" | "dark";
export type ThemeMode = ResolvedThemeMode | "auto";
export type ThemePreference = {
  family: ThemeFamily;
  mode: ThemeMode;
};

export const THEME_STORAGE_KEY = "kandelo.theme";
export const THEME_STORAGE_VERSION = 4;

export type StoredThemePreference = ThemePreference & {
  version: typeof THEME_STORAGE_VERSION;
};

const DEFAULT_THEME: ThemePreference = { family: "kandelo", mode: "auto" };
export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return DEFAULT_THEME;

  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<StoredThemePreference>;
    if (
      parsed.version !== THEME_STORAGE_VERSION &&
      parsed.version !== 2 &&
      parsed.version !== 1
    ) {
      return DEFAULT_THEME;
    }
    const family = normalizeThemeFamily(parsed.family);
    const mode = parsed.mode;
    if (!family || !isThemeMode(mode)) return DEFAULT_THEME;
    return { family, mode };
  } catch {
    return DEFAULT_THEME;
  }
}

function normalizeThemeFamily(value: unknown): ThemeFamily | null {
  switch (value) {
    case "playground":
      return "wordpress";
    case "wordpress":
    case "kandelo":
    case "ubuntu":
      return value;
    case "balanced":
    case "terminal":
      return "kandelo";
    default:
      return null;
  }
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "auto" || value === "light" || value === "dark";
}

export function getSystemThemeMode(): ResolvedThemeMode {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: ThemePreference, resolvedMode: ResolvedThemeMode): void {
  const root = document.documentElement;
  root.dataset.kTheme = theme.family;
  root.dataset.kMode = resolvedMode;
  root.dataset.kModePreference = theme.mode;
  root.style.colorScheme = resolvedMode;
}

/** Apply the same preference before an invitation can render during boot. */
export function initializeTheme(): void {
  const theme = readThemePreference();
  applyTheme(theme, theme.mode === "auto" ? getSystemThemeMode() : theme.mode);
}
