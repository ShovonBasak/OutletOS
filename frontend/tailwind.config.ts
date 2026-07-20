import type { Config } from "tailwindcss";

// Brand colors sampled from the CP Five Star logo (per CLAUDE.md UI conventions).
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1C1A19",
        "ink-soft": "#5B5450",
        paper: "#FBF9F4",
        "paper-dim": "#EFEAE0",
        chrome: "#7A2420",
        "chrome-soft": "#8F332E",
        red: "#DE2E27",
        "red-deep": "#7A1712",
        gold: "#F0C419",
        "gold-deep": "#8A6A06",
        chili: "#C9601C",
        "chili-deep": "#7A3A10",
        leaf: "#3F6B3F",
        "leaf-deep": "#264A26",
        action: "#241512",
        "action-hover": "#3A211D",
      },
      fontFamily: {
        display: ["Space Grotesk", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
        body: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
