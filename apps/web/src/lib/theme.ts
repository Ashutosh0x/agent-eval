/**
 * Theme preference.
 *
 * Three states, not a boolean. "System" is a real choice — a person who wants
 * the interface to follow their OS is expressing something a light/dark toggle
 * cannot store, and collapsing it loses that on the next OS change.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'agent-eval.theme';

export function readTheme(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function writeTheme(choice: ThemeChoice): void {
  localStorage.setItem(KEY, choice);
}

/** Resolve a choice to what should actually render. */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.classList.toggle('dark', resolveTheme(choice) === 'dark');
}
