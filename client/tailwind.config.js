/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: { 700: "#1B3A5C", 800: "#132C47", 900: "#0C1F33" },
        steel: { 50: "#F0F4F8", 100: "#D9E2EC", 200: "#BCCCDC", 500: "#627D98" },
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
