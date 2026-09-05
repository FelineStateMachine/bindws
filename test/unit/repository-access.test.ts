import { describe, expect, it } from "vitest";
import { RepositoryAccess } from "../../src/repository-access.ts";

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const refused = () => "refused";

describe("Repository admission", () => {
  it("keeps streamed reads fenced until EOF and restores authority during pulls", async () => {
    const access = new RepositoryAccess();
    let pulls = 0;
    const response = await access.response("git", async () => new Response(new ReadableStream({
      pull(controller) {
        expect(access.owned).toBe(true);
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("pack"));
        else controller.close();
      },
    }, { highWaterMark: 0 })), () => new Response("busy", { status: 429 }));
    expect(access.blocked).toBe(true);
    expect(access.sync("event", () => "unexpected", refused)).toBe("refused");
    expect(await response.text()).toBe("pack");
    expect(access.busy).toBe(false);
  });

  it("releases streaming authority after client cancellation and stream errors", async () => {
    const access = new RepositoryAccess();
    let canceled = false;
    const response = await access.response("git", async () => new Response(new ReadableStream({
      cancel() { expect(access.owned).toBe(true); canceled = true; },
    }, { highWaterMark: 0 })), () => new Response("busy"));
    await response.body!.cancel();
    expect(canceled).toBe(true);
    expect(access.busy).toBe(false);
    const broken = await access.response("git", async () => new Response(new ReadableStream({
      pull() { throw new Error("read failure"); },
    }, { highWaterMark: 0 })), () => new Response("busy"));
    await expect(broken.text()).rejects.toThrow("read failure");
    expect(access.busy).toBe(false);
  });

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

  it("admits provider fuel receipts during Git but fences them during other work", async () => {
    const access = new RepositoryAccess();
    const entered = latch();
    const finish = latch();
    const active = access.run<string>("git", async () => {
      entered.release();
      await finish.promise;
      return "done";
    }, refused);
    await entered.promise;
    expect(await access.runFuel(() => "credited", refused)).toBe("credited");
    finish.release();
    await active;

    const controlEntered = latch();
    const controlFinish = latch();
    const control = access.run<string>("control", async () => {
      controlEntered.release();
      await controlFinish.promise;
      return "done";
    }, refused);
    await controlEntered.promise;
    expect(await access.runFuel(() => "unexpected", refused)).toBe("refused");
    controlFinish.release();
    await control;
    await access.run<void>("control", async () => {
      expect(await access.runFuel(() => "nested", refused)).toBe("nested");
    }, () => undefined);
    expect(access.busy).toBe(false);
  });

  it("keeps the Git lease alive until a concurrent fuel receipt finishes", async () => {
    const access = new RepositoryAccess();
    const gitEntered = latch();
    const gitFinish = latch();
    const fuelEntered = latch();
    const fuelFinish = latch();
    const git = access.run<string>("git", async () => {
      gitEntered.release();
      await gitFinish.promise;
      return "done";
    }, refused);
    await gitEntered.promise;
    const fuel = access.runFuel(async () => {
      fuelEntered.release();
      await fuelFinish.promise;
      return "credited";
    }, refused);
    await fuelEntered.promise;
    gitFinish.release();
    await git;
    expect(access.busy).toBe(true);
    expect(await access.run("teardown", () => "unexpected", refused)).toBe("refused");
    fuelFinish.release();
    expect(await fuel).toBe("credited");
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
