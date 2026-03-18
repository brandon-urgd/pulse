import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'pulse-theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'system';
}

/**
 * Theme switching hook.
 * - Persists to localStorage
 * - Falls back to prefers-color-scheme for "system"
 * - Applies immediately on toggle
 * Requirements: 3.22, 11.4, 11.5, 11.6
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  // Apply theme on mount and when system preference changes
  useEffect(() => {
    applyTheme(theme);

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, newTheme);
    } catch {
      // ignore
    }
    setThemeState(newTheme);
    applyTheme(newTheme);
  }, []);

  return { theme, setTheme };
}

/** Initialize theme before React renders (call in main.tsx) */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
