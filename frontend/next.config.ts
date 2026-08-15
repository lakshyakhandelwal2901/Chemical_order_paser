import type { NextConfig } from "next";

const frontendRoot = process.cwd();

const nextConfig: NextConfig = {
  turbopack: {
    root: frontendRoot,
  },
  async rewrites() {
    return [
      {
        source: "/api/parser/:path*",
        destination: "http://127.0.0.1:3001/api/:path*",
      },
      {
        source: "/api/busynotify/:path*",
        destination: "http://127.0.0.1:8000/api/:path*",
      },
    ];
  },
};

export default nextConfig;