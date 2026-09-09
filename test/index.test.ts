import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";

type EventHandler = (
  event: Record<string, unknown>,
  context: ExtensionContext,
) => unknown | Promise<unknown>;

type BeforeAgentStartResult = {
  message: {
    content: string;
  };
};

const CURRENT_TIME = new Date("2026-09-09T12:00:00.000Z");
let configurationDirectory: string;
let previousAgentDirectory: string | undefined;
let registerTimeSense: (pi: ExtensionAPI) => void;

beforeAll(async () => {
  previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  configurationDirectory = mkdtempSync(join(tmpdir(), "pi-time-sense-config-"));
  process.env.PI_CODING_AGENT_DIR = configurationDirectory;
  registerTimeSense = (await import("../index.ts")).default;
});

beforeEach(() => setSystemTime(CURRENT_TIME));

afterEach(() => setSystemTime());

afterAll(() => {
  rmSync(configurationDirectory, { recursive: true, force: true });
  if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
});

function sessionHeader(
  id: string,
  timestamp: string,
  parentSession?: string,
): SessionHeader {
  return {
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd: "/tmp/project",
    ...(parentSession ? { parentSession } : {}),
  };
}

function writeSessionHeader(path: string, header: SessionHeader): void {
  writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
}

function minutesBeforeCurrentTime(minutes: number): string {
  return new Date(CURRENT_TIME.getTime() - minutes * 60_000).toISOString();
}

function createHarness(currentHeader: SessionHeader) {
  const handlers = new Map<string, EventHandler>();
  const pi = {
    on(eventName: string, handler: EventHandler) {
      handlers.set(eventName, handler);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: {
      getHeader: () => currentHeader,
    },
  } as unknown as ExtensionContext;

  registerTimeSense(pi);

  return {
    async firstTimeMessage(): Promise<string> {
      const sessionStart = handlers.get("session_start");
      const beforeAgentStart = handlers.get("before_agent_start");
      if (!sessionStart || !beforeAgentStart) {
        throw new Error("pi-time-sense did not register its required session hooks");
      }

      await sessionStart({ type: "session_start", reason: "startup" }, context);
      const result = (await beforeAgentStart(
        { type: "before_agent_start" },
        context,
      )) as BeforeAgentStartResult | undefined;
      if (!result) throw new Error("pi-time-sense did not return its first time message");
      return result.message.content;
    },
  };
}

test("uses the persisted start of a root session", async () => {
  const harness = createHarness(
    sessionHeader("root", new Date(CURRENT_TIME.getTime() - 83_000).toISOString()),
  );
  const message = await harness.firstTimeMessage();

  expect(
    message,
    "Expected a root session to keep its persisted start instead of restarting the clock",
  ).toContain("(session +1m23s)");
});

test("uses the oldest available ancestor when an earlier parent session was deleted", async () => {
  const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-time-sense-sessions-"));
  try {
    const deletedRootPath = join(sessionDirectory, "deleted-root.jsonl");
    const availableParentPath = join(sessionDirectory, "available-parent.jsonl");
    writeSessionHeader(
      availableParentPath,
      sessionHeader(
        "available-parent",
        minutesBeforeCurrentTime(120),
        deletedRootPath,
      ),
    );

    const harness = createHarness(
      sessionHeader("child", minutesBeforeCurrentTime(15), availableParentPath),
    );
    const message = await harness.firstTimeMessage();

    expect(
      message,
      "Expected a deleted root to preserve elapsed time from the oldest available ancestor",
    ).toContain("(session +2h0m)");
  } finally {
    rmSync(sessionDirectory, { recursive: true, force: true });
  }
});

test("keeps elapsed time anchored to the root across mixed fork and user-agent ancestry", async () => {
  const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-time-sense-sessions-"));
  try {
    const rootPath = join(sessionDirectory, "root.jsonl");
    const firstForkPath = join(sessionDirectory, "fork-1.jsonl");
    const firstUserAgentPath = join(sessionDirectory, "user-agent-1.jsonl");
    const secondForkPath = join(sessionDirectory, "fork-2.jsonl");

    writeSessionHeader(rootPath, sessionHeader("root", minutesBeforeCurrentTime(135)));
    writeSessionHeader(
      firstForkPath,
      sessionHeader("fork-1", minutesBeforeCurrentTime(105), rootPath),
    );
    writeSessionHeader(
      firstUserAgentPath,
      sessionHeader("user-agent-1", minutesBeforeCurrentTime(75), firstForkPath),
    );
    writeSessionHeader(
      secondForkPath,
      sessionHeader("fork-2", minutesBeforeCurrentTime(45), firstUserAgentPath),
    );

    const harness = createHarness(
      sessionHeader("user-agent-2", minutesBeforeCurrentTime(15), secondForkPath),
    );
    const message = await harness.firstTimeMessage();

    expect(
      message,
      "Expected the second user agent to keep the root session's elapsed time",
    ).toContain("(session +2h15m)");
  } finally {
    rmSync(sessionDirectory, { recursive: true, force: true });
  }
});
