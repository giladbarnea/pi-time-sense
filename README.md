# pi-time-sense

Long-running agents lose track of time. `pi-time-sense` quietly gives your Pi agent temporal awareness.

- ✔︎ Cache-friendly
- ✔︎ Behind the scenes; non-disruptive
- ✔︎ Tactful: injects the current time at most once per 15-minute window

I wanted the equivalent of the agent glancing at a wristwatch.

## Install

```bash
pi install npm:@giladbarnea/pi-time-sense
```

There is nothing to configure.

## What it does

- Adds a small, hidden timestamp only in response to session activity
- Never wakes an idle agent or starts a turn of its own

```xml
<current-time>Mon 2026-07-13 07:05:13 GMT+3 (session +18m4s)</current-time>
```

## How it works

`pi-time-sense` looks for three opportunities to add the current time:

- You send a message
- A tool call finishes
- A run fully settles

### Why "at most" every 15 minutes?

`pi-time-sense` is **opportunistic**. The 15-minute interval sets its cadence, not an alarm.

It hitchhikes on activity already happening in the session. If the agent does nothing, `pi-time-sense` does nothing.

Technically, each timestamp is:

- Persisted at the end of the transcript
- Visible to the agent ("sensed" by it 🙂)
- Hidden from the UI

## Cache-friendly

Because `pi-time-sense` only appends, the existing prompt prefix remains cacheable. Cache works as usual.
