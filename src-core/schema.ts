
import * as Evolu from "@evolu/common";

export const FileUpdateId = Evolu.id("FileUpdate");
export const FileSnapshotId = Evolu.id("FileSnapshot");
export const SettingUpdateId = Evolu.id("SettingUpdate");
export const SettingSnapshotId = Evolu.id("SettingSnapshot");
export const FileMaterializationId = Evolu.id("FileMaterialization");
export const SettingMaterializationId = Evolu.id("SettingMaterialization");
export const ProcessedFileUpdateId = Evolu.id("ProcessedFileUpdate");
export const ProcessedSettingUpdateId = Evolu.id("ProcessedSettingUpdate");
export const InboxStateId = Evolu.id("InboxState");

export const Schema = {
  // -------- synced --------
  fileUpdate: {
    id: FileUpdateId,
    path: Evolu.NonEmptyString1000,
    updateBase64: Evolu.NonEmptyString,
    originDeviceId: Evolu.nullOr(Evolu.NonEmptyString1000),
    // null = content update (default); "delete" = file was deleted
    type: Evolu.nullOr(Evolu.NonEmptyString1000)
  },

  settingUpdate: {
    id: SettingUpdateId,
    path: Evolu.NonEmptyString1000,
    contentBase64: Evolu.String,
    contentHash: Evolu.NonEmptyString1000,
    originDeviceId: Evolu.nullOr(Evolu.NonEmptyString1000),
    // null/raw = UTF-8 text base64; "gzip" = gzip-compressed UTF-8 text base64
    encoding: Evolu.nullOr(Evolu.NonEmptyString1000),
    // null = content update (default); "delete" = setting file was deleted
    type: Evolu.nullOr(Evolu.NonEmptyString1000)
  },

  // -------- local only --------
  _fileSnapshot: {
    id: FileSnapshotId,
    path: Evolu.NonEmptyString1000,
    snapshotBase64: Evolu.NonEmptyString,
    contentHash: Evolu.nullOr(Evolu.NonEmptyString1000)
  },

  _settingSnapshot: {
    id: SettingSnapshotId,
    path: Evolu.NonEmptyString1000,
    contentHash: Evolu.NonEmptyString1000
  },

  _fileMaterialization: {
    id: FileMaterializationId,
    path: Evolu.NonEmptyString1000,
    signature: Evolu.NonEmptyString
  },

  _settingMaterialization: {
    id: SettingMaterializationId,
    path: Evolu.NonEmptyString1000,
    signature: Evolu.NonEmptyString
  },

  _processedFileUpdate: {
    id: ProcessedFileUpdateId,
    sourceId: Evolu.NonEmptyString1000,
    sourceVersion: Evolu.NonEmptyString1000
  },

  _processedSettingUpdate: {
    id: ProcessedSettingUpdateId,
    sourceId: Evolu.NonEmptyString1000,
    sourceVersion: Evolu.NonEmptyString1000
  },

  _inboxState: {
    id: InboxStateId,
    version: Evolu.NonEmptyString1000
  }
} as const;

export type Database = typeof Schema;
