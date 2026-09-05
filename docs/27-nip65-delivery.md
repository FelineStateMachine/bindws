---
title: NIP-65 delivery
audience: owners and developers
---

## Automatic delivery

An owner may enable automatic NIP-65 delivery in the console or with
`setpolicy`. For each locally accepted public event, bind.ws reads the
author's current kind `10002` write relays and the read relays of people named
by `p` tags. It queues each relay independently and sends a normal Nostr
`EVENT` message.

Delivery is off by default and is bounded to eight targets per event (the
owner may choose one through sixteen). Private, protected, imported and
relay-generated events are not routed automatically. The relay keeps only a
small durable queue; each target has its own accepted, rejected or pending
status, retry count and last error. `deliverystatus` exposes that status to the
owner. A target that fails does not advance another target's progress.

The relay applies current bans, visibility and policy checks before delivery.
Delivery is best effort and costs fuel. Network work runs from the alarm after
event admission, so a slow destination cannot hold up publishing here.
