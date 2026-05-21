import { TFile, Vault } from "obsidian";
import type { VaultAdapter, VaultFile } from "./vaultAdapter";

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly vault: Vault) {}

  async listFiles(): Promise<VaultFile[]> {
    return this.vault.getFiles().map((file) => ({
      path: file.path,
      extension: file.extension,
    }));
  }

  async readText(path: string): Promise<string | null> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    return this.vault.read(file);
  }

  async writeText(path: string, content: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
      return;
    }

    const slashIdx = path.lastIndexOf("/");
    if (slashIdx > 0) {
      await this.ensureFolder(path.substring(0, slashIdx));
    }

    await this.vault.create(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!file) return;
    await this.vault.trash(file, true);
  }

  async fileExists(path: string): Promise<boolean> {
    return this.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  async ensureFolder(path: string): Promise<void> {
    if (this.vault.getAbstractFileByPath(path)) return;
    await this.vault.createFolder(path);
  }
}

