# pi-time-sense

Long-running agents lose track of time. `pi-time-sense` quietly keeps your Pi agent current with the local time and elapsed session duration.

It adds a small, hidden timestamp only in response to session activity, and no more than once every 15 minutes. There is no timer. It never wakes an idle agent or starts a turn of its own.

```xml
<current-time>Mon 2026-07-13 07:05:13 GMT+3 (session +18m4s)</current-time>
```

## Install

```bash
pi install npm:@giladbarnea/pi-time-sense
```

There is nothing to configure.

## How it works

A timestamp joins the agent's context when a prompt starts, after a tool finishes, or once a run fully settles. If the agent does nothing, `pi-time-sense` does nothing.

Each timestamp is persisted at the end of the transcript. The model sees it; the UI does not. Because `pi-time-sense` only appends, the existing prompt prefix remains cacheable.
