
import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type ButtonComponent,
} from "obsidian";

import { createEvoluClient, generateMnemonic } from "./evoluClient";
import type { PlatformIO } from "./sqliteDriver";
import { Mnemonic } from "@evolu/common";
import type { Evolu } from "@evolu/common";
import type { Database } from "./schema";
import {
  YjsEvoluHistoryEngine,
  type EngineConfig,
  type LogLevel,
} from "./engine";

/**
 * Stop promise from the most recently unloaded plugin instance.
 *
 * Obsidian's plugin disable → enable cycle calls `onunload()` synchronously
 * and then immediately calls `onload()` on the new instance.  `engine.stop()`
 * is async (it awaits any in-flight poll + flushes open docs), so without this
 * guard the old instance can still be running its poll when the new instance
 * starts — both share the vault event bus, leading to phantom vault.modify
 * calls and spurious outgoing updates.
 *
 * `onload()` awaits this before starting the engine; `onunload()` chains onto it.
 */
let _previousInstanceStop: Promise<void> = Promise.resolve();

type PluginSettings = {
  relayUrl: string;
  appName: string;
  deviceId: string;

  historyPollMs: number;
  historyBatchSize: number;
  outgoingBatchMs: number;
  maxOpenDocs: number;

  logLevel: LogLevel;
};

const DEFAULT_SETTINGS: PluginSettings = {
  relayUrl: "wss://free.evoluhq.com",
  appName: "obsidian-local-sync",
  deviceId: `device-${Math.random().toString(16).slice(2)}`,

  historyPollMs: 1000,
  historyBatchSize: 500,
  outgoingBatchMs: 500,
  maxOpenDocs: 50,

  logLevel: "info",
};

function toEngineConfig(s: PluginSettings): EngineConfig {
  return {
    historyPollMs: s.historyPollMs,
    historyBatchSize: s.historyBatchSize,
    outgoingBatchMs: s.outgoingBatchMs,
    maxOpenDocs: s.maxOpenDocs,
  };
}

export default class ObsidianLocalSyncPlugin extends Plugin {
  settings!: PluginSettings;

  evolu!: Evolu<Database>;
  closeEvoluDb: (() => Promise<void>) | null = null;
  engine!: YjsEvoluHistoryEngine;
  mnemonicCache: Mnemonic | null = null;

  /**
   * Set to true the moment onunload() is called.  Checked at every async
   * resume point in onload/startEngine so a superseded instance bails out
   * before registering vault event handlers or starting the poll loop.
   */
  private _unloaded = false;

  async onload() {
    // Wait for any previous instance to fully stop before starting a new one.
    // Obsidian calls onunload() + onload() back-to-back; without this guard the
    // old engine's in-flight poll can still be running when the new engine starts,
    // causing phantom vault.modify events and spurious outgoing updates.
    await _previousInstanceStop;
    if (this._unloaded) return; // unloaded before we even began

    await this.loadSettings();
    if (this._unloaded) return; // unloaded during settings load

    // ----------------------------
    // Settings UI
    // ----------------------------
    this.addSettingTab(new LocalSyncSettingTab(this.app, this));

    // Defer engine start until the workspace layout is ready.
    //
    // During initial Obsidian startup, vault.getFiles() returns an empty or
    // incomplete list if called before the workspace finishes indexing files.
    // auditSnapshotsForOfflineDeletes() calls vault.getFiles() to build the
    // set of existing paths and treats any snapshot path absent from that set
    // as an offline delete.  If the vault isn't ready yet, every snapshotted
    // file is falsely treated as deleted — delete rows are emitted for all
    // files, and on the next restart the device processes its own delete rows
    // (outgoingIds cleared) and trashes its local files too.
    //
    // onLayoutReady fires synchronously if the workspace is already ready
    // (on plugin reload mid-session), or deferred until it is (initial boot).
    this.app.workspace.onLayoutReady(() => {
      if (this._unloaded) return;
      this.startEngine().catch((e) => {
        if (!this._unloaded) {
          console.error("[obsidian-local-sync] ERROR: Failed to start engine", e);
          new Notice("LocalSync: failed to start — check console for details");
        }
      });
    });
  }

