import { TFile, Vault } from "obsidian";
import type { VaultAdapter, VaultFile, VaultFolderListing } from "../src-core/vaultAdapter";

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly vault: Vault) {}

  async listFiles(): Promise<VaultFile[]> {
    return this.vault.getFiles().map((file) => ({
      path: file.path,
      extension: file.extension,
    }));
  }

  async listFolder(path: string): Promise<VaultFolderListing | null> {
    try {
      const exists = await this.vault.adapter.exists(path);
      if (!exists) return null;
      const listed = await this.vault.adapter.list(path);
      return { files: listed.files, folders: listed.folders };
    } catch {
      return null;
    }
  }

  async readText(path: string): Promise<string | null> {
    if (usesAdapterPath(path)) {
      try {
        if (!(await this.vault.adapter.exists(path))) return null;
        return await this.vault.adapter.read(path);
      } catch {
        return null;
      }
    }

    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    return this.vault.read(file);
  }

  async writeText(path: string, content: string): Promise<void> {
    if (usesAdapterPath(path)) {
      const slashIdx = path.lastIndexOf("/");
      if (slashIdx > 0) {
        await this.ensureFolder(path.substring(0, slashIdx));
      }
      await this.vault.adapter.write(path, content);
      return;
    }

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
    if (usesAdapterPath(path)) {
      if (await this.vault.adapter.exists(path)) {
        await this.vault.adapter.remove(path);
      }
      return;
    }

    const file = this.vault.getAbstractFileByPath(path);
    if (!file) return;
    await this.vault.trash(file, true);
  }

  async fileExists(path: string): Promise<boolean> {
    if (usesAdapterPath(path)) {
      return this.vault.adapter.exists(path);
    }
    return this.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  async ensureFolder(path: string): Promise<void> {
    if (usesAdapterPath(path)) {
      await ensureAdapterFolder(this.vault, path);
      return;
    }

    if (this.vault.getAbstractFileByPath(path)) return;
    try {
      await this.vault.createFolder(path);
    } catch (error) {
      if (isAlreadyExistsError(error) || this.vault.getAbstractFileByPath(path)) return;
      throw error;
    }
  }
}

function usesAdapterPath(path: string): boolean {
  return path.startsWith(".obsidian/");
}

async function ensureAdapterFolder(vault: Vault, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (await vault.adapter.exists(current)) continue;
    try {
      await vault.adapter.mkdir(current);
    } catch (error) {
      if (isAlreadyExistsError(error) || await vault.adapter.exists(current)) continue;
      throw error;
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return getErrorMessage(error).toLowerCase().includes("already exists");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}
