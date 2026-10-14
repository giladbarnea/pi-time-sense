import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const START_MILLISECONDS = Date.parse("2026-10-14T09:00:00.000Z");
const MILLISECONDS_PER_MINUTE = 60_000;
let agentDirectory: string;
let previousAgentDirectory: string | undefined;
let registerTimeSense: (pi: ExtensionAPI) => void;
let networkGuard: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const sessions: AgentSession[] = [];

beforeAll(async () => {
  previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  agentDirectory = mkdtempSync(join(tmpdir(), "pi-time-sense-forks-"));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  registerTimeSense = (await import("../index.ts")).default;
});

beforeEach(() => {
  setSystemTime(START_MILLISECONDS);
  networkGuard = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fork tests must not access the network"));
});

afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions.length = 0;
  networkGuard.mockRestore();
  setSystemTime();
});

afterAll(() => {
  rmSync(agentDirectory, { recursive: true, force: true });
  if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
});

async function createScenario() {
  const provider = fauxProvider({ api: "openai-completions", provider: "time-sense-fork-test" });
  const requestTimestamps: string[][] = [];
  const extensionErrors: string[] = [];
  provider.setResponses(Array.from({ length: 8 }, () => (context) => {
    const transcript = context.messages.map((message) => contentText(message.content)).join("\n");
    requestTimestamps.push([...transcript.matchAll(/<automatic-current-time-message>.*?<\/automatic-current-time-message>/g)].map((match) => match[0]));
    return fauxAssistantMessage("Received.");
  }));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });

  async function createSession(sessionManager: SessionManager): Promise<AgentSession> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDirectory,
      agentDir: agentDirectory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.registerProvider("time-sense-fork-test", {
          api: "openai-completions",
          apiKey: "not-a-real-key",
          baseUrl: "http://unused.invalid",
          models: [provider.getModel()],
        });
        registerTimeSense(pi);
      }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: agentDirectory,
      agentDir: agentDirectory,
      resourceLoader,
      settingsManager,
      modelRuntime,
      model: provider.getModel(),
      sessionManager,
      noTools: "builtin",
    });
    sessions.push(session);
    session.agent.streamFunction = provider.provider.streamSimple;
    await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error.error) });
    return session;
  }

  async function forkSession(parent: AgentSession): Promise<AgentSession> {
    const parentSessionFile = parent.sessionFile;
    assert(parentSessionFile, "The parent must have a persisted transcript before forking");
    const manager = SessionManager.forkFrom(parentSessionFile, agentDirectory, agentDirectory);
    expect(manager.getHeader()?.parentSession, "A real Pi fork must record its parent").toBe(parentSessionFile);
    return createSession(manager);
  }

  async function prompt(session: AgentSession, elapsedMilliseconds: number): Promise<string[]> {
    setSystemTime(START_MILLISECONDS + elapsedMilliseconds);
    await session.prompt("Reply with Received.");
    expect(extensionErrors, "Handler errors must not masquerade as timestamp suppression").toEqual([]);
    expect(session.getLastAssistantText(), "The model fixture must complete the request successfully").toBe("Received.");
    expect(networkGuard).not.toHaveBeenCalled();
    return requestTimestamps[requestTimestamps.length - 1];
  }

  return { createSession, forkSession, prompt };
}

test("a fresh fork neither duplicates its inherited timestamp nor restarts the fifteen-minute deadline", async () => {
  const scenario = await createScenario();
  const parent = await scenario.createSession(SessionManager.create(agentDirectory, agentDirectory));
  const originalTimestamps = await scenario.prompt(parent, 0);
  expect(originalTimestamps).toHaveLength(1);

  const fork = await scenario.forkSession(parent);
  expect(
    await scenario.prompt(fork, MILLISECONDS_PER_MINUTE),
    "The one-minute-old inherited timestamp must suppress a duplicate in the fork",
  ).toEqual(originalTimestamps);
  expect(
    await scenario.prompt(fork, 15 * MILLISECONDS_PER_MINUTE - 1),
    "The inherited timestamp must remain fresh until the original deadline",
  ).toEqual(originalTimestamps);
  const dueTimestamps = await scenario.prompt(fork, 15 * MILLISECONDS_PER_MINUTE);
  expect(dueTimestamps, "The fork must send a timestamp at the parent's original deadline").toHaveLength(2);
  expect(dueTimestamps[0]).toBe(originalTimestamps[0]);
  expect(dueTimestamps[1]).toContain("(session +15m0s)");
});

test("nested forks use inherited history rather than newer timestamps outside their selected branch", async () => {
  const scenario = await createScenario();
  const root = await scenario.createSession(SessionManager.create(agentDirectory, agentDirectory));
  const originalTimestamps = await scenario.prompt(root, 0);
  expect(originalTimestamps).toHaveLength(1);

  const parent = await scenario.forkSession(root);
  await scenario.prompt(parent, MILLISECONDS_PER_MINUTE);
  const oldLeafId = parent.sessionManager.getLeafId();
  assert(oldLeafId, "The historical branch must contain the parent's first response");
  const nestedFork = await scenario.forkSession(parent);
  expect(
    await scenario.prompt(nestedFork, 2 * MILLISECONDS_PER_MINUTE),
    "A nested fork must not add a duplicate to the fresh timestamp inherited from its root",
  ).toEqual(originalTimestamps);

  const parentTimestamps = await scenario.prompt(parent, 16 * MILLISECONDS_PER_MINUTE);
  expect(parentTimestamps, "The parent must now have a newer timestamp outside the old branch").toHaveLength(2);
  const parentSessionFile = parent.sessionFile;
  assert(parentSessionFile, "The parent file must exist for the historical fork");
  const historicalManager = SessionManager.open(parentSessionFile, agentDirectory);
  historicalManager.createBranchedSession(oldLeafId);
  expect(historicalManager.getHeader()?.parentSession).toBe(parentSessionFile);
  const historicalFork = await scenario.createSession(historicalManager);
  const historicalTimestamps = await scenario.prompt(historicalFork, 17 * MILLISECONDS_PER_MINUTE);

  expect(historicalTimestamps, "The stale inherited timestamp must not borrow freshness from the parent's newer branch").toHaveLength(2);
  expect(historicalTimestamps[0]).toBe(originalTimestamps[0]);
  expect(historicalTimestamps).not.toContain(parentTimestamps[1]);
  expect(historicalTimestamps[1]).toContain("(session +17m0s)");
});
