
import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import path from "node:path";

import { createEvoluClient } from "./evoluClient";
import {
  YjsEvoluHistoryEngine,
  type EngineConfig,
  type LogLevel,
} from "./engine";

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

  // Evolu types are complex; we keep "any" to avoid fighting TS in this example.
  evolu: any;
  engine!: YjsEvoluHistoryEngine;

  async onload() {
    await this.loadSettings();

    // ----------------------------
    // Settings UI
    // ----------------------------
    this.addSettingTab(new LocalSyncSettingTab(this.app, this));

    try {
      await this.startEngine();
    } catch (e) {
      console.error("[obsidian-local-sync] ERROR: Failed to start engine", e);
      new Notice("LocalSync: failed to start — check console for details");
    }
  }

  private async startEngine() {
    // ----------------------------
    // Create Evolu client
    // ----------------------------
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const dataDir = path.join(
      adapter.getBasePath(),
      this.app.vault.configDir,
      "plugins",
      this.manifest.id,
    );
    this.evolu = createEvoluClient(
      this.settings.appName,
      this.settings.relayUrl,
      dataDir,
    );

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
    try {
      const owner = await this.evolu.appOwner;
      if (this.settings.logLevel !== "off") {
        console.log("[obsidian-local-sync] INFO: Evolu owner loaded", {
          hasMnemonic: !!owner?.mnemonic,
        });
      }
    } catch (e) {
      console.error("[obsidian-local-sync] ERROR: Failed to load Evolu owner", e);
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
    this.engine?.stop();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async applyEngineConfigFromSettings() {
    await this.saveSettings();
    await this.engine.updateConfig(toEngineConfig(this.settings));
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
    // Performance
    // ----------------------------
    containerEl.createEl("h3", { text: "Performance" });

    new Setting(containerEl)
      .setName("History poll interval (ms)")
      .setDesc("How often to check for remote changes.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.historyPollMs))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 100) return;
            this.plugin.settings.historyPollMs = Math.floor(n);
            await this.plugin.applyEngineConfigFromSettings();
          }),
      );

    new Setting(containerEl)
      .setName("History batch size")
      .setDesc("Max history rows processed per poll.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.historyBatchSize))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 10) return;
            this.plugin.settings.historyBatchSize = Math.floor(n);
            await this.plugin.applyEngineConfigFromSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Outgoing batch interval (ms)")
      .setDesc("Minimum time between sending Yjs updates.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.outgoingBatchMs))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 50) return;
            this.plugin.settings.outgoingBatchMs = Math.floor(n);
            await this.plugin.applyEngineConfigFromSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max open Yjs docs (LRU)")
      .setDesc("How many files keep Yjs state in memory.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxOpenDocs))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 5) return;
            this.plugin.settings.maxOpenDocs = Math.floor(n);
            await this.plugin.applyEngineConfigFromSettings();
          }),
      );

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
            const owner = await this.plugin.evolu.appOwner;
            mnemonicInput.value = owner.mnemonic;
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
          const owner = await this.plugin.evolu.appOwner;
          await navigator.clipboard.writeText(owner.mnemonic);
          new Notice("Mnemonic copied to clipboard");
        });
      });

    // -- Restore --
    let restoreValue = "";

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
        btn
          .setButtonText("Restore")
          .setCta()
          .onClick(async () => {
            if (!restoreValue) {
              new Notice("Paste your mnemonic first");
              return;
            }
            await this.plugin.evolu.restoreAppOwner(restoreValue);
            console.log("[obsidian-local-sync] INFO: Evolu owner restored");
            new Notice("Owner restored. Please restart Obsidian.");
          });
      });

    // -- Reset --
    let resetPending = false;

    new Setting(containerEl)
      .setName("Reset owner (danger)")
      .setDesc("Permanently deletes the Evolu identity on this device.")
      .addButton((btn) => {
        btn
          .setWarning()
          .setButtonText("Reset")
          .onClick(async () => {
            if (!resetPending) {
              resetPending = true;
              btn.setButtonText("Confirm reset?");
              window.setTimeout(() => {
                if (resetPending) {
                  resetPending = false;
                  btn.setButtonText("Reset");
                }
              }, 5000);
            } else {
              resetPending = false;
              await this.plugin.evolu.resetAppOwner();
              console.warn("[obsidian-local-sync] WARN: Evolu owner reset");
              new Notice("Owner reset. Please restart Obsidian.");
            }
          });
      });
  }
}
