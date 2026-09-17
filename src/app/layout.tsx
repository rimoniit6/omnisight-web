import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { QueryProvider } from "@/components/providers";
import { BrandingMeta } from "@/components/branding/branding-meta";
import { getPlatformBranding } from "@/lib/branding";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getPlatformBranding();
  const title = branding.browserTitle || "OmniSight - AI-Powered Workforce Intelligence";
  const siteName = branding.brandName || "OmniSight";
  const logoUrl = branding.logoUrl || "/logos/omnisight.svg";
  const faviconUrl = branding.faviconUrl || "/favicon.svg";

  return {
    title: {
      default: title,
      template: `%s · ${siteName}`,
    },
    description: "Monitor, analyze, and optimize your workforce productivity with AI-driven insights. Real-time activity monitoring, screenshots & OCR, and a Customer Database option for full data control.",
    keywords: [
      "workforce intelligence",
      "employee monitoring",
      "productivity analytics",
      "AI insights",
      "customer database monitoring",
      "screenshot OCR",
    ],
    icons: {
      icon: [
        { url: faviconUrl, type: faviconUrl.endsWith(".svg") ? "image/svg+xml" : undefined, sizes: "any" },
        { url: "/favicon.ico", sizes: "any" },
      ],
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      type: "website",
      locale: "en_US",
      url: "/",
      siteName,
      title,
      description:
        "Real-time workforce monitoring with AI insights, screenshot & OCR, and a Customer Database option for full data control.",
      images: [{ url: logoUrl, width: 512, height: 512, alt: siteName }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description:
        "Workforce intelligence, built for privacy. Real-time monitoring + Customer Database option.",
      images: [logoUrl],
    },
  };
}

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
            <BrandingMeta />
            {children}
          </QueryProvider>
          <Toaster position="top-right" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
