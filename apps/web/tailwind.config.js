/**
 * Tokens from docs/design-system.md.
 *
 * State colours have separate dark values. Measured on #0E1116, the light
 * variants fail: sealed 3.09:1, pending 3.88:1, and broken 2.65:1 — which
 * fails even the relaxed 3:1 threshold for a non-text component. The colour
 * that says "this evidence was tampered with" was the least visible thing on
 * screen in dark mode. The dark values below all clear 4.5:1.
 */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: '#16202B',
        paper: '#F7F8FA',
        vault: '#0E1116',
        sealed: { DEFAULT: '#1F6F4A', dark: '#278D5E' },
        broken: { DEFAULT: '#A32B2B', dark: '#D15151' },
        pending: { DEFAULT: '#8A6D2F', dark: '#977733' },
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        serif: ['IBM Plex Serif', 'ui-serif', 'Georgia', 'serif'],
      },
      fontSize: {
        xs: '12px', sm: '13px', base: '15px', lg: '18px', xl: '24px', '2xl': '32px',
      },
    },
  },
  plugins: [],
};
