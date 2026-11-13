import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/app/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import { NumberInputGuard } from "@/components/app/number-input-guard";

/**
 * Poppins is not a variable font on Google Fonts, so the weights the design
 * system actually uses have to be listed explicitly:
 *   300 display type and large figures (the light/large contrast is the look)
 *   400 body
 *   500 labels, table headers, buttons
 *   600 headings and the wordmark
 * Anything not listed here would silently synthesise a faux-bold, which looks
 * muddy at large sizes.
 *
 * The files live in ./fonts (latin subset, from Fontsource) and load through
 * next/font/local: no request to Google at build OR run time, and no layout
 * shift. next/font/google broke the build when Google Fonts started serving
 * file URLs its loader could not parse ("Cannot read properties of null").
 */
/**
 * Figures only. Poppins ships NO tabular figure set — measured in a browser,
 * `font-variant-numeric: tabular-nums` is a no-op on it and a "1" is half the
 * width of an "8". In an app that is mostly freight amounts and ledger
 * columns, that means totals stop lining up under the numbers above them.
 *
 * So text is Poppins and FIGURES IN COLUMNS are Roboto Mono, which has real
 * tabular figures. Scoped to tables and .tabular in globals.css — prose keeps
 * Poppins numerals, which look better inline.
 */
const robotoMono = localFont({
  src: [
    { path: "./fonts/roboto-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/roboto-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-numeric",
  display: "swap",
});

const poppins = localFont({
  src: [
    { path: "./fonts/poppins-latin-300-normal.woff2", weight: "300", style: "normal" },
    { path: "./fonts/poppins-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/poppins-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/poppins-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TransportTMS",
  description: "Transport management system",
  appleWebApp: { capable: true, title: "TransportTMS", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // lets the layout paint under the notch / home indicator; the shell adds the
  // matching env(safe-area-inset-*) padding back
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    // both match --card, since the header is what sits under the status bar
    { media: "(prefers-color-scheme: dark)", color: "#161a21" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${poppins.variable} ${robotoMono.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
          <NumberInputGuard />
        </ThemeProvider>
      </body>
    </html>
  );
}
