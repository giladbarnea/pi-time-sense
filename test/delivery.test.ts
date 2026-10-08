import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentText,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const CURRENT_TIME = new Date("2026-10-08T09:00:00.000Z");
let agentDirectory: string;
let previousAgentDirectory: string | undefined;
let registerTimeSense: (pi: ExtensionAPI) => void;
let networkGuard: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeAll(async () => {
  previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  agentDirectory = mkdtempSync(join(tmpdir(), "pi-time-sense-delivery-"));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  registerTimeSense = (await import("../index.ts")).default;
});

beforeEach(() => {
  setSystemTime(CURRENT_TIME);
  networkGuard = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("The delivery regression must not access the network"),
  );
});

afterEach(() => {
  networkGuard.mockRestore();
  setSystemTime();
});

afterAll(() => {
  rmSync(agentDirectory, { recursive: true, force: true });
  if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
});

interface DeliveryScenario {
  name: string;
  terminate: boolean;
  elapsedMinutes: number;
  expectedRequests: number;
  expectedTimestamps: number;
}

const scenarios: DeliveryScenario[] = [
  { name: "a due timestamp does not continue a terminating tool", terminate: true, elapsedMinutes: 16, expectedRequests: 1, expectedTimestamps: 2 },
  { name: "a terminating tool with no timestamp due stops normally", terminate: true, elapsedMinutes: 1, expectedRequests: 1, expectedTimestamps: 1 },
  { name: "a due timestamp reaches a nonterminating tool's existing follow-up", terminate: false, elapsedMinutes: 16, expectedRequests: 2, expectedTimestamps: 2 },
];

test.each(scenarios)("$name", async (scenario) => {
  const provider = fauxProvider({ api: "openai-completions", provider: "time-sense-test" });
  const requestTranscripts: string[] = [];
  provider.setResponses([
    (context) => {
      requestTranscripts.push(context.messages.map((message) => contentText(message.content)).join("\n"));
      return fauxAssistantMessage(fauxToolCall("finish_test", {}), { stopReason: "toolUse" });
    },
    (context) => {
      requestTranscripts.push(context.messages.map((message) => contentText(message.content)).join("\n"));
      return fauxAssistantMessage("Tool result received.");
    },
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let toolExecutions = 0;
  const resourceLoader = new DefaultResourceLoader({
    cwd: agentDirectory,
    agentDir: agentDirectory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.registerProvider("time-sense-test", {
          api: "openai-completions",
          apiKey: "not-a-real-key",
          baseUrl: "http://unused.invalid",
          models: [provider.getModel()],
        });
        registerTimeSense(pi);
        pi.registerTool({
          name: "finish_test",
          label: "Finish test",
          description: "Return a result with the selected termination behavior",
          parameters: Type.Object({}),
          execute: async () => {
            toolExecutions++;
            setSystemTime(CURRENT_TIME.getTime() + scenario.elapsedMinutes * 60_000);
            return { content: [{ type: "text", text: "Finished" }], details: undefined, terminate: scenario.terminate };
          },
        });
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: agentDirectory,
    agentDir: agentDirectory,
    resourceLoader,
    settingsManager,
    modelRuntime,
    model: provider.getModel(),
    sessionManager: SessionManager.inMemory(agentDirectory),
    noTools: "builtin",
  });
  session.agent.streamFunction = provider.provider.streamSimple;
  const extensionErrors: string[] = [];

  try {
    await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error.error) });
    await session.prompt("Run the finishing tool once.");
    const timestamps = session.sessionManager.getEntries().flatMap((entry) =>
      entry.type === "custom_message" && entry.customType === "pi-time-sense" ? [entry] : [],
    );
    const assistantErrors = session.messages.flatMap((message) =>
      message.role === "assistant" && message.stopReason === "error" ? [message.errorMessage] : [],
    );

    expect(extensionErrors, "The real extension must load and run without handler errors").toEqual([]);
    expect(assistantErrors, "A fixture/provider failure must not masquerade as successful termination").toEqual([]);
    expect(toolExecutions, "The real agent loop must execute the tool exactly once").toBe(1);
    expect(timestamps, "Time markers must remain persisted even when the tool terminates").toHaveLength(scenario.expectedTimestamps);
    expect(timestamps.every((entry) => !entry.display), "Time markers must stay hidden from the UI").toBe(true);
    expect(networkGuard, "The isolated runtime must not make network requests").not.toHaveBeenCalled();
    expect(provider.state.callCount, "A timestamp must not create model work beyond the tool's normal continuation").toBe(scenario.expectedRequests);

    if (!scenario.terminate) {
      const dueTimestamp = contentText(timestamps[1].content);
      expect(requestTranscripts[0]).not.toContain(dueTimestamp);
      expect(requestTranscripts[1], "The due timestamp must reach the already-required follow-up request").toContain(dueTimestamp);
    }
  } finally {
    session.dispose();
  }
});