  /**
   * Returns platform-independent file I/O for the plugin's SQLite database.
   *
   * Obsidian's `DataAdapter` API (`readBinary` / `writeBinary`) is available
   * on both desktop (FileSystemAdapter, backed by Node fs) and mobile
   * (MobileAdapter, backed by Capacitor).  Using it here removes all direct
   * `node:fs` / `node:path` imports from the plugin bundle, which allows the
   * plugin to load on Android and iOS where those Node globals do not exist.
   *
   * The DB file lives at `<vault>/<configDir>/plugins/<pluginId>/<appName>.db`
   * — the same directory Obsidian already created for the plugin.
   */
  private buildIO(appName: string): PlatformIO {
    const dbPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/${appName}.db`;
    return {
      readFile: async () => {
        try {
          // Check existence first: on Android, readBinary emits a native-level
          // "File does not exist" error to the console before the JS exception
          // propagates, causing noisy but harmless log spam on first startup.
          if (!(await this.app.vault.adapter.exists(dbPath))) return null;
          const buf = await this.app.vault.adapter.readBinary(dbPath);
          return new Uint8Array(buf);
        } catch {
          return null;
        }
      },
      writeFile: async (data: Uint8Array) => {
        await this.app.vault.adapter.writeBinary(dbPath, data.buffer as ArrayBuffer);
      },
    };
  }

  private async startEngine() {
    // ----------------------------
    // Create Evolu client
    // ----------------------------
    const { evolu, closeDb } = createEvoluClient(
      this.settings.appName,
      this.settings.relayUrl,
      this.buildIO(this.settings.appName),
    );
    this.evolu = evolu;
    this.closeEvoluDb = closeDb;

    if (this.settings.logLevel !== "off") {
      console.log("[obsidian-local-sync] INFO: Evolu client created", {
        appName: this.settings.appName,
        relayUrl: this.settings.relayUrl,
        deviceId: this.settings.deviceId,
      });
    }

    // ----------------------------
    // Log Evolu owner state
    // ----------------------------
    if (this.settings.logLevel !== "off") {
      const owner = await this.evolu.appOwner;
      console.log("[obsidian-local-sync] INFO: Evolu owner loaded", {
        hasMnemonic: !!owner?.mnemonic,
      });
    }

    // ----------------------------
    // Subscribe to Evolu errors
    // ----------------------------
    this.evolu.subscribeError(() => {
      const error = this.evolu.getError();
      if (error) {
        console.error("[obsidian-local-sync] ERROR: Evolu error:", error);
      }
    });

    // ----------------------------
    // Create Engine
    // ----------------------------
    this.engine = new YjsEvoluHistoryEngine({
      vault: this.app.vault,
      evolu: this.evolu,
      deviceId: this.settings.deviceId,
      config: toEngineConfig(this.settings),
      logLevel: this.settings.logLevel,
    });

    await this.engine.start();

    // Bail out if onunload() fired while the engine was starting.
    // Without this check a superseded instance would register vault event
    // handlers that outlive the instance, firing into a stopped engine.
    if (this._unloaded) {
      void this.engine.stop();
      return;
    }

    // ----------------------------
    // Listen to vault changes
    // ----------------------------
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (file instanceof TFile) {
          await this.engine.onVaultFileModified(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          void this.engine.onVaultFileDeleted(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          void this.engine.onVaultFileRenamed(file, oldPath);
        }
      }),
    );

    // ----------------------------
    // Active / inactive tracking
    // ----------------------------
    this.registerDomEvent(window, "focus", () => {
      void this.engine.setActive();
    });

    this.registerDomEvent(window, "blur", () => {
      this.engine.setInactive();
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void this.engine.setActive();
      } else {
        this.engine.setInactive();
      }
    });
  }

  onunload() {
    // Signal any still-running onload/startEngine to abort at its next
    // async resume point — prevents a superseded instance from registering
    // vault event handlers or starting the poll loop after being unloaded.
    this._unloaded = true;

    // Chain closeEvoluDb *after* stop resolves so the cursor write from any
    // in-progress poll is committed to the in-memory DB before we flush to disk.
    //
    // Append to the existing chain rather than overwriting it.  Under rapid
    // consecutive restarts, overwriting would allow instance N+2 to start
    // before instance N has finished stopping (because N+1's engine may not
    // have been created yet, making its stop a no-op that resolves immediately).
    // Chaining ensures every subsequent onload() awaits ALL prior stops.
    _previousInstanceStop = _previousInstanceStop.then(() =>
      (this.engine?.stop() ?? Promise.resolve()).then(() => this.closeEvoluDb?.()),
    );
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // Persist the generated deviceId on first install so it survives restarts.
    if (!saved?.deviceId) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async applyEngineConfigFromSettings() {
    await this.saveSettings();
    await this.engine.updateConfig(toEngineConfig(this.settings));
  }

  /**
   * Prepare for a reset/restore: stop the engine without flushing, then wait a
   * macrotask tick so all pending Evolu microtasks (processMutationQueue) drain
   * before the caller issues the reset/restore to the DB worker.
   *
   * Evolu's DB worker runs on the main thread (no real Worker). Calling
   * dbWorker.postMessage("reset") drops all tables synchronously. Any mutation
   * that was queued via queueMicrotask fires *after* the drop but in the same
   * macrotask, hitting the now-empty DB and producing a SqliteError. The
   * setTimeout(0) forces those microtasks to flush before the caller proceeds.
   */
  async prepareForOwnerChange() {
    await this.engine.stop(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Restart the engine after reset/restore.
   *
   * The old Evolu client's WebSocket relay connection was established with the
   * previous owner identity.  After restoreAppOwner the in-memory DB has the
   * new identity, but the relay session still uses the old write key — so sync
   * never authenticates and evolu_history stays empty.  We must flush the new
   * DB state to disk, then tear down and recreate the full Evolu client so the
   * new client opens a fresh relay connection with the restored identity.
   *
   * The vault event handlers were registered once in startEngine and all read
   * this.engine at call-time, so replacing the field is enough.
   */
  async restartEngine() {
    // Flush the new DB state (written by restoreAppOwner) to disk.
    await this.closeEvoluDb?.();
    this.closeEvoluDb = null;

    // Recreate the Evolu client: fresh DB connection + new relay WebSocket.
    const { evolu, closeDb } = createEvoluClient(
      this.settings.appName,
      this.settings.relayUrl,
      this.buildIO(this.settings.appName),
      { forceNew: true }, // new mnemonic → new relay WebSocket required
    );
    this.evolu = evolu;
    this.closeEvoluDb = closeDb;

    this.engine = new YjsEvoluHistoryEngine({
      vault: this.app.vault,
      evolu: this.evolu,
      deviceId: this.settings.deviceId,
      config: toEngineConfig(this.settings),
      logLevel: this.settings.logLevel,
    });
    await this.engine.start();
  }
}

class LocalSyncSettingTab extends PluginSettingTab {
  plugin: ObsidianLocalSyncPlugin;

  constructor(app: App, plugin: ObsidianLocalSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian LocalSync" });

    // ----------------------------
    // Logging
    // ----------------------------
    new Setting(containerEl)
      .setName("Log level")
      .setDesc("Controls console logging.")
      .addDropdown((dd) => {
        dd.addOption("off", "Off");
        dd.addOption("error", "Error");
        dd.addOption("warn", "Warn");
        dd.addOption("info", "Info");

        dd.setValue(this.plugin.settings.logLevel);

        dd.onChange(async (value) => {
          this.plugin.settings.logLevel = value as LogLevel;
          await this.plugin.saveSettings();
          this.plugin.engine.setLogLevel(this.plugin.settings.logLevel);
          new Notice(`Log level set to ${value}`);
        });
      });

    // ----------------------------
    // Sync
    // ----------------------------
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Relay URL")
      .setDesc("WebSocket relay endpoint. Changes take effect after reloading Obsidian.")
      .addText((text) =>
        text
          .setPlaceholder("wss://free.evoluhq.com")
          .setValue(this.plugin.settings.relayUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed.startsWith("wss://") && !trimmed.startsWith("ws://")) {
              new Notice("Relay URL must start with wss:// or ws://");
              return;
            }
            this.plugin.settings.relayUrl = trimmed;
            await this.plugin.saveSettings();
          }),
      );

    // ----------------------------
    // Performance
    // ----------------------------
    containerEl.createEl("h3", { text: "Performance" });

    new Setting(containerEl)
      .setName("History poll interval (ms)")
      .setDesc("How often to check for remote changes.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.historyPollMs));
        text.inputEl.addEventListener("change", async () => {
          const n = Number(text.inputEl.value);
          if (!Number.isFinite(n) || n < 100) {
            text.setValue(String(this.plugin.settings.historyPollMs));
            new Notice("Poll interval must be at least 100 ms");
            return;
          }
          this.plugin.settings.historyPollMs = Math.floor(n);
          await this.plugin.applyEngineConfigFromSettings();
          new Notice(`Poll interval set to ${this.plugin.settings.historyPollMs} ms`);
        });
      });

    new Setting(containerEl)
      .setName("History batch size")
      .setDesc("Max history rows processed per poll.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.historyBatchSize));
        text.inputEl.addEventListener("change", async () => {
          const n = Number(text.inputEl.value);
          if (!Number.isFinite(n) || n < 10) {
            text.setValue(String(this.plugin.settings.historyBatchSize));
            new Notice("Batch size must be at least 10");
            return;
          }
          this.plugin.settings.historyBatchSize = Math.floor(n);
          await this.plugin.applyEngineConfigFromSettings();
          new Notice(`Batch size set to ${this.plugin.settings.historyBatchSize}`);
        });
      });

    new Setting(containerEl)
      .setName("Outgoing batch interval (ms)")
      .setDesc("Minimum time between sending Yjs updates.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.outgoingBatchMs));
        text.inputEl.addEventListener("change", async () => {
          const n = Number(text.inputEl.value);
          if (!Number.isFinite(n) || n < 50) {
            text.setValue(String(this.plugin.settings.outgoingBatchMs));
            new Notice("Outgoing interval must be at least 50 ms");
            return;
          }
          this.plugin.settings.outgoingBatchMs = Math.floor(n);
          await this.plugin.applyEngineConfigFromSettings();
          new Notice(`Outgoing interval set to ${this.plugin.settings.outgoingBatchMs} ms`);
        });
      });

    new Setting(containerEl)
      .setName("Max open Yjs docs (LRU)")
      .setDesc("How many files keep Yjs state in memory.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.maxOpenDocs));
        text.inputEl.addEventListener("change", async () => {
          const n = Number(text.inputEl.value);
          if (!Number.isFinite(n) || n < 5) {
            text.setValue(String(this.plugin.settings.maxOpenDocs));
            new Notice("Max open docs must be at least 5");
            return;
          }
          this.plugin.settings.maxOpenDocs = Math.floor(n);
          await this.plugin.applyEngineConfigFromSettings();
          new Notice(`Max open docs set to ${this.plugin.settings.maxOpenDocs}`);
        });
      });

    // ----------------------------
    // Evolu Sync Key (Mnemonic)
    // ----------------------------
    containerEl.createEl("h3", { text: "Sync Key (Mnemonic)" });

    // -- Reveal / copy --
    const revealSetting = new Setting(containerEl)
      .setName("Your mnemonic")
      .setDesc("24-word key — copy this to each device you want to sync.");

    const mnemonicBox = containerEl.createDiv();
    mnemonicBox.style.display = "none";
    mnemonicBox.style.marginBottom = "1em";

    const mnemonicInput = mnemonicBox.createEl("input");
    mnemonicInput.type = "text";
    mnemonicInput.readOnly = true;
    mnemonicInput.style.cssText =
      "width:100%;font-family:var(--font-monospace);font-size:0.85em;box-sizing:border-box;";

    revealSetting
      .addButton((btn) => {
        btn.setButtonText("Reveal").onClick(async () => {
          if (mnemonicBox.style.display === "none") {
            const mnemonic =
              this.plugin.mnemonicCache ??
              (await this.plugin.evolu.appOwner)?.mnemonic ??
              "(no owner)";
            mnemonicInput.value = mnemonic;
            mnemonicBox.style.display = "";
            btn.setButtonText("Hide");
          } else {
            mnemonicInput.value = "";
            mnemonicBox.style.display = "none";
            btn.setButtonText("Reveal");
          }
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Copy").onClick(async () => {
          const mnemonic =
            this.plugin.mnemonicCache ??
            (await this.plugin.evolu.appOwner)?.mnemonic;
          if (!mnemonic) {
            new Notice("No owner found");
            return;
          }
          await navigator.clipboard.writeText(mnemonic);
          new Notice("Mnemonic copied to clipboard");
        });
      });

    // -- Restore --
    let restoreValue = "";
    let restorePending = false;
    let restoreReady = false;

    const resetRestoreState = () => {
      restorePending = false;
      restoreReady = false;
      btn_restore.setButtonText("Restore");
    };

    let btn_restore: ButtonComponent;

    new Setting(containerEl)
      .setName("Restore mnemonic")
      .setDesc("Paste your 24-word key to restore an existing identity on this device.")
      .addTextArea((ta) => {
        ta.setPlaceholder("word1 word2 word3 …");
        ta.inputEl.rows = 2;
        ta.onChange((v) => {
          restoreValue = v.trim();
        });
      })
      .addButton((btn) => {
        btn_restore = btn;
        btn
          .setButtonText("Restore")
          .setCta()
          .onClick(async () => {
            if (!restoreValue) {
              new Notice("Paste your mnemonic first");
              return;
            }
            // If already confirmed and ready — execute
            if (restoreReady) {
              restorePending = false;
              restoreReady = false;
              btn.setButtonText("Restore");
              await this.plugin.prepareForOwnerChange();
              const parsed = Mnemonic.orThrow(restoreValue);
              await this.plugin.evolu.restoreAppOwner(parsed, { reload: false });
              this.plugin.mnemonicCache = parsed;
              console.log("[obsidian-local-sync] INFO: Evolu owner restored");
              await this.plugin.restartEngine();
              new Notice("Owner restored — engine restarted.");
              this.display();
              return;
            }
            // If waiting period is in progress — ignore
            if (restorePending) return;

            // First click — start mandatory 5s wait
            const hasFiles = this.plugin.app.vault
              .getFiles()
              .some((f) => f.extension === "md" || f.extension === "txt");

            restorePending = true;
            restoreReady = false;
            btn.setButtonText("Please wait 5s…");
            new Notice(
              hasFiles
                ? "⚠️ Your vault has existing notes. Restoring into a non-empty vault will " +
                  "CRDT-merge local and synced content — files at the same path on both " +
                  "sides will have their text concatenated. " +
                  "Confirm restore in 5 seconds."
                : "⚠️ Restoring mnemonic — confirm in 5 seconds.",
              5000,
            );
            window.setTimeout(() => {
              if (restorePending) {
                restoreReady = true;
                btn.setButtonText("Confirm restore?");
                // Auto-cancel after 10s if not confirmed
                window.setTimeout(() => {
                  if (restorePending && restoreReady) resetRestoreState();
                }, 10000);
              }
            }, 5000);
          });
      });

    // -- Reset --
    let resetPending = false;
    let resetReady = false;

    const resetResetState = () => {
      resetPending = false;
      resetReady = false;
      btn_reset.setButtonText("Reset");
    };

    let btn_reset: ButtonComponent;

    new Setting(containerEl)
      .setName("Reset owner (danger)")
      .setDesc("Permanently deletes the Evolu identity on this device.")
      .addButton((btn) => {
        btn_reset = btn;
        btn
          .setWarning()
          .setButtonText("Reset")
          .onClick(async () => {
            // If already confirmed and ready — execute
            if (resetReady) {
              resetPending = false;
              resetReady = false;
              btn.setButtonText("Reset");
              await this.plugin.prepareForOwnerChange();
              // Use restoreAppOwner with a fresh mnemonic instead of resetAppOwner.
              // resetAppOwner only drops tables without calling initializeDb, so
              // internal tables (evolu_history etc.) are missing after reset.
              // restoreAppOwner drops + re-initialises the full DB schema.
              const newMnemonic = generateMnemonic();
              await this.plugin.evolu.restoreAppOwner(newMnemonic, { reload: false });
              this.plugin.mnemonicCache = newMnemonic;
              console.warn("[obsidian-local-sync] WARN: Evolu owner reset");
              await this.plugin.restartEngine();
              new Notice("Owner reset — engine restarted.");
              this.display();
              return;
            }
            // If waiting period is in progress — ignore
            if (resetPending) return;

            // First click — start mandatory 5s wait
            resetPending = true;
            resetReady = false;
            btn.setButtonText("Please wait 5s…");
            new Notice("⚠️ This will permanently delete the Evolu identity on this device. Confirm reset in 5 seconds.", 5000);
            window.setTimeout(() => {
              if (resetPending) {
                resetReady = true;
                btn.setButtonText("Confirm reset?");
                // Auto-cancel after 10s if not confirmed
                window.setTimeout(() => {
                  if (resetPending && resetReady) resetResetState();
                }, 10000);
              }
            }, 5000);
          });
      });
  }
}
