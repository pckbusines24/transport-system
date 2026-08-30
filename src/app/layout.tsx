import type { Metadata, Viewport } from "next";
import { Poppins, Roboto_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/app/theme-provider";
import { Toaster } from "@/components/ui/toaster";

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
 * next/font self-hosts the files at build time — no runtime request to Google,
 * and no layout shift.
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
const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-numeric",
  display: "swap",
});

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
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
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
