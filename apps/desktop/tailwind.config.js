/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ["./src/**/*.{html,js}"],
  theme: {
    extend: {
      fontSize: {
        '2xs': ['10px', { lineHeight: '1.4' }],
      },
    },
  },
  plugins: [],
}
