export const THEMES = {
  dark: { label: 'Dark', logo: '/_catalog/ui/logos/neutral.svg', brand: 'Demo' },
  light: { label: 'Light', logo: '/_catalog/ui/logos/neutral.svg', brand: 'Demo' },
} as const;
export type ThemeKey = keyof typeof THEMES;

export function currentTheme(): ThemeKey {
  const t = document.documentElement.getAttribute('data-theme');
  return t && t in THEMES ? (t as ThemeKey) : 'dark';
}
export function applyTheme(key: ThemeKey) {
  document.documentElement.setAttribute('data-theme', key);
  try { localStorage.setItem('app-catalog-theme', key); } catch { /* private mode */ }
}
