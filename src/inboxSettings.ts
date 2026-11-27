import { DEFAULT_INBOX_CHECKPOINT_BATCH_PATHS } from "../src-core/engine";

export type InboxSettings = {
  inboxCheckpointBatchPaths: number;
  inboxDefaultsVersion: number;
};

/** Migrate the old default once; later user choices, including 50, are kept. */
export function migrateInboxSettings(saved: Partial<InboxSettings> | null): InboxSettings {
  const version = saved?.inboxDefaultsVersion ?? 0;
  const paths = saved?.inboxCheckpointBatchPaths;
  return {
    inboxCheckpointBatchPaths: paths === undefined || (version < 1 && paths === 50)
      ? DEFAULT_INBOX_CHECKPOINT_BATCH_PATHS
      : paths,
    inboxDefaultsVersion: Math.max(1, version),
  };
}
