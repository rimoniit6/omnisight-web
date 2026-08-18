import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { QueryProvider } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OmniSight - AI-Powered Workforce Intelligence",
  description: "Monitor, analyze, and optimize your workforce productivity with AI-driven insights.",
  icons: {
    // Single canonical favicon configuration:
    //  - /favicon.svg — tight-crop SVG derivative of the canonical mark
    //    (crisp in modern Chromium/Firefox/Edge tab UI)
    //  - /favicon.ico — 16/32/48 raster fallback (legacy/Windows surfaces)
    //  - /apple-touch-icon.png — 180px raster for iOS home screen
    // All derived from public/logos/omnisight.svg by
    // scripts/generate-brand-assets.mjs.
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          <QueryProvider>
            {children}
          </QueryProvider>
          <Toaster position="top-right" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
