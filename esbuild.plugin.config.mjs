
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
  // "browser" causes esbuild to resolve packages using their "browser" export
  // condition instead of "node".  The key beneficiary is msgpackr, which ships
  // two entry points: node-index.js (references process.env at module load time)
  // and index.js / browser variant (no Node globals).  With platform:"node"
  // esbuild picked the node entry, which crashed immediately on Android WebView
  // where `process` is undefined.  With platform:"browser" esbuild picks the
  // safe browser entry instead.
  //
  // Node built-ins that other packages reference (e.g. sql.js's conditional fs
  // require, Evolu's crypto) are kept as external — they are never called on
  // mobile because each is guarded by a Node.js environment check at runtime.
  platform: "browser",
  target: "es2020",
  outfile: path.join(outdir, "main.js"),
  external: [
    "obsidian",
    "electron",
    // Node built-ins used by bundled dependencies (sql.js, Evolu, msgpackr).
    // Marked external so esbuild does not try to bundle them; they are only
    // reached inside Node.js-only code paths that are never executed on mobile.
    "fs", "node:fs",
    "path", "node:path",
    "os", "url",
    "module",
    "node:crypto",
    "child_process",
  ],
  sourcemap: true,
  banner: {
    // 1. Belt-and-suspenders `process` polyfill for Android/iOS WebView.
    //    The root cause of the mobile crash was msgpackr resolving to its Node
    //    entry point (fixed by switching to platform:"browser" above).  This
    //    polyfill is kept for any remaining packages that reference `process`
    //    inside conditionally-executed Node paths (e.g. sql.js checks
    //    `globalThis.process?.versions?.node` before calling process.argv).
    //    On desktop (Electron) `process` is already a real Node global; the
    //    `typeof` guard ensures we never override it there.
    // 2. Preserve Obsidian's Yjs singleton flag so the plugin's bundled Yjs
    //    doesn't collide with the host app's Yjs instance.
    js: 'if(typeof process==="undefined"){globalThis.process={env:{},platform:"linux",version:"v22",nextTick:function(fn){setTimeout(fn,0);}};} var __yjsFlag = globalThis["__ $YJS$ __"]; delete globalThis["__ $YJS$ __"];',
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
