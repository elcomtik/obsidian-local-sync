import type { DataAdapter } from "obsidian";

// Android's encoder allocates one array entry per input byte. Keep individual
// calls below its internal 1 MiB chunks and release the vault IO queue often.
export const MOBILE_BINARY_CHUNK_BYTES = 256 * 1024;

type BinaryReplacementAdapter = Pick<DataAdapter,
  "writeBinary" | "stat" | "exists" | "remove" | "rename"
> & Partial<Pick<DataAdapter, "appendBinary">>;

/**
 * Writes an immutable snapshot to a unique temporary path before replacing the
 * target. On mobile, bounded adapter calls let other vault IO run between
 * chunks; the full snapshot remains required and no save is acknowledged early.
 */
export async function replaceAdapterBinaryFileFromBytes(
  adapter: BinaryReplacementAdapter,
  tempPath: string,
  targetPath: string,
  data: Uint8Array,
  { chunkBytes }: { chunkBytes?: number } = {},
): Promise<void> {
  if (tempPath === targetPath) throw new Error("Snapshot requires a separate temporary path");
  if (chunkBytes !== undefined && (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1)) {
    throw new Error("Binary chunk size must be a positive integer");
  }
  const size = chunkBytes !== undefined && typeof adapter.appendBinary === "function"
    ? chunkBytes
    : Math.max(1, data.byteLength);
  try {
    // Always create/truncate the temporary file, including for an empty image.
    for (let offset = 0; offset < Math.max(1, data.byteLength); offset += size) {
      const chunk = new Uint8Array(Math.min(size, data.byteLength - offset));
      chunk.set(data.subarray(offset, offset + chunk.byteLength));
      if (offset === 0) await adapter.writeBinary(tempPath, chunk.buffer);
      else await adapter.appendBinary!(tempPath, chunk.buffer);
    }
    const stat = await adapter.stat(tempPath);
    if (!stat || stat.type !== "file" || stat.size !== data.byteLength) {
      throw new Error("Incomplete binary snapshot; target was not replaced");
    }
    await replaceAdapterFileFromTemp(adapter, tempPath, targetPath);
  } catch (error) {
    try {
      if (await adapter.exists(tempPath)) await adapter.remove(tempPath);
    } catch {
      // A failed cleanup must not mask the failed persistence operation.
    }
    throw error;
  }
}

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

