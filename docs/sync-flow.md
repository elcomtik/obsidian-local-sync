# LocalSync Startup and Sync Flow

This document describes the current materializer-based sync model and the UX
gap around remote updates during startup scans.

## Startup Flow

```mermaid
flowchart TD
  A[Plugin starts engine] --> B[Start Evolu materializer subscriptions]
  B --> C[Start quiet-cycle and rescan timers]
  C --> D{Startup scan enabled?}
  D -- no --> E[scanComplete = true]
  D -- yes --> F[Scan settings files]
  F --> G[List tracked vault files]
  G --> H[For each file]
  H --> I{Local snapshot exists?}
  I -- yes --> J[Open Yjs doc from snapshot]
  J --> K{Vault text drifted from snapshot?}
  K -- yes --> L[Apply catch-up diff as local change]
  K -- no --> M[Close or keep doc by LRU]
  L --> M
  I -- no --> N[Add path to pendingVaultSeed]
  M --> H
  N --> H
  H --> O[scanComplete = true]
  O --> P[Refresh file materialization plans]
  P --> Q[Run materializer for queued remote paths]
  Q --> R[Quiet cycle drains deferred seeds after materializers are quiet]
```

During `scanComplete = false`, file materialization refresh is intentionally
deferred. Evolu may receive remote rows locally, but vault writes wait until the
startup scan finishes.

## Normal Sync

```mermaid
flowchart LR
  subgraph Local edit path
    A[Vault modify event] --> B[Read vault text]
    B --> C[Diff against lastVaultText]
    C --> D[Apply diff to Yjs doc]
    D --> E[Yjs update event]
    E --> F[Debounced outgoing flush]
    F --> G[Upsert fileUpdate row]
    G --> H[Save local snapshot]
  end

  subgraph Remote materialization path
    I[Evolu subscription event] --> J[Debounced materialization refresh]
    J --> K[Load latest remote rows from evolu_history]
    K --> L[Build per-path materialization plan]
    L --> M{Vault equals local snapshot?}
    M -- yes --> N[Materialize remote Yjs state to vault]
    N --> O[Save local snapshot and signature]
    M -- no --> P[Skip and log local drift]
  end
```

## Current Startup Remote-Update Behavior

If a remote peer creates or edits a file while this peer is still scanning:

1. Evolu can replicate the row into the local database.
2. The subscription schedules a materialization refresh.
3. `refreshFileMaterializationPlans()` exits early while startup scan is not
   complete.
4. The remote change is materialized after the startup scan completes and the
   refresh is run again.

This is safe but poor UX for long scans: remote changes are invisible in the
vault until scan completion.

## Safe Future Direction

Receiving and materializing remote updates during startup can be safe only with
path-level scan state. The engine needs to know whether a path is already
classified by the scan before a remote write is allowed to touch the vault.

Candidate rules:

| Remote operation | Safe during startup? | Required condition |
|------------------|----------------------|--------------------|
| Create new path | Yes | Path is not in the startup scan's initial tracked file set. |
| Update existing path | Maybe | Path has already been scanned and vault still equals snapshot. |
| Delete existing path | Maybe | Path has already been scanned and vault still equals snapshot. |
| Update unscanned existing path | No | Could race with local drift catch-up. |
| Delete unscanned existing path | No | Could misclassify local-only state or offline edits. |

Implementation shape:

```mermaid
flowchart TD
  A[Startup scan starts] --> B[Capture initial tracked path set]
  B --> C[Mark every path unscanned]
  C --> D[Scan one path]
  D --> E[Mark path scanned]
  E --> D

  R[Remote materialization request] --> S{Startup scan active?}
  S -- no --> T[Run normal materializer]
  S -- yes --> U{Path safe by startup rules?}
  U -- yes --> T
  U -- no --> V[Keep queued until path scanned or full scan complete]
```

Without that path-level gate, the current full-scan gate is the safer behavior.
