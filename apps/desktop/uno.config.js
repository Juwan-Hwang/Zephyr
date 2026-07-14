import { defineConfig, presetWind4 } from 'unocss'

export default defineConfig({
  presets: [
    presetWind4({
      dark: 'class',
      preflights: {
        reset: true,
        theme: 'on-demand',
        property: true,
      },
    }),
  ],

  cli: {
    entry: [
      {
        patterns: ['src/**/*.{html,js}'],
        outFile: 'src/uno-generated.css',
      },
    ],
  },

  theme: {
    colors: {
      accent: {
        DEFAULT: 'var(--accent-primary)',
        glow: 'var(--accent-glow)',
      },
      // ── Semantic color aliases (map to design-token CSS variables) ──
      success:   'var(--zephyr-color-success)',
      danger:    'var(--zephyr-color-danger)',
      warning:   'var(--zephyr-color-warning)',
      info:      'var(--zephyr-color-info)',
      'close-btn': 'var(--zephyr-color-close-btn)',
      download:  'var(--zephyr-color-download)',
      upload:    'var(--zephyr-color-upload)',
      orange:    'var(--zephyr-color-orange-500)',
      pink:      'var(--zephyr-color-pink-500)',
      cyan:      'var(--zephyr-color-cyan-500)',
      indigo:    'var(--zephyr-color-indigo-500)',
    },
    fontSize: {
      '2xs': ['0.625rem', { lineHeight: '1.4' }],
    },
  },

  // ── Static layout combinations (see PR3 §3.1 Component Carrier Boundary) ──
  shortcuts: {
    // Three-layer surface system
    'surface-1': 'bg-transparent',
    'surface-2': 'rounded-[var(--zephyr-radius-surface)] border border-[var(--zephyr-border-subtle)] bg-[var(--zephyr-surface-raised)]',
    'surface-3': 'rounded-[var(--zephyr-radius-overlay)] border border-[var(--zephyr-border-default)] bg-[var(--zephyr-surface-elevated)] shadow-[var(--zephyr-shadow-md)]',

    // Interactive panels
    'panel': 'surface-2 px-4 py-3',
    'panel-interactive': 'panel transition-colors hover:bg-[var(--zephyr-bg-muted)]',
  },
})
