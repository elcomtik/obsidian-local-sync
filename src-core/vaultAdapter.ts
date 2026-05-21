export type VaultFile = {
  path: string;
  extension?: string;
};

export interface VaultAdapter {
  listFiles(): Promise<VaultFile[]>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
}

