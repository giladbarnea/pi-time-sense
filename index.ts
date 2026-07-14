/**
 * pi-time-sense: give the agent a live sense of time during long autonomous runs.
 *
 * Injection is triggered by activity, never by wall time (no alarm): the
 * configured interval only throttles cadence. Three hooks, each chosen because
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TimeSenseConfiguration {
  intervalMinutes: number;
  slashTimeSenseSettings: boolean;
}

const DEFAULT_CONFIGURATION: TimeSenseConfiguration = {
  intervalMinutes: 15,
  slashTimeSenseSettings: true,
};
const MILLISECONDS_PER_MINUTE = 60 * 1000;
const CONFIGURATION_PATH = join(getAgentDir(), "pi-time-sense.json");

/**
 * @example parseIntervalMinutes(5) // 5
 */
function parseIntervalMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Interval must be a number greater than 0");
  }
  return value;
}

function parseConfiguration(value: unknown): TimeSenseConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${CONFIGURATION_PATH} must contain a JSON object`);
  }

  const configuration = value as Record<string, unknown>;
  const intervalMinutes = configuration.intervalMinutes ?? DEFAULT_CONFIGURATION.intervalMinutes;
  const slashTimeSenseSettings =
    configuration.slashTimeSenseSettings ?? DEFAULT_CONFIGURATION.slashTimeSenseSettings;

  if (typeof slashTimeSenseSettings !== "boolean") {
    throw new Error("slashTimeSenseSettings must be true or false");
  }

  return {
    intervalMinutes: parseIntervalMinutes(intervalMinutes),
    slashTimeSenseSettings,
  };
}

function loadConfiguration(): TimeSenseConfiguration {
  if (!existsSync(CONFIGURATION_PATH)) return { ...DEFAULT_CONFIGURATION };
  return parseConfiguration(JSON.parse(readFileSync(CONFIGURATION_PATH, "utf8")) as unknown);
}

function saveConfiguration(configuration: TimeSenseConfiguration): void {
  writeFileSync(CONFIGURATION_PATH, `${JSON.stringify(configuration, null, 2)}\n`, "utf8");
}

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
  let configuration = loadConfiguration();
  let sessionStartMilliseconds = Date.now();
  let lastInjectionMilliseconds = 0; // 0 → first activity injects immediately

  pi.on("session_start", () => {
    sessionStartMilliseconds = Date.now();
    lastInjectionMilliseconds = 0;
  });

  /** One fresh time marker per throttle window; undefined while within it. */
  function staleTimeText(): string | undefined {
    const nowMilliseconds = Date.now();
    if (nowMilliseconds - lastInjectionMilliseconds < configuration.intervalMinutes * MILLISECONDS_PER_MINUTE) {
      return undefined;
    }
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

  if (!configuration.slashTimeSenseSettings) return;

  pi.registerCommand("time-sense", {
    description: "Configure pi-time-sense",
    handler: async (_args, ctx) => {
      const intervalChoice = `Injection interval · ${configuration.intervalMinutes} minutes`;
      const slashSettingsChoice = "/time-sense settings · enabled";
      const choice = await ctx.ui.select("pi-time-sense", [intervalChoice, slashSettingsChoice]);
      if (choice === undefined) return;

      if (choice === intervalChoice) {
        const input = await ctx.ui.input(
          "Injection interval",
          `Minutes (current: ${configuration.intervalMinutes})`,
        );
        if (input === undefined) return;

        try {
          const intervalMinutes = parseIntervalMinutes(Number(input));
          configuration = { ...configuration, intervalMinutes };
          saveConfiguration(configuration);
          ctx.ui.notify(`Time injection interval: ${intervalMinutes} minutes`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Disable /time-sense?",
        'The command will disappear after reload. You can always re-enable it by setting "slashTimeSenseSettings": true in ~/.pi/agent/pi-time-sense.json.',
      );
      if (!confirmed) return;

      configuration = { ...configuration, slashTimeSenseSettings: false };
      saveConfiguration(configuration);
      ctx.ui.notify("Disabled /time-sense settings", "info");
      await ctx.reload();
    },
  });
}
