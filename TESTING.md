# Manual Testing Guide

This document covers the manual test cases for obsidian-local-sync.
All tests assume both devices have the same mnemonic (shared Evolu identity) and the latest plugin build deployed.

**Log level**: set to **Info** on both devices before each test so you can follow the console output.

---

## Setup notes

**Deploy build:**
```bash
npm run build
cp -r dist/ <vault>/.obsidian/plugins/obsidian-local-sync/
```

**Reload plugin** (without restarting Obsidian): Settings → Community plugins → disable then re-enable *Obsidian LocalSync*.

**Two-device setup**: two separate Obsidian vaults (can be two Obsidian windows on the same machine pointing to different vault folders, or two physical machines).

---

## Test A — Empty device receives files ✅

**What it tests:** Startup scan transmits files that were never synced to a fresh device.

**Steps:**
1. Device A: plugin enabled, vault has files, let it run until you see `Startup scan: done` in the console.
2. Device B: paste Device A's mnemonic → disable plugin → delete all vault files manually → re-enable plugin.
3. Wait ~5 seconds for relay sync and polling.

**Pass criteria:**
- Device A console: `Startup scan: retransmitted` for each file.
- Device B console: `Applied remote update` → `writeYjsToVault: creating file` for each file.
- Device B vault: all of Device A's files appear with correct content.

---

## Test B — Files created while plugin was paused sync on first startup ✅

**What it tests:** Startup scan correctly seeds and syncs vault files created without the plugin running.

**Steps:**
1. Both devices: same mnemonic configured, **disable plugin on both**.
2. Device A: create `notes-a.md` in the vault manually (file manager or text editor).
3. Device B: create `notes-b.md` in the vault manually.
4. Enable plugin on both devices.
5. Wait ~5 seconds.

**Pass criteria:**
- Device A console: `Startup scan: deferring new file seed {path: 'notes-a.md'}`, then after a quiet poll: `Startup scan: seeding new file {path: 'notes-a.md'}`, later `Applied remote update {path: 'notes-b.md'}`.
- Device B console: symmetric.
- Both vaults end up with both `notes-a.md` and `notes-b.md` with correct content.

---

## Test C — CRDT merge of conflicting content (expected behaviour, not a bug) ✅

**What it tests:** Two devices create the same file path independently with no shared Yjs history — verifies the CRDT merge result is deterministic and both devices converge.

**Steps:**
1. Both devices: **disable plugin**.
2. Both devices: create `shared.md` with different text:
   - Device A: `"Hello from A"`
   - Device B: `"Hello from B"`
3. Enable plugin on both.
4. Wait ~5 seconds.

