import type { DataAdapter } from "obsidian";

/**
 * Completes an atomic temp-file replacement across desktop and mobile
 * DataAdapter implementations.
 *
 * Some Android adapters perform the rename but still reject the bridge call.
 * In that case the missing temp plus present target proves the move completed;
 * removing the target as a fallback would destroy the newly written file.
 */
export async function replaceAdapterFileFromTemp(
  adapter: Pick<DataAdapter, "exists" | "remove" | "rename">,
  tempPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await adapter.rename(tempPath, targetPath);
    return;
  } catch (renameError) {
    const tempExists = await adapter.exists(tempPath);
    const targetExists = await adapter.exists(targetPath);

    if (!tempExists && targetExists) return;
    if (!tempExists) throw renameError;

    try {
      if (targetExists) await adapter.remove(targetPath);
      await adapter.rename(tempPath, targetPath);
    } catch (fallbackError) {
      throw fallbackError instanceof Error ? fallbackError : renameError;
    }
  }
}

