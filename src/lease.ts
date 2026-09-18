import { mkdir } from "node:fs/promises";

const lockfile = require("proper-lockfile") as {
  lock(path: string, options: { stale: number; update: number; retries: number; onCompromised: (err: Error) => void }): Promise<() => Promise<void>>;
};

/** One host owns a workspace journal. Stale crash locks expire after 10 seconds. */
export class Lease {
  private lost = false;
  private released = false;
  private unlock!: () => Promise<void>;
  static async acquire(directory: string, compromised: () => void): Promise<Lease> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lease = new Lease();
    try {
      lease.unlock = await lockfile.lock(directory, {
        stale: 10_000, update: 5_000, retries: 0,
        onCompromised: () => { lease.lost = true; compromised(); },
      });
    } catch {
      throw new Error("Another tutor session owns these records. Close it first; after a crash, wait 10 seconds and reopen.");
    }
    return lease;
  }
  check = (): void => {
    if (this.lost || this.released) throw new Error("Recording lock lost. Reopen the tutor before continuing.");
  };
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.unlock().catch(() => undefined);
  }
}
