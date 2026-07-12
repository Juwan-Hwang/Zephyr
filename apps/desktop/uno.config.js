import { defineConfig, presetWind4 } from 'unocss'

export default defineConfig({
  presets: [
    presetWind4({
      dark: 'class',
      preflights: { reset: true },
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
    },
    radius: {
      DEFAULT: 'var(--zephyr-radius-sm)',
      sm: 'var(--zephyr-radius-sm)',
      md: 'var(--zephyr-radius-md)',
      lg: 'var(--zephyr-radius-lg)',
      xl: '0.75rem',
      '2xl': '1rem',
      '3xl': '1.5rem',
      full: 'var(--zephyr-radius-full)',
    },
    text: {
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '1.4' }],
      },
    },
  },
})
