/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        tajawal: ['Tajawal', 'sans-serif'],
      },
      colors: {
        primary: {
          50:  '#e8f0fb',
          100: '#d6e4f7',
          200: '#adc8ef',
          300: '#84ade6',
          400: '#5b91de',
          500: '#2980b9',
          600: '#1a5276',
          700: '#143d59',
          800: '#0e293c',
          900: '#07141e',
        },
        success: {
          50:  '#eafaf1',
          100: '#d5f5e3',
          500: '#27ae60',
          600: '#1e8449',
        },
        warning: {
          50:  '#fef9e7',
          100: '#fdebd0',
          500: '#f39c12',
          600: '#b7770d',
        },
        danger: {
          50:  '#fdedec',
          100: '#fadbd8',
          500: '#e74c3c',
          600: '#922b21',
        },
      },
      borderRadius: {
        DEFAULT: '12px',
        sm: '8px',
        lg: '16px',
        xl: '20px',
      },
    },
  },
  plugins: [],
}
