import type { Config } from "tailwindcss";

/**
 * Every value here resolves to a CSS variable declared in globals.css, so the
 * design system has exactly one source of truth and dark mode is a variable
 * swap rather than a second set of classes. See /design-system for a specimen.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },

        /* a shade below the card: table headers, insets, empty wells */
        sunken: { DEFAULT: "hsl(var(--sunken))", foreground: "hsl(var(--sunken-foreground))" },
        /* the emphasis panel — near-black in light mode, lifted slate in dark */
        inverted: {
          DEFAULT: "hsl(var(--inverted))",
          foreground: "hsl(var(--inverted-foreground))",
          muted: "hsl(var(--inverted-muted))",
        },

        /* semantic status, so a badge never hard-codes green or red */
        success: { DEFAULT: "hsl(var(--success))", foreground: "hsl(var(--success-foreground))" },
        warning: { DEFAULT: "hsl(var(--warning))", foreground: "hsl(var(--warning-foreground))" },
        info: { DEFAULT: "hsl(var(--info))", foreground: "hsl(var(--info-foreground))" },

        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          muted: "hsl(var(--sidebar-muted))",
          border: "hsl(var(--sidebar-border))",
          accent: "hsl(var(--sidebar-accent))",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        sm: "calc(var(--radius) - 6px)",
        md: "calc(var(--radius) - 3px)",
        lg: "var(--radius)",
        /* panels and dialogs */
        xl: "var(--radius-panel)",
        /* the outer app shell */
        "2xl": "var(--radius-frame)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        card: "var(--shadow-card)",
        raised: "var(--shadow-raised)",
        overlay: "var(--shadow-overlay)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        DEFAULT: "var(--duration)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "none" },
        },
      },
      animation: {
        "fade-in": "fade-in var(--duration) var(--ease-out) both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
export default config;
