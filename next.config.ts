import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A stray package-lock.json in the user's home folder would otherwise be picked as the workspace root.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
