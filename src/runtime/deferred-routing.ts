import type { DeferredRoutingPort, Inbound } from "../contracts";
import { DeliveryError } from "../messaging/delivery";

export interface RecoveryControl {
  readonly priority: "immediate" | "retry";
  readonly laneId?: string;
}

interface DrainActions {
  readonly stopped: () => boolean;
  readonly fenced: () => boolean;
  readonly recovery: (input: Inbound) => RecoveryControl | null;
  readonly admit: (id: string) => Promise<void>;
  readonly report: (error: unknown) => void;
  readonly background: (task: Promise<void>) => void;
}

export class DeferredRoutingDrain {
  private readonly pending = new Set<string>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly retry = new Map<string, { readonly at: number; readonly delay: number }>();

  constructor(private readonly queue: DeferredRoutingPort, private readonly actions: DrainActions) {}

  restore(): void {
    for (const conversation of this.queue.conversations()) this.pending.add(conversation);
    this.resume();
  }

  available(conversation: string): void {
    this.pending.add(conversation);
    this.drain(conversation);
  }

  retrying(conversation: string): boolean {
    return this.retry.has(conversation);
  }

  resume(): void {
    if (!this.pending.size || this.held()) return;
    for (const conversation of this.pending) this.drain(conversation);
  }

  async settled(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }

  private held(): boolean {
    return this.actions.stopped() || this.actions.fenced();
  }

  private next(conversation: string, head: string, failed: ReadonlySet<string>): string | null {
    const retry = this.retry.get(conversation);
    const headReady = (!retry || retry.at <= Date.now()) && !failed.has(head);
    const includeBare = !headReady && retry !== undefined;
    // A persisted exact stop can bypass a blocked history read so work from
    // another conversation cannot resume the target lane out of order.
    for (const input of this.queue.priority(conversation, includeBare)) {
      if (input.id === head && !headReady || failed.has(input.id)) continue;
      const control = this.actions.recovery(input);
      if (control?.priority === "immediate" || includeBare && control?.priority === "retry") return input.id;
    }
    return headReady ? head : null;
  }

  private drain(conversation: string): void {
    if (this.active.has(conversation) || this.held()) return;
    // The job starts after registration; removal and the final queue read
    // are synchronous so a new receipt cannot miss its drain.
    const job = Promise.resolve().then(async () => {
      const failed = new Set<string>();
      try {
        while (!this.held()) {
          const head = this.queue.head(conversation);
          if (head === null) {
            this.pending.delete(conversation);
            return;
          }
          const id = this.next(conversation, head, failed);
          if (id === null) return;
          try {
            await this.actions.admit(id);
          } catch (error) {
            if (this.actions.stopped()) return;
            this.actions.report(error);
            if (!(error instanceof DeliveryError && error.certainty === "rejected")) {
              failed.add(id);
              if (id === head) {
                // Keep the failed receipt first, with bounded retry backoff.
                const delay = Math.min((this.retry.get(conversation)?.delay ?? 125) * 2, 30_000);
                this.retry.set(conversation, { at: Date.now() + delay, delay });
              }
              continue;
            }
          }
          this.queue.remove(id);
          if (id === head) this.retry.delete(conversation);
        }
      } finally {
        this.active.delete(conversation);
      }
    });
    this.active.set(conversation, job);
    this.actions.background(job);
  }
}
