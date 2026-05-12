import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep these packages out of Next's server bundler. They either use native
  // addons (better-sqlite3) or spawn external binaries shipped inside their
  // own node_modules folder (youtube-dl-exec ships yt-dlp.exe). Bundling
  // rewrites require() paths and breaks the binary discovery — the symptom
  // is yt-dlp failing silently with an empty error message.
  serverExternalPackages: ["better-sqlite3", "youtube-dl-exec"],
};

export default nextConfig;
