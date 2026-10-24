import type { NextConfig } from "next";

// The browser only talks to the web app; /api/* and the live hub /hubs/* are proxied to the .NET API, so the sign-in cookie stays
// same-origin and no CORS setup is needed (as in AWS One).
const apiUrl = process.env.ONEPOS_API_URL ?? "http://localhost:5090";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
  // The web address prefix on the servers (/onepos, /onepos-test; empty locally); hand-built URLs use lib/base-path.ts.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  experimental: { turbopackFileSystemCacheForDev: false },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
      { source: "/hubs/:path*", destination: `${apiUrl}/hubs/:path*` },
    ];
  },
};

export default nextConfig;
