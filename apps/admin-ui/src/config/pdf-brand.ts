// PDF brand constants — centralized for all @react-pdf/renderer components
// Note: @react-pdf/renderer does not support CSS custom properties,
// so these are JS constants, not CSS variables.

export const PDF_COLORS = {
  accent: '#7a9e87',
  accentAmber: '#d4a843',
  accentBlue: '#5b8db8',
  page: '#ffffff',
  text: '#212529',
  textSecondary: '#495057',
  textMuted: '#868e96',
  border: '#e9ecef',
  bgSubtle: '#f8f9fa',
} as const;

export const PDF_SIGNAL_STYLES = {
  conviction: { border: '#7a9e87', bg: '#f0f7f2', heading: '#5a7e67', icon: '✓', label: 'What Landed' },
  tension:    { border: '#d4a843', bg: '#fdf8ed', heading: '#8a6d2b', icon: '⚠', label: 'Where It Struggled' },
  uncertainty:{ border: '#5b8db8', bg: '#edf4fa', heading: '#3d6d94', icon: '?', label: 'Open Questions' },
} as const;

export const PDF_SIGNAL_TYPE_COLORS: Record<string, string> = {
  conviction: '#5a7e67',
  tension: '#8a6d2b',
  uncertainty: '#3d6d94',
};

export const PDF_FONTS = {
  heading: 'Archivo',
  body: 'Rubik',
} as const;
