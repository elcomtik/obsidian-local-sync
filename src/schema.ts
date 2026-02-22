
import * as Evolu from "@evolu/common";
import { TimestampBytes } from "@evolu/common/local-first";

export const FileUpdateId = Evolu.id("FileUpdate");
export const FileSnapshotId = Evolu.id("FileSnapshot");
export const HistoryCursorId = Evolu.id("HistoryCursor");

export const Schema = {
  // -------- synced --------
  fileUpdate: {
    id: FileUpdateId,
    path: Evolu.NonEmptyString1000,
    updateBase64: Evolu.NonEmptyString
  },

  // -------- local only --------
  _fileSnapshot: {
    id: FileSnapshotId,
    path: Evolu.NonEmptyString1000,
    snapshotBase64: Evolu.NonEmptyString
  },

  _historyCursor: {
    id: HistoryCursorId,
    lastTimestamp: Evolu.nullOr(TimestampBytes)
  }
} as const;

export type Database = typeof Schema;
