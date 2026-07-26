// The browse page's light/dark theme.
//
// Unlike the popup's, this page always writes an explicit data-theme — the
// settings dropdown shows the current one by name, so "no attribute" is not a
// state it can describe. The two decisions (what a stored value means, and
// what the label reads) are separated from the writes so a spec can reach them.

type Theme = 'dark' | 'light';

const DEFAULT_THEME: Theme = 'dark';

/** localStorage holds arbitrary strings; only two of them are themes. */
const asTheme = (value: string | null, fallback: Theme): Theme => {
  if (value === 'dark' || value === 'light') return value;
  return fallback;
};

const oppositeTheme = (theme: Theme): Theme => {
  return theme === 'dark' ? 'light' : 'dark';
};

const themeLabel = (theme: Theme): string => {
  return theme === 'dark' ? 'Dark' : 'Light';
};

const systemTheme = (): Theme => {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
};

const currentTheme = (): Theme => {
  return asTheme(
    document.documentElement.getAttribute('data-theme'),
    DEFAULT_THEME,
  );
};

const applyTheme = (theme: Theme): void => {
  document.documentElement.setAttribute('data-theme', theme);
};

const initTheme = (): void => {
  const saved = localStorage.getItem('theme');
  applyTheme(saved ? asTheme(saved, DEFAULT_THEME) : systemTheme());
};

/** Flips the theme and remembers it — the popup reads the same key. */
const toggleTheme = (): Theme => {
  const next = oppositeTheme(currentTheme());
  applyTheme(next);
  localStorage.setItem('theme', next);
  return next;
};

export {
  asTheme,
  currentTheme,
  initTheme,
  oppositeTheme,
  themeLabel,
  toggleTheme,
};
export type { Theme };
