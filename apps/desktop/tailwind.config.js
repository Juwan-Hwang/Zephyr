/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ["./src/**/*.{html,js}"],
  theme: {
    extend: {
      borderRadius: {
        'sm': '9px',
        'md': '12px',
        'lg': '17px',
        'xl': '24px',
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '1.4' }],
      },
    },
  },
  plugins: [],
}
