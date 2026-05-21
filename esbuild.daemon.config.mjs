import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
const outdir = "dist-daemon";

fs.mkdirSync(outdir, { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ["src-daemon/main.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: path.join(outdir, "main.js"),
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});

if (watch) {
  await ctx.watch();
  console.log("Watching... daemon build output in dist-daemon/");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Built daemon to dist-daemon/");
}
