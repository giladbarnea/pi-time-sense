# pi-time-sense

Long-running agents lose track of time. `pi-time-sense` quietly gives you Pi agent temporal awareness. 

- ✔︎ Cache-friendly
- ✔︎ Acts behind the scenes; non-disruptive
- ✔︎ Tactful: no more than once in a 15 minute window <!-- reads nicely but assumes understanding of something no yet explained: does what no more than once? "quietly gives temporal awareness" isn't answering this question well enough. Ideally: one verb at the beginning of sentence. `Tactful: {...} no more than once in a ...` -->

I wanted to give the agent the equivalent of habitually checking a handwatch.  <!-- awkward, polish here -->

## Install

```bash
pi install npm:@giladbarnea/pi-time-sense
```

There is nothing to configure.

## What it does

- It adds a small, hidden timestamp only in response to session activity.
- It never wakes an idle agent or starts a turn of its own.

```xml
<current-time>Mon 2026-07-13 07:05:13 GMT+3 (session +18m4s)</current-time>
```


## How it works

`pi-time-sense` uses/can use (potentially)? three (potential)? opportunities to (add the current time|join a timestamp to the agent's context):
- User just sent a message <!-- `User sends a message` tense? -->
- Tool call finished
- Run fully settled

### Once every 15 minutes?

If the agent does nothing, `pi-time-sense` does nothing.

`pi-time-sense` is **opportunistic**. It hitchhikes on ...  <!-- complete here -->

Technically:
- Each timestamp is persisted at the end of the transcript.
- The model sees it ("senses" it 🙂)
- Invisible in the UI

## Cache-friendly

Because `pi-time-sense` only appends, the existing prompt prefix remains cacheable. Cache works as usual.