**Pass criteria:**
- Both devices converge to the **same merged content** (e.g. `"Hello from AHello from B"` or interleaved — the exact order depends on Yjs's HLC timestamp ordering, which is deterministic).
- No crash, no data loss, no infinite loop.

> **Note:** This is the expected CRDT behaviour for diverged histories. The UI warning on the Restore button describes this risk. If convergence to a single merged value is observed on both devices, the test passes regardless of the merge ordering.
>
> **Observed:** Content appended in sequence (`"Hello from A"` + `"Hello from B"`). Yjs places the sequence with the lower HLC timestamp first — deterministic across both devices.

---

## Test D — Reset & restore does not duplicate content ✅

**What it tests:** Deferred vault seeding (`pendingVaultSeed`) prevents doubled content after reset & restore. After reset the local DB has no snapshots. Without the guard the scan would seed vault content into an empty Yjs doc and then when the relay delivers pre-reset history rows in the next poll, the same text is applied again on top.

**Steps:**
1. Device A: plugin running, at least one file synced (e.g. `notes.md` with text `"Hello World"`).
2. Device A: Settings → Reset owner → wait a moment → Settings → Restore **same mnemonic**.
3. Observe the console on Device A immediately after the engine restarts.
4. Wait ~5 seconds for relay re-sync and poll cycles.

**Pass criteria:**
- Console: `Startup scan: deferring new file seed` for each file (no immediate seeding).
- Console: `History poll fetched rows` — relay delivers history rows.
- After relay is quiet: `Startup scan: seeding deferred files` is **not** logged (relay covered all files), OR if logged, content is still correct.
- File content on Device A is **not duplicated** — `notes.md` contains `"Hello World"` exactly once.
- Files on Device B are unaffected.

**Fail indicator:** content appears twice in any file on Device A.

---

## Test E — Vault edited while plugin was paused syncs correctly ✅

**What it tests:** Drift detection in `getOrLoadFileState` catches vault edits made while the plugin was not running and transmits them.

**Steps:**
1. Device A: plugin enabled, `notes.md` synced (snapshot exists). Verify Device B has the original content.
2. Device A: **disable plugin**.
3. Device A: open `notes.md` in any text editor and add a paragraph. Save.
4. Device A: **re-enable plugin**.
5. Wait ~5 seconds.

**Pass criteria:**
- Device A console: `vault drifted from snapshot, applying catch-up diff {path: 'notes.md'}`.
- Device B receives the edit: `Applied remote update {path: 'notes.md'}`, vault file updated.
- Both devices have identical content including the paragraph added in step 3.

> **Failure observed (fixed in current build):** Drift was not detected because the `startup-retransmit` row written in session N had its history timestamp fall *after* the saved poll cursor. On session N+1, poll re-processed the stale retransmit row, opened the doc before the scan could run drift detection, and called `writeYjsToVault` which reverted the vault to the pre-pause content.
>
> **Fix:** `applyFileUpdateRowById` now skips any row whose ID matches `startup-retransmit:${path}:${deviceId}` — recognising the device's own startup-retransmit rows across sessions, not just within the current session. This lets the scan reach `getOrLoadFileState`, which then detects the drift and applies the catch-up diff correctly. Rebuild required before re-testing.

---

## Test F — Real-time sync (sanity check) ✅



**What it tests:** Normal online editing propagates to the other device without restart.

**Steps:**
1. Both devices: plugin enabled, same mnemonic, at least one shared file.
2. Device A: open a markdown file and type a sentence.
3. Wait `outgoingBatchMs` (default 500 ms) + `historyPollMs` (default 1000 ms) = ~2 seconds.

**Pass criteria:**
- Device A console: `Sent outgoing update`.
- Device B console: `Applied remote update` → vault file updated with the typed text.

---

## Test G — Restore / Reset mandatory blocking confirmation ✅

**What it tests:** Both Restore and Reset require a mandatory 5-second blocking wait before a confirmation click is accepted.

**Steps (Restore with non-empty vault):**
1. Device A: vault has at least one `.md` file, plugin enabled.
2. Open Settings → Obsidian LocalSync → Restore mnemonic → paste any mnemonic.
3. Click **Restore** once.
4. Immediately click **Restore** again (within 5 s).
5. Wait until button changes to `"Confirm restore?"` (after 5 s), then click.

**Pass criteria (first click):**
- Button text changes to `"Please wait 5s…"`.
- A 5-second Notice appears explaining the CRDT merge risk and instructing to confirm in 5 seconds.
- No restore is performed yet.

**Pass criteria (click during 5 s wait):**
- Click is ignored. No action occurs.

**Pass criteria (after 5 s — ready state):**
- Button text changes to `"Confirm restore?"`.
- A click now proceeds: engine restarts, `"Owner restored — engine restarted."` Notice appears.

**Pass criteria (auto-cancel):**
- If no confirm click happens within 10 s after the button becomes `"Confirm restore?"`, button reverts to `"Restore"` with no side effects.

**Steps (Reset):**
- Same flow as above but via the **Reset** button; button states are `"Please wait 5s…"` → `"Confirm reset?"` → executes or auto-reverts.

---

## Test H — Editing an LRU-evicted file does not corrupt content ✅

**What it tests:** When a file's Yjs doc is evicted from memory (LRU) and later re-opened on a vault modify event, the diff is computed against the correct `lastVaultText` (the snapshot state), not against an empty or stale baseline — preventing spurious deletes or duplicated content.

**Background:** The LRU eviction path calls `closeDoc` which saves a full snapshot to `_fileSnapshot` and destroys the `Y.Doc`. On the next vault `modify` event for that file `getOrLoadFileState` re-opens the doc by replaying the snapshot. If `lastVaultText` does not match `text.toString()` (the snapshot state) after reload, `applyBetterDiffToYText` would diff from the wrong baseline and could delete content that's already there.

**Setup:** Reduce `maxOpenDocs` to **5** (the minimum allowed). In practice 7 files are needed to reliably trigger eviction — the startup scan opens docs before you start editing, consuming some LRU slots.

**Steps:**
1. Device A: plugin running, 7 files in vault (e.g. `a.md` – `g.md`) each with a sentence of content. Let the plugin sync all of them (all appear in Device B's vault).
2. Device A: Settings → Max open Yjs docs → set to **5**.
3. Device A: open and type a word in `a.md`, `b.md`, `c.md`, `d.md`, `e.md`, `f.md` in sequence. (These fill and cycle the LRU; earlier files get evicted.)
4. Device A: open `g.md` and type a word at the **end** of the existing sentence. This forces `g.md` to be loaded from snapshot (evicted), and the modify event fires.
5. Wait ~2 seconds.

**Pass criteria:**
- Device A console: no `writeYjsToVault: no change` spam; one `Sent outgoing update` for `g.md`.
- Device B console: `Applied remote update {path: 'g.md'}` — content is the original sentence **plus** the word you typed, nothing deleted.
- Neither device shows garbled, deleted, or doubled content in any of the seven files.

**Fail indicator:** content in `g.md` is missing its original sentence (beginning deleted), or content is doubled.

> **Note:** Reset `maxOpenDocs` back to 50 after this test.

---

## Test I — File deletion is not propagated (known limitation, ARCH-4) ✅

**What it tests:** Verifies the current behaviour — deleting a file on one device does **not** remove it on the other device — and documents this as a known limitation pending ARCH-4 (rename/delete event handlers).

**Steps:**
1. Both devices: plugin enabled, same mnemonic, `deleteme.md` exists and is synced on both.
2. Device A: delete `deleteme.md` (move to trash or permanent delete).
3. Wait ~5 seconds.

**Pass criteria (current expected behaviour — not a pass for the feature):**
- Device B: `deleteme.md` still exists, unmodified. Deletion is **not** propagated.
- Device A: on next plugin restart, `deleteme.md` does **not** reappear (the file is tracked as deleted in the vault; no Yjs doc exists for it so no content is written back).
- No crash, no error in either console.

**Known limitation:** ARCH-4 — no `delete` or `rename` vault event handlers. Deletion propagation is on the roadmap.
