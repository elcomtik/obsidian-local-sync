
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
const outdir = "dist";

fs.mkdirSync(outdir, { recursive: true });
fs.copyFileSync("manifest.json", path.join(outdir, "manifest.json"));

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2020",
  outfile: path.join(outdir, "main.js"),
  external: ["obsidian", "electron"],
  sourcemap: true,
  banner: {
    js: 'var __yjsFlag = globalThis["__ $YJS$ __"]; delete globalThis["__ $YJS$ __"];',
  },
  footer: {
    js: 'if (__yjsFlag !== undefined) globalThis["__ $YJS$ __"] = __yjsFlag;',
  }
});

if (watch) {
  await ctx.watch();
  console.log("Watching... build output in dist/");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Built to dist/");
}
