import withPWA from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
};

export default withPWA({
  dest: "public",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
    disableDevLogs: true,
    importScripts: ["/sw-push-handler.js"],
    runtimeCaching: [
      {
        // Products list — changes only when owner edits menu. Cache 5 min.
        urlPattern: /\/api\/products\/(\?.*)?$/,
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "api-products",
          expiration: { maxAgeSeconds: 300, maxEntries: 10 },
        },
      },
      {
        // Sales channels — change rarely (owner admin only). Cache 10 min.
        urlPattern: /\/api\/sales-channels\//,
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "api-channels",
          expiration: { maxAgeSeconds: 600, maxEntries: 5 },
        },
      },
      {
        // Outlets — essentially static. Cache 60 min.
        urlPattern: /\/api\/outlets\//,
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "api-outlets",
          expiration: { maxAgeSeconds: 3600, maxEntries: 5 },
        },
      },
    ],
  },
})(nextConfig);
