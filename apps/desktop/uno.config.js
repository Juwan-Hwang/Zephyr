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
    },
    fontSize: {
      '2xs': ['0.625rem', { lineHeight: '1.4' }],
    },
  },
})
