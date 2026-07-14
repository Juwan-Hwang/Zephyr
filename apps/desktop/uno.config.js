import { defineConfig, presetWind4 } from 'unocss'

export default defineConfig({
  presets: [
    presetWind4({
      dark: 'class',
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
    },
    fontSize: {
      '2xs': ['0.625rem', { lineHeight: '1.4' }],
    },
  },
})
