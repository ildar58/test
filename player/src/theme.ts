import type { ThemeTokens, ThemeInput, ThemeName } from './types';

export const themes: Record<ThemeName, Required<ThemeTokens>> = {
  dark: {
    accent: '#ffdd2d',
    accentStrong: '#b69500',
    onAccent: '#15130a',
    bg: '#0a0b0d',
    surface: '#131519',
    surface2: '#181b21',
    inset: '#0c0e11',
    text: '#eef0f4',
    text2: '#a4abb8',
    text3: '#6c7480',
    line: 'rgba(255,255,255,0.07)',
    line2: 'rgba(255,255,255,0.13)',
    radius: '16px',
    radiusSm: '12px',
    font: "'Onest', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
  },
  light: {
    accent: '#ffdd2d',
    accentStrong: '#a98a00',
    onAccent: '#15130a',
    bg: '#f4f5f7',
    surface: '#ffffff',
    surface2: '#eef0f3',
    inset: '#e9ebef',
    text: '#16181d',
    text2: '#515864',
    text3: '#878e9b',
    line: 'rgba(0,0,0,0.10)',
    line2: 'rgba(0,0,0,0.16)',
    radius: '16px',
    radiusSm: '12px',
    font: "'Onest', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
  },
};

const VAR: Record<keyof ThemeTokens, string> = {
  accent: '--pam-accent',
  accentStrong: '--pam-accent-strong',
  onAccent: '--pam-on-accent',
  bg: '--pam-bg',
  surface: '--pam-surface',
  surface2: '--pam-surface-2',
  inset: '--pam-inset',
  text: '--pam-text',
  text2: '--pam-text-2',
  text3: '--pam-text-3',
  line: '--pam-line',
  line2: '--pam-line-2',
  radius: '--pam-radius',
  radiusSm: '--pam-radius-sm',
  font: '--pam-font',
  mono: '--pam-mono',
};

export function resolveTheme(theme: ThemeInput = 'dark'): Required<ThemeTokens> {
  if (typeof theme === 'string') return themes[theme] ?? themes.dark;
  const base = themes[theme.preset ?? 'dark'] ?? themes.dark;
  const out: Record<string, string> = { ...base };
  for (const k of Object.keys(VAR) as (keyof ThemeTokens)[]) {
    const v = theme[k];
    if (v != null) out[k] = v;
  }
  return out as Required<ThemeTokens>;
}

export function applyTheme(host: HTMLElement, theme: ThemeInput): void {
  const t = resolveTheme(theme);
  for (const k of Object.keys(VAR) as (keyof ThemeTokens)[]) {
    host.style.setProperty(VAR[k], t[k]);
  }
}
