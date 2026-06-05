export type VaultFile = {
  path: string;
  extension?: string;
};

export type VaultFolderListing = {
  files: string[];
  folders: string[];
};

export interface VaultAdapter {
  listFiles(): Promise<VaultFile[]>;
  listFolder(path: string): Promise<VaultFolderListing | null>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
}
