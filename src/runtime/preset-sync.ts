import { statSync, watch, type FSWatcher } from "node:fs";
import type { PresetSyncOutcome } from "../omp/native-presets";
import { presetWatchState } from "./preset-watch-paths";

const presetSyncFallbackIntervalMs = 120_000;
const presetSyncDebounceMs = 150;
const presetSyncRetryBaseMs = 100;
const presetSyncRetryMaxMs = 1_600;
const presetSyncMaxRetries = 5;

export interface PresetRoleSyncAdapters {
  readonly syncPresetRoles?: (canWrite: () => boolean) => Promise<void | PresetSyncOutcome>;
  readonly presetRolePaths?: () => Promise<readonly string[]> | readonly string[];
}

export class PresetRoleSync {
  private presetSync?: Promise<void>;
  private stopped = false;
  private nextPresetSync = 0;
  private nextDeferredPresetSync?: number;
  private presetSyncDirty = false;
  private presetWatchFallback = false;
  private presetWatchDebounce?: NodeJS.Timeout;
  private presetSyncRetryTimer?: NodeJS.Timeout;
  private presetSyncRetryCount = 0;
  private presetWatchPaths: readonly string[] = [];
  private presetWatchSnapshot = "";
  private readonly presetWatchers: FSWatcher[] = [];
  private presetWatchFingerprint?: string;

  constructor(private readonly adapters: PresetRoleSyncAdapters, private readonly lifecycle: {
    readonly canWrite: () => boolean;
    readonly report: (error: unknown) => void;
  }) {}

  get pending(): Promise<void> | undefined { return this.presetSync; }
  get pendingWork(): boolean {
    return !!this.adapters.syncPresetRoles && (this.presetSyncDirty || this.presetSync !== undefined
      || this.presetWatchDebounce !== undefined || this.presetSyncRetryTimer !== undefined || this.nextDeferredPresetSync !== undefined);
  }

  initialize(preserveSelection: boolean, gate: {
    readonly canStart: () => boolean;
    readonly canWrite: () => boolean;
  }): Promise<void | PresetSyncOutcome> | undefined {
    if (preserveSelection) {
      this.nextPresetSync = Date.now() + presetSyncFallbackIntervalMs;
      return;
    }
    if (!this.adapters.syncPresetRoles || !gate.canStart()) return;
    this.nextPresetSync = Date.now() + presetSyncFallbackIntervalMs;
    return this.adapters.syncPresetRoles(gate.canWrite).catch(this.lifecycle.report);
  }

  async start(): Promise<void> {
    await this.startPresetWatcher();
    // Reconcile changes between the initial startup sync and watch registration.
    this.presetSyncDirty = true;
    this.observe();
    await this.presetSync;
  }

  tick(): void {
    if (this.presetWatchFingerprint !== undefined && !this.presetWatchDebounce
      && this.readPresetWatchFingerprint() !== this.presetWatchFingerprint) this.queuePresetWatchSync();
    this.observe();
  }

  stop(): void {
    this.stopped = true;
    this.stopPresetWatcher();
  }

  private clearPresetSyncRetry(): void {
    if (this.presetSyncRetryTimer) {
      clearTimeout(this.presetSyncRetryTimer);
      this.presetSyncRetryTimer = undefined;
    }
  }

  private readPresetWatchFingerprint(): string {
    // Bun registers Darwin FSEvents streams asynchronously without replay. Stat
    // the configured files (following links), not every directory in the watch tree.
    return this.presetWatchPaths.map(path => {
      try {
        const info = statSync(path, { bigint: true, throwIfNoEntry: false });
        return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : "missing";
      } catch (error) {
        if (error instanceof Error && "code" in error) return "unavailable";
        throw error;
      }
    }).join("\n");
  }

  private queuePresetWatchSync(): void {
    if (this.presetWatchDebounce) clearTimeout(this.presetWatchDebounce);
    this.presetWatchDebounce = setTimeout(() => {
      this.presetWatchDebounce = undefined;
      void (async () => {
        if (this.stopped) return;
        if (this.presetWatchFingerprint !== undefined) this.presetWatchFingerprint = this.readPresetWatchFingerprint();
        if (this.presetWatchPaths.length
          && presetWatchState(this.presetWatchPaths).snapshot !== this.presetWatchSnapshot) {
          await this.startPresetWatcher();
        }
        if (this.stopped) return;
        this.presetSyncRetryCount = 0;
        this.clearPresetSyncRetry();
        this.presetSyncDirty = true;
        this.observe();
      })().catch(this.lifecycle.report);
    }, presetSyncDebounceMs);
    this.presetWatchDebounce.unref?.();
  }

