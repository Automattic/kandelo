// The theme of a delo computer page, kept in this browser under `delo.theme`,
// apart from the app's `kandelo.theme`: Delo is an experiment, and its
// choice must not change the app.

const DELO_THEMES = ["wordpress-light", "wordpress-dark"] as const;

export type DeloTheme = typeof DELO_THEMES[number];

export const DELO_THEME_KEY = "delo.theme";

const DEFAULT_THEME: DeloTheme = "wordpress-light";

export const DELO_THEME_LABEL: Record<DeloTheme, string> = {
  "wordpress-light": "WordPress light",
  "wordpress-dark": "WordPress dark",
};

/** The stored theme, or the default when none is stored, the stored value is
 *  not a theme, or storage is unavailable. */
export function readDeloTheme(storage: Pick<Storage, "getItem">): DeloTheme {
  let stored: string | null;
  try {
    stored = storage.getItem(DELO_THEME_KEY);
  } catch {
    return DEFAULT_THEME;
  }
  return (DELO_THEMES as readonly (string | null)[]).includes(stored) ? stored as DeloTheme : DEFAULT_THEME;
}

/** Store `theme`. Storage that is unavailable keeps the theme for this page only. */
export function writeDeloTheme(storage: Pick<Storage, "setItem">, theme: DeloTheme): void {
  try {
    storage.setItem(DELO_THEME_KEY, theme);
  } catch {
    return;
  }
}

export function nextDeloTheme(theme: DeloTheme): DeloTheme {
  return DELO_THEMES[(DELO_THEMES.indexOf(theme) + 1) % DELO_THEMES.length];
}
