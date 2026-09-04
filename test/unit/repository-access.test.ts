import { describe, expect, it } from "vitest";
import { RepositoryAccess } from "../../src/repository-access.ts";

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const refused = () => "refused";

describe("Repository admission", () => {
  it("keeps unrelated operations out across awaits and permits owned nested work", async () => {
    const access = new RepositoryAccess();
    const entered = latch();
    const finish = latch();
    const active = access.run("git", async () => {
      expect(access.owned).toBe(true);
      expect(access.sync("event", () => "nested", refused)).toBe("nested");
      entered.release();
      await finish.promise;
      expect(await access.run("control", () => "nested async", refused)).toBe("nested async");
      expect(access.kind).toBe("git");
      return "done";
    }, refused);
    await entered.promise;
    expect(access.blocked).toBe(true);
    expect(access.sync("event", () => "unexpected", refused)).toBe("refused");
    expect(await access.run("alarm", () => "unexpected", refused)).toBe("refused");
    finish.release();
    expect(await active).toBe("done");
    expect(access.busy).toBe(false);
  });

  it("releases synchronous and asynchronous owners after failures", async () => {
    const access = new RepositoryAccess();
    expect(() => access.sync("event", () => { throw new Error("sync"); }, refused)).toThrow("sync");
    expect(access.busy).toBe(false);
    await expect(access.run("git", async () => { throw new Error("async"); }, refused)).rejects.toThrow("async");
    expect(access.busy).toBe(false);
  });

  it("retains an entered child until it settles even when the parent returns", async () => {
    const access = new RepositoryAccess();
    const finish = latch();
    let child!: Promise<string>;
    await access.run("control", () => {
      child = access.run("event", async () => { await finish.promise; return "child"; }, refused);
      return "parent";
    }, refused);
    expect(access.blocked).toBe(true);
    finish.release();
    expect(await child).toBe("child");
    expect(access.busy).toBe(false);
  });

  it("never lets a stale async context borrow a different active owner", async () => {
    const access = new RepositoryAccess();
    const resume = latch();
    let stale!: Promise<string>;
    await access.run("control", () => {
      stale = resume.promise.then(() => access.run("event", () => "unexpected", refused));
      return "original";
    }, refused);
    const finish = latch();
    const active = access.run("git", async () => { await finish.promise; return "current"; }, refused);
    resume.release();
    expect(await stale).toBe("refused");
    finish.release();
    await active;
    expect(access.busy).toBe(false);
  });
});
