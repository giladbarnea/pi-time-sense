/**
 * pi-time-sense: give the agent a live sense of time during long autonomous runs.
 *
 * Injection is triggered by activity, never by wall time (no alarm): the
 * 15-minute interval only throttles cadence. Three hooks, each chosen because
 * delivery there can never cause an LLM turn of its own:
 *
 * - before_agent_start: the returned message is persisted and rides into the
 *   LLM call the user's prompt already scheduled.
 * - tool_execution_end: the loop still owes the model a call to deliver the
 *   tool result; the optionless sendMessage lands in the steering queue and is
 *   consumed by that call.
 * - agent_settled: the session is idle, so the same call silently appends to
 *   context; the agent reads it on whatever turn comes next.
 *
 * Why not turn_start (the previous design): a message steered during the
 * run's final text-only turn is left in the steering queue and drained as a
 * continuation — the agent gets a whole turn whose prompt is just the time
 * marker, and answers it ("No response requested.").
 *
 * Cache-safe by design: every path is a persisted append at the transcript
 * tail, so the prompt prefix stays byte-stable and fully cacheable. No
 * per-call injection, no system-prompt mutation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INJECTION_INTERVAL_MILLISECONDS = 15 * 60 * 1000;

const timeFormat = new Intl.DateTimeFormat("en-CA", {
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

/** e.g. "Fri 2026-07-10 14:32:05 GMT+3" */
function formatCurrentTime(now: Date): string {
  const part: Record<string, string> = {};
  for (const { type, value } of timeFormat.formatToParts(now)) part[type] = value;
  return `${part.weekday} ${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second} ${part.timeZoneName}`;
}

/** Compact elapsed duration, e.g. 8000 -> "8s", 3_720_000 -> "1h2m". */
function humanizeDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

export default function piTimeSense(pi: ExtensionAPI): void {
  let sessionStartMilliseconds = Date.now();
  let lastInjectionMilliseconds = 0; // 0 → first activity injects immediately

  pi.on("session_start", () => {
    sessionStartMilliseconds = Date.now();
    lastInjectionMilliseconds = 0;
  });

  /** One fresh time marker per throttle window; undefined while within it. */
  function staleTimeText(): string | undefined {
    const nowMilliseconds = Date.now();
    if (nowMilliseconds - lastInjectionMilliseconds < INJECTION_INTERVAL_MILLISECONDS) return undefined;
    lastInjectionMilliseconds = nowMilliseconds;
    return `<current-time>${formatCurrentTime(new Date(nowMilliseconds))} (session +${humanizeDuration(nowMilliseconds - sessionStartMilliseconds)})</current-time>`;
  }

  function sendCurrentTime(): void {
    const text = staleTimeText();
    if (text) pi.sendMessage({ customType: "pi-time-sense", content: text, display: false });
  }

  pi.on("before_agent_start", () => {
    const text = staleTimeText();
    return text ? { message: { customType: "pi-time-sense", content: text, display: false } } : undefined;
  });

  pi.on("tool_execution_end", sendCurrentTime);

  pi.on("agent_settled", sendCurrentTime);
}
