import { promises as fs } from "node:fs";
import path from "node:path";
import type { VaultAdapter, VaultFile, VaultFolderListing } from "../src-core/vaultAdapter";
import { getExtension } from "../src-core/pathPolicy";

export class NodeFsVaultAdapter implements VaultAdapter {
  private root: string;
  private shouldDescendDirectory: (vaultPath: string) => boolean;

  constructor(root: string, shouldDescendDirectory: (vaultPath: string) => boolean = () => true) {
    this.root = path.resolve(root);
    this.shouldDescendDirectory = shouldDescendDirectory;
  }

  async listFiles(): Promise<VaultFile[]> {
    const files: VaultFile[] = [];

    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const vaultPath = this.toVaultPath(absolutePath);
          if (!this.shouldDescendDirectory(vaultPath)) continue;
          await walk(absolutePath);
          continue;
        }

        if (!entry.isFile()) continue;
        const vaultPath = this.toVaultPath(absolutePath);
        files.push({ path: vaultPath, extension: getExtension(vaultPath) });
      }
    };

    await walk(this.root);
    return files;
  }

  async listFolder(vaultPath: string): Promise<VaultFolderListing | null> {
    try {
      const entries = await fs.readdir(this.resolveVaultPath(vaultPath), { withFileTypes: true });
      return {
        files: entries
          .filter((entry) => entry.isFile())
          .map((entry) => `${vaultPath.replace(/\/$/, "")}/${entry.name}`),
        folders: entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${vaultPath.replace(/\/$/, "")}/${entry.name}`),
      };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async readText(vaultPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolveVaultPath(vaultPath), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async writeText(vaultPath: string, content: string): Promise<void> {
    const absolutePath = this.resolveVaultPath(vaultPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }

  async deleteFile(vaultPath: string): Promise<void> {
    await fs.rm(this.resolveVaultPath(vaultPath), { force: true });
  }

  async fileExists(vaultPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.resolveVaultPath(vaultPath));
      return stat.isFile();
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  async ensureFolder(vaultPath: string): Promise<void> {
    await fs.mkdir(this.resolveVaultPath(vaultPath), { recursive: true });
  }

  toVaultPath(absolutePath: string): string {
    const relativePath = path.relative(this.root, path.resolve(absolutePath));
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Path is outside vault root: ${absolutePath}`);
    }
    return relativePath.split(path.sep).join("/");
  }

  resolveVaultPath(vaultPath: string): string {
    const normalized = vaultPath.split("/").join(path.sep);
    const absolutePath = path.resolve(this.root, normalized);
    const relativePath = path.relative(this.root, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Path is outside vault root: ${vaultPath}`);
    }
    return absolutePath;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
