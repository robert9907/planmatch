export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'planmatch.theme';

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

export function writeStoredTheme(theme: Theme): void {
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function applyTheme(theme: Theme): void {
  const body = document.body;
  if (theme === 'dark') body.classList.add('dark');
  else body.classList.remove('dark');
  body.dataset.theme = theme;
}
