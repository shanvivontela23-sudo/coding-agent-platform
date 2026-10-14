import type { NextConfig } from "next";

// `pnpm demo` with DEMO_SHARE=1 serves the dev server through a public tunnel
// hostname; Next.js dev blocks its dev assets for origins that are not listed.
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
};

export default nextConfig;
