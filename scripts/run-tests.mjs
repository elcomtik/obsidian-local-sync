import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testsRoot = path.join(repoRoot, "tests");
const outRoot = path.join(repoRoot, ".tmp", `tests-${Date.now()}`);

try {
  await mkdir(outRoot, { recursive: true });
  const testFiles = await findTestFiles(testsRoot);
  if (testFiles.length === 0) {
    throw new Error(`No test files found in ${testsRoot}`);
  }

  const outFiles = [];
  for (const testFile of testFiles) {
    const relative = path.relative(testsRoot, testFile).replace(/\.ts$/, ".mjs");
    const outfile = path.join(outRoot, relative);
    await mkdir(path.dirname(outfile), { recursive: true });
    await build({
      entryPoints: [testFile],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      sourcemap: "inline",
      packages: "external",
      logLevel: "silent",
    });
    outFiles.push(outfile);
  }

  await runNodeTest(outFiles);
} finally {
  await rm(outRoot, { recursive: true, force: true });
}

async function findTestFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function runNodeTest(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...files], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`node --test failed: code=${code} signal=${signal}`));
      }
    });
  });
}
