import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const daemonPath = path.join(repoRoot, "dist-daemon", "main.js");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "obsidian-local-sync-"));
const vaultRoot = path.join(tempRoot, "vault");
const dbPath = path.join(
  vaultRoot,
  ".obsidian",
  "plugins",
  "obsidian-local-sync",
  "obsidian-local-sync.db",
);

await mkdir(vaultRoot, { recursive: true });

const child = spawn(process.execPath, [daemonPath], {
  cwd: repoRoot,
  env: {
    ...process.env,
    VAULT_NAME: "smoke",
    VAULT_ROOT: vaultRoot,
    LOCALSYNC_DB_PATH: dbPath,
    DEVICE_ID: "smoke-daemon",
    LOCALSYNC_LOG_LEVEL: "info",
    LOCALSYNC_HISTORY_POLL_MS: "250",
    LOCALSYNC_OUTGOING_BATCH_MS: "100",
    LOCALSYNC_USE_POLLING: "true",
    LOCALSYNC_POLL_INTERVAL_MS: "100",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});

try {
  await waitForOutput("Watcher ready", 10_000);

  await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
  await writeFile(path.join(vaultRoot, ".obsidian", "workspace.md"), "ignored\n", "utf8");
  await mkdir(path.join(vaultRoot, ".git"), { recursive: true });
  await writeFile(path.join(vaultRoot, ".git", "ignored.md"), "ignored\n", "utf8");
  await sleep(500);
  assertNoOutput(".obsidian/workspace.md");
  assertNoOutput(".git/ignored.md");

  const notePath = path.join(vaultRoot, "note.md");
  await writeFile(notePath, "# Smoke\n\nInitial text\n", "utf8");
  await waitForOutput("Vault file changed", 10_000);

  await writeFile(notePath, "# Smoke\n\nUpdated text\n", "utf8");
  await waitForOutputCount("Vault file changed", 2, 10_000);

  await rm(notePath);
  await waitForOutput("Vault file deleted", 10_000);

  await shutdown();

  const db = await stat(dbPath);
  if (!db.isFile() || db.size === 0) {
    throw new Error(`Expected non-empty daemon database at ${dbPath}`);
  }

  console.log("[smoke] daemon smoke test passed");
} catch (error) {
  await shutdown("SIGKILL");
  console.error("[smoke] daemon smoke test failed");
  console.error(error);
  const dbContents = await readOptional(dbPath);
  console.error("[smoke] db exists:", dbContents !== null);
  process.exit(1);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function waitForOutput(pattern, timeoutMs) {
  return waitForOutputCount(pattern, 1, timeoutMs);
}

function waitForOutputCount(pattern, count, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} output occurrence(s): ${pattern}\n\n${output}`));
    }, timeoutMs);

    const interval = setInterval(() => {
      if (countOccurrences(output, pattern) < count) return;
      clearTimeout(timeout);
      clearInterval(interval);
      resolve();
    }, 50);

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      clearInterval(interval);
      reject(new Error(`Daemon exited before startup: code=${code} signal=${signal}\n\n${output}`));
    });
  });
}

function countOccurrences(text, pattern) {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(pattern, index);
    if (index === -1) return count;
    count++;
    index += pattern.length;
  }
}

function assertNoOutput(pattern) {
  if (output.includes(pattern)) {
    throw new Error(`Unexpected daemon output for ignored path: ${pattern}\n\n${output}`);
  }
}

function shutdown(signal = "SIGTERM") {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill(signal);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}
