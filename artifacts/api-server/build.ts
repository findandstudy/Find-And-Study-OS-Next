import path from "path";
import { fileURLToPath } from "url";
import { build as esbuild } from "esbuild";
import { rm, readFile, copyFile, mkdir } from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times without risking some
// packages that are not bundle compatible
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  const distDir = path.resolve(__dirname, "dist");
  await rm(distDir, { recursive: true, force: true });

  console.log("building server...");
  const pkgPath = path.resolve(__dirname, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter(
    (dep) =>
      !allowlist.includes(dep) &&
      !(pkg.dependencies?.[dep]?.startsWith("workspace:")),
  );

  await esbuild({
    entryPoints: [path.resolve(__dirname, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: path.resolve(distDir, "index.cjs"),
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  const seedSrc = path.resolve(__dirname, "src/seed.sql");
  const seedDest = path.resolve(distDir, "seed.sql");
  try {
    await copyFile(seedSrc, seedDest);
    console.log("copied seed.sql to dist/");
  } catch { }

  // Copy bundled fonts (used by contract PDF generator) so the production
  // build can find them next to index.cjs the same way dev (tsx) finds them
  // next to src/lib/contractPdf.ts.
  const fontsSrcDir = path.resolve(__dirname, "src/assets/fonts");
  const fontsDestDir = path.resolve(distDir, "assets/fonts");
  try {
    await mkdir(fontsDestDir, { recursive: true });
    for (const f of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]) {
      await copyFile(path.join(fontsSrcDir, f), path.join(fontsDestDir, f));
    }
    console.log("copied DejaVu fonts to dist/assets/fonts/");
  } catch (err) {
    console.warn("font copy failed:", err);
  }
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
