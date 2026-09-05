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

  // A streamed Git response still reads repository state after fetch returns.
  // Carry authority into each pull, and release it on EOF, error or disconnect.
  async response(kind: Kind, work: () => Promise<Response>, refused: () => Response): Promise<Response> {
    if (this.blocked) return refused();
    const lease = this.active ??= { kind, holders: 0 };
    lease.holders++;
    let released = false;
    const finish = () => {
      if (!released) { released = true; this.release(lease); }
    };
    try {
      const response = await this.context.run(lease, work);
      if (!response.body) { finish(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        pull: controller => this.context.run(lease, async () => {
          try {
            const result = await reader.read();
            if (result.done) { reader.releaseLock(); controller.close(); finish(); }
            else controller.enqueue(result.value);
          } catch (error) {
            try { await reader.cancel(error); } catch { /* Preserve the read error. */ }
            finally { reader.releaseLock(); controller.error(error); finish(); }
          }
        }),
        cancel: reason => this.context.run(lease, async () => {
          try { await reader.cancel(reason); } finally { reader.releaseLock(); finish(); }
        }),
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { finish(); throw error; }
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
