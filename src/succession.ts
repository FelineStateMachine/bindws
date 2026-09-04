// Succession: an heir and a dead-man's switch. The owner's presence is
// recorded on signed actions; silence past the delay starts a month of
// weekly warnings; silence through the month hands the relay to the heir.
// The bookkeeping lives in storage next to the policy; the warning in
// flight is mirrored here so NIP-11 can say so without a read.
import type { Relay } from "./relay.ts";
import { now } from "./event.ts";
import { SUCCESSION_WARN_DAYS } from "./settings.ts";
import { notify } from "./notify.ts";

export interface SuccessionWarn {
  since: number;
  lastNotified: number;
}
export interface SuccessionLog {
  at: number;
  from: string;
  to: string;
}

export class Succession {
  // A warning month in flight, or null.
  warn: SuccessionWarn | null = null;
  // When the presence write last happened (ms); at most hourly.
  seenWrite = 0;

  constructor(private relay: Relay) {}

  async load() {
    this.warn = (await this.relay.storage.get<SuccessionWarn>("succession_warn")) ?? null;
  }

  // seen records that the owner acted, at most once an hour, and calls
  // off a succession warning in flight. Anyone else is ignored.
  async seen(pubkey: string) {
    if (!this.relay.settings.isOwner(pubkey)) return;
    const ms = Date.now();
    if (ms - this.seenWrite < 3600_000) return;
    this.seenWrite = ms;
    await this.relay.storage.put("ownerSeenAt", now());
    if (this.warn) {
      this.warn = null;
      await this.relay.storage.delete("succession_warn");
    }
  }

  // seenNow starts the clock afresh: claim, transfer, naming an heir.
  async seenNow() {
    this.seenWrite = Date.now();
    await this.relay.storage.put("ownerSeenAt", now());
    this.warn = null;
    await this.relay.storage.delete("succession_warn");
  }

  async status() {
    const t = now();
    const seen = (await this.relay.storage.get<number>("ownerSeenAt")) ?? 0;
    const log = (await this.relay.storage.get<SuccessionLog[]>("succession_log")) ?? [];
    const sc = this.relay.settings.policy.succession;
    const from = seen || t;
    const handoverAt = !sc ? 0 : this.warn ? this.warn.since + SUCCESSION_WARN_DAYS * 86400 : from + (sc.afterDays + SUCCESSION_WARN_DAYS) * 86400;
    return { succession: sc, ownerSeenAt: seen, silentDays: seen ? Math.floor((t - seen) / 86400) : 0, warning: this.warn, handoverAt, log };
  }

  // tick runs from the daily alarm. Silence past the delay starts
  // a month of weekly warnings; silence through the month hands the relay
  // to the heir. Any owner action in between calls it off (seen).
  async tick(t: number) {
    const sc = this.relay.settings.policy.succession;
    const dropWarning = async () => {
      if (!this.warn) return;
      this.warn = null;
      await this.relay.storage.delete("succession_warn");
    };
    if (!sc || this.relay.settings.policy.owner === "" || this.relay.settings.isLeased()) return dropWarning();
    const subject = "succession on " + this.relay.slug;
    if (!this.relay.settings.member(sc.heir)) {
      // The heir left. Nobody to hand to; say so and stop.
      this.relay.settings.update({ succession: null });
      await dropWarning();
      await notify(this.relay, "succession", `Your heir ${sc.heir.slice(0, 8)} is no longer a member of ${this.relay.slug}, so the handover plan is off. Name another heir if you still want one.`, subject);
      return;
    }
    let seen = (await this.relay.storage.get<number>("ownerSeenAt")) ?? 0;
    if (seen === 0) {
      // Relays from before presence was recorded start the clock today.
      seen = t;
      await this.relay.storage.put("ownerSeenAt", t);
    }
    if (t - seen < sc.afterDays * 86400) return dropWarning();
    const day = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);
    if (!this.warn) {
      this.warn = { since: t, lastNotified: t };
      await this.relay.storage.put("succession_warn", this.warn);
      await notify(this.relay, "succession", `You have not signed in to ${this.relay.slug} for ${Math.floor((t - seen) / 86400)} days. Unless you do, it goes to your heir ${sc.heir.slice(0, 8)} on ${day(t + SUCCESSION_WARN_DAYS * 86400)}. Any signed action on the relay calls this off.`, subject);
      return;
    }
    if (t - this.warn.since < SUCCESSION_WARN_DAYS * 86400) {
      if (t - this.warn.lastNotified >= 7 * 86400) {
        this.warn = { ...this.warn, lastNotified: t };
        await this.relay.storage.put("succession_warn", this.warn);
        await notify(this.relay, "succession", `Still no sign of you on ${this.relay.slug}. It goes to ${sc.heir.slice(0, 8)} on ${day(this.warn.since + SUCCESSION_WARN_DAYS * 86400)} unless you sign in.`, subject);
      }
      return;
    }
    // The month is up: hand over.
    const old = this.relay.settings.policy.owner;
    const err = this.relay.settings.transferOwner(sc.heir);
    if (err) {
      this.relay.settings.update({ succession: null });
      await dropWarning();
      await notify(this.relay, "succession", `The handover of ${this.relay.slug} to ${sc.heir.slice(0, 8)} could not happen: ${err}. The plan is off.`, subject);
      return;
    }
    const log = [...((await this.relay.storage.get<SuccessionLog[]>("succession_log")) ?? []), { at: t, from: old, to: sc.heir }].slice(-10);
    await this.relay.storage.put("succession_log", log);
    await this.seenNow();
    await this.relay.publishMembership({ pubkey: sc.heir }, { pubkey: old });
    await notify(this.relay, "succession", `${this.relay.slug} now belongs to ${sc.heir.slice(0, 8)}, as you planned. You stay on as a moderator.`, subject, old);
    await notify(this.relay, "succession", `${this.relay.slug} is yours now. Its owner named you heir and has been away for ${sc.afterDays + SUCCESSION_WARN_DAYS} days. Open https://${this.relay.slug}.${this.relay.domain}/ and sign in.`, subject, sc.heir);
  }
}
