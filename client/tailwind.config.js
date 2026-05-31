/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./pages/**/*.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Original navy/steel palette (app UI — unchanged)
        navy: { 700: "#1B3A5C", 800: "#132C47", 900: "#0C1F33" },
        steel: { 50: "#F0F4F8", 100: "#D9E2EC", 200: "#BCCCDC", 500: "#627D98" },
        // Ember / Console design-system surfaces
        ember: {
          DEFAULT: "#d97757",
          hover:   "#e48970",
          press:   "#b8603f",
          2:       "#e8a285",
        },
        console: {
          bg:          "#08080c",
          "bg-deep":   "#050507",
          surface:     "#101018",
          "surface-2": "#16161e",
          border:      "#2c2c36",
          "fg-1":      "#ececde",
          "fg-2":      "#8a8a82",
          "fg-3":      "#50504a",
        },
      },
      fontFamily: {
        // Keep original for app UI
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        // Ember / Console brand font (used in Pages site)
        mono: ['"JetBrains Mono"', "Consolas", "monospace"],
      },
      backgroundImage: {
        "ember-gradient": "linear-gradient(135deg, #d97757 0%, #e8a285 100%)",
      },
      borderWidth: {
        "3": "3px",
      },
    },
  },
  plugins: [],
};
