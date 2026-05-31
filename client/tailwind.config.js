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
          DEFAULT: "var(--accent)",
          hover:   "var(--accent-hover)",
          press:   "var(--accent-press)",
          2:       "var(--accent-2)",
        },
        console: {
          bg:          "var(--bg)",
          "bg-deep":   "var(--bg-deep)",
          surface:     "var(--surface)",
          "surface-2": "var(--surface-2)",
          border:      "var(--border)",
          "fg-1":      "var(--fg-1)",
          "fg-2":      "var(--fg-2)",
          "fg-3":      "var(--fg-3)",
        },
      },
      fontFamily: {
        // Keep original for app UI
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        // Ember / Console brand font (used in Pages site)
        mono: ['"JetBrains Mono"', "Consolas", "monospace"],
      },
      backgroundImage: {
        "ember-gradient": "var(--gradient-brand)",
      },
      borderWidth: {
        "3": "3px",
      },
    },
  },
  plugins: [],
};