  private async startPresetWatcher(): Promise<void> {
    this.stopPresetWatcher(false);
    this.presetWatchFallback = false;
    if (!this.adapters.syncPresetRoles) return;
    if (!this.adapters.presetRolePaths) {
      this.presetWatchFallback = true;
      return;
    }
    let paths: readonly string[];
    try { paths = await this.adapters.presetRolePaths(); }
    catch (error) {
      this.presetWatchFallback = true;
      this.lifecycle.report(error);
      return;
    }
    if (this.stopped || !paths.length) {
      this.presetWatchFallback = true;
      return;
    }
    this.presetWatchPaths = paths;
    if (process.platform === "darwin") this.presetWatchFingerprint = this.readPresetWatchFingerprint();
    const state = presetWatchState(paths);
    this.presetWatchSnapshot = state.snapshot;
    let uncovered = state.uncovered;
    const directories = new Set([...state.direct.keys(), ...state.ancestors.keys()]);
    for (const directory of directories) {
      const directNames = state.direct.get(directory);
      const ancestorNames = state.ancestors.get(directory);
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (this.stopped) return;
          if (filename !== null) {
            const name = String(filename);
            if (!directNames?.has(name) && !ancestorNames?.has(name)) return;
          } else if (!directNames?.size && ancestorNames?.size
            && (!this.presetWatchPaths.length
              || presetWatchState(this.presetWatchPaths).snapshot === this.presetWatchSnapshot)) {
            return;
          }
          this.queuePresetWatchSync();
        });
        watcher.unref?.();
        watcher.on("error", error => {
          this.presetWatchFallback = true;
          const next = Date.now() + presetSyncFallbackIntervalMs;
          if (!this.nextPresetSync || next < this.nextPresetSync) this.nextPresetSync = next;
          this.lifecycle.report(error);
          watcher.close();
        });
        this.presetWatchers.push(watcher);
      } catch (error) {
        uncovered = true;
        this.lifecycle.report(error);
      }
    }
    if (uncovered || !this.presetWatchers.length) this.presetWatchFallback = true;
  }

  private stopPresetWatcher(clearRetry = true): void {
    if (clearRetry) this.clearPresetSyncRetry();
    this.presetWatchFingerprint = undefined;
    if (this.presetWatchDebounce) {
      clearTimeout(this.presetWatchDebounce);
      this.presetWatchDebounce = undefined;
    }
    while (this.presetWatchers.length) {
      try { this.presetWatchers.pop()?.close(); }
      catch {}
    }
  }

  observe(): void {
    const sync = this.adapters.syncPresetRoles;
    const canWrite = this.lifecycle.canWrite;
    if (!sync || this.presetSync || !canWrite()) return;
    const now = Date.now();
    const dueFallback = this.presetWatchFallback && now >= this.nextPresetSync;
    const dueDeferred = this.nextDeferredPresetSync !== undefined && now >= this.nextDeferredPresetSync;
    if (!this.presetSyncDirty && !dueFallback && !dueDeferred) return;
    this.presetSyncDirty = false;
    this.clearPresetSyncRetry();
    if (this.presetWatchFallback) this.nextPresetSync = now + presetSyncFallbackIntervalMs;
    if (this.nextDeferredPresetSync !== undefined) this.nextDeferredPresetSync = now + presetSyncFallbackIntervalMs;
    let retryable = false;
    this.presetSync = sync(canWrite)
      .then(outcome => {
        if (outcome === "deferred") {
          retryable = true;
          // Model availability can recover without changing any watched configuration.
          this.nextDeferredPresetSync = Date.now() + presetSyncFallbackIntervalMs;
        } else {
          this.presetSyncRetryCount = 0;
          this.nextDeferredPresetSync = undefined;
        }
      })
      .catch(error => {
        retryable = true;
        this.lifecycle.report(error);
      })
      .finally(() => {
        this.presetSync = undefined;
        if (this.stopped) return;
        if (this.presetSyncDirty) {
          this.observe();
        } else if (retryable && this.presetSyncRetryCount < presetSyncMaxRetries) {
          const delay = Math.min(presetSyncRetryBaseMs * 2 ** this.presetSyncRetryCount, presetSyncRetryMaxMs);
          this.presetSyncRetryCount++;
          this.presetSyncRetryTimer = setTimeout(() => {
            this.presetSyncRetryTimer = undefined;
            this.presetSyncDirty = true;
            this.observe();
          }, delay);
          this.presetSyncRetryTimer.unref?.();
        }
      });
  }
}
