import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const isBuild = process.argv.includes("build");
const isProd = process.env.NODE_ENV === "production";

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 3000;

if (!isBuild && !rawPort) {
  throw new Error(
    "PORT environment variable is required for dev server.",
  );
}

const basePath = process.env.BASE_PATH || "/";
const siteBaseUrl = (process.env.BASE_URL || "https://findandstudy.com").replace(/\/$/, "");

const injectSiteBaseUrl = {
  name: "inject-site-base-url",
  transformIndexHtml(html: string) {
    return html.replace(/__SITE_BASE_URL__/g, siteBaseUrl);
  },
};

export default defineConfig({
  base: basePath,
  plugins: [
    injectSiteBaseUrl,
    react(),
    tailwindcss(),
    // Bundle analysis (opt-in): ANALYZE=1 pnpm --filter @workspace/edcons build
    // → dist/stats.html treemap. devDependency only, never in prod runtime.
    ...(isBuild && process.env.ANALYZE
      ? [
          (await import("rollup-plugin-visualizer")).visualizer({
            filename: "dist/stats.html",
            gzipSize: true,
            template: "treemap" as const,
          }),
        ]
      : []),
    ...(process.env.NODE_ENV !== "production"
      ? [
          runtimeErrorOverlay({
            filter: (error: Error) => {
              if (error.message === "(unknown runtime error)") return false;
              if (error.message?.includes("HTTP 401")) return false;
              if (error.message?.includes("HTTP 403")) return false;
              return true;
            },
          }),
        ]
      : []),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  root: path.resolve(import.meta.dirname),
  esbuild: isProd
    ? { drop: ["console", "debugger"] }
    : undefined,
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Production maps must not be published with the static web root. Enable
    // hidden maps only for an explicit private error-monitoring upload step.
    sourcemap: !isProd && process.env.GENERATE_SOURCEMAPS === "1" ? "hidden" : false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/") || id.includes("react/jsx-runtime")) {
            return "vendor-react";
          }
          if (id.includes("@tanstack/react-query")) return "vendor-react";
          if (id.includes("@radix-ui/")) return "vendor-radix";
          if (id.includes("react-phone-number-input") || id.includes("libphonenumber-js")) {
            return "vendor-phone";
          }
          // Keep PDF libraries inside the lazy feature chunk that imports
          // them. A named manual chunk made Vite preload ~127 KB gzip of PDF
          // code from index.html for every visitor, including users who never
          // open Course Finder / proposal generation.
          if (id.includes("/xlsx/")) return "vendor-excel";
          if (id.includes("/framer-motion/")) return "vendor-motion";
          if (id.includes("@dnd-kit/") || id.includes("@hello-pangea/dnd")) return "vendor-dnd";
          if (id.includes("/lucide-react/") || id.includes("/react-icons/")) return "vendor-icons";
          // NOTE: recharts/d3/victory-vendor are deliberately NOT manually
          // chunked. Splitting them into a separate vendor chunk created a
          // circular chunk (vendor-charts <-> vendor-react) whose ES-module
          // init order broke production at runtime ("Cannot access 'S' before
          // initialization" -> blank screen on every page). They stay in the
          // lazy dashboard route chunks, which loads them on demand anyway.
          if (id.includes("/wouter/")) return "vendor-router";
          return undefined;
        },
      },
    },
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
