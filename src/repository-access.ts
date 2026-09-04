// One live relay operation owns repository authority across awaits. Async
// context carries the owner token; the active lease grants admission. This
// is neither a durable lock nor authority to collect retained Git objects.
import { AsyncLocalStorage } from "node:async_hooks";

type Kind = "git" | "control" | "alarm" | "event" | "teardown";
type Lease = { kind: Kind; holders: number };

export class RepositoryAccess {
  private readonly context = new AsyncLocalStorage<Lease>();
  private active?: Lease;

  get busy() { return this.active !== undefined; }
  get owned() { return this.active !== undefined && this.context.getStore() === this.active; }
  get blocked() { return this.busy && !this.owned; }
  get kind() { return this.active?.kind; }

  async run<T>(kind: Kind, work: () => Promise<T> | T, refused: () => Promise<T> | T): Promise<T> {
    if (this.blocked) return refused();
    const lease = this.active ??= { kind, holders: 0 };
    lease.holders++;
    try { return await this.context.run(lease, work); }
    finally { this.release(lease); }
  }

  sync<T>(kind: Kind, work: () => T, refused: () => T): T {
    if (this.blocked) return refused();
    const lease = this.active ??= { kind, holders: 0 };
    lease.holders++;
    try { return this.context.run(lease, work); }
    finally { this.release(lease); }
  }

  private release(lease: Lease) {
    if (--lease.holders === 0 && this.active === lease) this.active = undefined;
  }
}
