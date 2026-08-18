import type { NextConfig } from "next";

// ─── Environment-aware Content Security Policy ──────────────────────────────
// Turbopack dev mode compiles client chunks with `eval()` (HMR/fast refresh),
// so the DEVELOPMENT policy must allow 'unsafe-eval'. Production builds ship
// pre-compiled bundles and stay STRICT — no 'unsafe-eval', ever.
//
// Note: `next dev` runs with NODE_ENV=development and `next build`/`next start`
// with NODE_ENV=production, so this is a reliable discriminator at config time.
const isDevelopment = process.env.NODE_ENV === "development";

function buildContentSecurityPolicy(): string {
  // Next.js injects inline runtime scripts/styles, so 'unsafe-inline' is
  // required for script-src/style-src in both modes; everything else is
  // restricted to self. frame-ancestors 'none' blocks embedding.
  const scriptSrc = isDevelopment
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
    : "script-src 'self' 'unsafe-inline'; ";

  return (
    "default-src 'self'; " +
    scriptSrc +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'"
  );
}

const contentSecurityPolicy = buildContentSecurityPolicy();

const securityHeaders = [
  // Clickjacking protection
  { key: "X-Frame-Options", value: "DENY" },
  // MIME sniffing protection
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Enforce HTTPS (ignored by browsers over plain HTTP in dev)
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Limit referrer leakage
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Restrict browser features (camera/mic/geolocation unused by the app)
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), notifications=()" },
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
];

const nextConfig: NextConfig = {
  // On Vercel, the platform's adapter already handles server bundling;
  // combining it with standalone causes a known ENOENT on
  // .next/next-server.js.nft.json (https://github.com/vercel/next.js/issues/96646).
  // Standalone is still emitted for Docker / self-hosted builds.
  output: process.env.VERCEL ? undefined : "standalone",
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  // Reduce turbopack memory usage
  experimental: {
    optimizePackageImports: [
      'lucide-react',
      'framer-motion',
      'recharts',
      'date-fns',
      'react-markdown',
      'socket.io-client',
    ],
  },
};

export default nextConfig;
