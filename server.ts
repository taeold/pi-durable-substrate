import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  Type,
  fauxProvider,
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
  fauxText,
  type FauxProvider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  Harness,
  LiveDoc,
  InboxDoc,
  UsageDoc,
  createRegistry,
  defineExtension,
  defineTool,
  watchEvents,
  type ConversationHandle,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  openNodeSqliteStorage,
  type NodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";

const execFileAsync = promisify(execFile);
const BG = BACKGROUND_CONTEXT;

const PORT = Number(process.env.PORT || 80);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const PI_DIR = path.join(WORKSPACE_DIR, ".pi");
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(PI_DIR, "agent.sqlite");

// Default to Gemini 2.5 Flash when GEMINI_API_KEY is present, or deterministic
// scripted provider for zero-API-key local testing.
const DEFAULT_PROVIDER = process.env.GEMINI_API_KEY ? "google" : "scripted";
const DEFAULT_MODEL_ID =
  DEFAULT_PROVIDER === "google" ? "gemini-2.5-flash" : "scripted-coding-agent";
const MODEL_PROVIDER = process.env.MODEL_PROVIDER || DEFAULT_PROVIDER;
const MODEL_ID = process.env.MODEL_ID || DEFAULT_MODEL_ID;

// Volatile in-process state:
// - Discarded on SNAPSHOT_CONTENT_SCOPE_DATA cold boot (new container, durable /workspace preserved)
// - Preserved on SNAPSHOT_CONTENT_SCOPE_FULL memory restore (gVisor checkpoint/restore)
const PROCESS_BOOT_ID = crypto.randomUUID().slice(0, 8);
const PROCESS_STARTED_AT = new Date().toISOString();
let inMemoryRequestCount = 0;
let ready = false;
let recoveredTasksOnBoot: Array<{
  id: number;
  kind: string;
  state: string;
  recordState: unknown;
}> = [];

function getPodIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

function resolveWorkspacePath(relOrAbs: string): string {
  const resolved = path.resolve(WORKSPACE_DIR, relOrAbs || ".");
  if (!resolved.startsWith(path.resolve(WORKSPACE_DIR))) {
    throw new Error(`Path ${relOrAbs} escapes workspace ${WORKSPACE_DIR}`);
  }
  return resolved;
}

function abortableSleep(ms: number | undefined, signal?: AbortSignal): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Operation aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Operation aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Durable Tools on /workspace ──────────────────────────────────────────────

const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 text file from /workspace.",
  replay: "safe",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to /workspace" }),
  }),
  async execute(args, api, context) {
    context.abortSignal?.throwIfAborted();
    const target = resolveWorkspacePath(args.path);
    const content = await fsp.readFile(target, "utf8");
    api.output(content);
    await api.details({ path: args.path, bytes: Buffer.byteLength(content) }, context);
    return {
      content: [{ type: "text", text: content }],
      details: { path: args.path, bytes: Buffer.byteLength(content) },
    };
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Write a UTF-8 text file inside /workspace. Marked replay: safe for automatic crash/suspend recovery.",
  replay: "safe",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to /workspace" }),
    content: Type.String({ description: "File contents to write" }),
    delayMs: Type.Optional(
      Type.Number({
        description: "Optional simulated execution delay in ms to test mid-turn suspend/steer",
      })
    ),
  }),
  async execute(args, api, context) {
    context.abortSignal?.throwIfAborted();
    const target = resolveWorkspacePath(args.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    api.output(`Writing ${args.path} (${Buffer.byteLength(args.content)} bytes)...\n`);
    await api.details(
      {
        path: args.path,
        phase: "writing",
        executedByBootId: PROCESS_BOOT_ID,
        delayMs: args.delayMs ?? 0,
      },
      context
    );

    if (args.delayMs && args.delayMs > 0) {
      await abortableSleep(args.delayMs, context.abortSignal);
    }
    context.abortSignal?.throwIfAborted();

    await fsp.writeFile(target, args.content, "utf8");
    const msg = `Wrote ${args.path} (${Buffer.byteLength(args.content)} bytes) [bootId=${PROCESS_BOOT_ID}]`;
    api.output(msg + "\n");
    return {
      content: [{ type: "text", text: msg }],
      details: {
        path: args.path,
        bytes: Buffer.byteLength(args.content),
        phase: "completed",
        executedByBootId: PROCESS_BOOT_ID,
      },
    };
  },
});

const listFilesTool = defineTool({
  name: "list_files",
  description: "List files in /workspace (excluding .pi internal state).",
  replay: "safe",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Subdirectory relative to /workspace" })),
  }),
  async execute(args, _api, context) {
    context.abortSignal?.throwIfAborted();
    const dir = resolveWorkspacePath(args.path || ".");
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const names = entries
      .filter((e) => e.name !== ".pi")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    const summary = names.length > 0 ? names.join("\n") : "(empty)";
    return {
      content: [{ type: "text", text: summary }],
      details: { files: names, executedByBootId: PROCESS_BOOT_ID },
    };
  },
});

const runShellTool = defineTool({
  name: "run_shell",
  description: "Run a shell command in /workspace. Marked replay: unsafe by default.",
  replay: "unsafe",
  parameters: Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
  }),
  async execute(args, _api, context) {
    context.abortSignal?.throwIfAborted();
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", args.command], {
      cwd: WORKSPACE_DIR,
      timeout: 15_000,
    });
    const combined = `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
    return {
      content: [{ type: "text", text: combined || "(exit 0)" }],
      details: { command: args.command, executedByBootId: PROCESS_BOOT_ID },
    };
  },
});

const workspaceExtension = defineExtension({
  name: "substrate-workspace",
  tools: [readFileTool, writeFileTool, listFilesTool, runShellTool],
});

// ── Deterministic Multi-Step Scripted Provider ───────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: Record<string, unknown>) => {
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "thinking") return String(block.thinking ?? "");
      if (block.type === "toolCall") return `[toolCall:${String(block.name ?? "")}]`;
      return "";
    })
    .join(" ");
}

function createScriptedProvider(): FauxProvider {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted-api",
    models: [
      {
        id: "scripted-coding-agent",
        name: "Scripted Durable Coding Agent",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });

  const stepFn = async (context: { messages?: Array<Record<string, unknown>> }) => {
    const messages = context.messages || [];

    // Count how many prior turns ended with an assistant 'stop' message
    let lastStopIdx = -1;
    let completedTurns = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "assistant" && m.stopReason === "stop") {
        lastStopIdx = i;
        completedTurns++;
      }
    }

    const turnNumber = completedTurns + 1;
    const currentSlice = messages.slice(lastStopIdx + 1);
    const userMessagesInTurn = currentSlice.filter((m) => m.role === "user");
    const toolResultsInTurn = currentSlice.filter((m) => m.role === "toolResult");

    const initialPrompt = userMessagesInTurn[0]
      ? extractText(userMessagesInTurn[0].content)
      : "build workspace";
    const steeredPrompts = userMessagesInTurn.slice(1).map((m) => extractText(m.content));
    const isSlow = /slow|delay|sleep/i.test(initialPrompt);
    const delayMs = isSlow ? 3000 : 40;

    // Step 1 of the current turn: no tool results yet
    if (toolResultsInTurn.length === 0) {
      if (turnNumber === 1) {
        const appCode = [
          `// Generated by pi-durable in Turn 1 (bootId=${PROCESS_BOOT_ID})`,
          `export function add(a, b) {`,
          `  return a + b;`,
          `}`,
          ``,
        ].join("\n");
        return fauxAssistantMessage(
          [
            fauxThinking(`Turn 1 Step 1: Creating app.js in /workspace (delayMs=${delayMs}).`),
            fauxToolCall("write_file", {
              path: "app.js",
              content: appCode,
              delayMs,
            }),
          ],
          { stopReason: "toolUse" }
        );
      } else {
        const updatedAppCode = [
          `// Updated by pi-durable in Turn ${turnNumber} (bootId=${PROCESS_BOOT_ID})`,
          `export function add(a, b) {`,
          `  return a + b;`,
          `}`,
          `export function multiply(a, b) {`,
          `  return a * b;`,
          `}`,
          `export const lastPrompt = ${JSON.stringify(initialPrompt)};`,
          ``,
        ].join("\n");
        return fauxAssistantMessage(
          [
            fauxThinking(
              `Turn ${turnNumber} Step 1: Reading existing app.js and updating it with Turn ${turnNumber} changes.`
            ),
            fauxToolCall("read_file", { path: "app.js" }),
            fauxToolCall("write_file", {
              path: "app.js",
              content: updatedAppCode,
              delayMs,
            }),
          ],
          { stopReason: "toolUse" }
        );
      }
    }

    // Step 2 of the current turn: after Step 1 tool(s) finished (and any mid-turn /steer was injected)
    const hasWrittenTestJsInTurn = currentSlice.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some(
          (b: Record<string, unknown>) =>
            b.type === "toolCall" &&
            b.name === "write_file" &&
            (b.arguments as Record<string, unknown> | undefined)?.path === "test.js"
        )
    );

    if (!hasWrittenTestJsInTurn) {
      const steerNote =
        steeredPrompts.length > 0
          ? `// Steered mid-turn instruction: ${steeredPrompts.join(" | ")}\n`
          : `// Standard test suite for Turn ${turnNumber}\n`;
      const testCode = [
        steerNote.trimEnd(),
        `import assert from "node:assert/strict";`,
        `import { add${turnNumber > 1 ? ", multiply" : ""} } from "./app.js";`,
        `assert.equal(add(2, 3), 5);`,
        ...(turnNumber > 1 ? [`assert.equal(multiply(3, 4), 12);`] : []),
        ...(steeredPrompts.length > 0 ? [`export const steered = ${JSON.stringify(steeredPrompts)};`] : []),
        `console.log("All Turn ${turnNumber} assertions passed!");`,
        ``,
      ].join("\n");

      return fauxAssistantMessage(
        [
          fauxThinking(
            steeredPrompts.length > 0
              ? `Turn ${turnNumber} Step 2: Incorporating mid-turn steer (${JSON.stringify(steeredPrompts)}) and writing test.js.`
              : `Turn ${turnNumber} Step 2: Writing test.js and listing workspace files.`
          ),
          fauxToolCall("write_file", {
            path: "test.js",
            content: testCode,
            delayMs: 20,
          }),
          fauxToolCall("list_files", { path: "." }),
        ],
        { stopReason: "toolUse" }
      );
    }

    // Step 3 of the current turn: produce final assistant response
    const toolOutputs = toolResultsInTurn
      .map((tr) => `${String(tr.toolName ?? "")}: ${extractText(tr.content)}`)
      .join(" | ");
    const summaryText = [
      `Completed Turn ${turnNumber} on pod ${getPodIp()} (processBootId=${PROCESS_BOOT_ID}).`,
      `- Initial prompt: "${initialPrompt}"`,
      ...(steeredPrompts.length > 0
        ? [`- Mid-turn steered input incorporated: ${JSON.stringify(steeredPrompts)}`]
        : []),
      `- Tool calls completed in this turn: ${toolResultsInTurn.length} (${toolOutputs})`,
      `- Total transcript messages in SQLite: ${messages.length}`,
    ].join("\n");

    return fauxAssistantMessage(
      [
        fauxThinking(`Turn ${turnNumber} Step 3: All tools complete. Summarizing.`),
        fauxText(summaryText),
      ],
      {
        stopReason: "stop",
      }
    );
  };

  // Pre-seed 1000 dynamic response steps so the provider never runs out across turns/restarts
  faux.setResponses(Array.from({ length: 1000 }, () => stepFn));
  return faux;
}

// ── Harness Initialization ───────────────────────────────────────────────────

let storage: NodeSqliteStorage;
let harness: Harness;
let conversation: ConversationHandle;

async function initHarness(): Promise<void> {
  await fsp.mkdir(PI_DIR, { recursive: true });
  storage = await openNodeSqliteStorage(SQLITE_PATH);

  // Register all built-in providers (Google Gemini, Anthropic, OpenAI, etc.)
  // plus the deterministic scripted provider for zero-API-key testing.
  const models = builtinModels();
  const scripted = createScriptedProvider();
  models.setProvider(scripted.provider);

  const registry = createRegistry();
  registry.install(workspaceExtension);

  harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || WORKSPACE_DIR }),
      settings: {
        toolExecution: "sequential",
        steeringMode: "all",
        followUpMode: "all",
      },
      onReport: (err) => {
        console.error("[pi-durable onReport]", err);
      },
    },
    BG
  );

  conversation = await harness.root(BG, {
    agent: {
      model: { provider: MODEL_PROVIDER, modelId: MODEL_ID },
      cwd: WORKSPACE_DIR,
      instructions:
        "You are a durable coding agent running inside an Agent Substrate gVisor sandbox with state persisted in /workspace/.pi/agent.sqlite.",
    },
  });

  // Inspect before resume so we can record any mid-turn tasks recovered from SQLite on cold boot
  const preResumeInspect = await harness.inspect(BG);
  recoveredTasksOnBoot = preResumeInspect.tasks.map((t) => ({
    id: t.record.id,
    kind: t.record.kind,
    state: t.state,
    recordState: t.record.state,
  }));

  // Resume any unfinished durable tasks (e.g. after mid-turn SuspendActor or crash)
  await harness.resume(BG);
  ready = true;
  console.log(
    JSON.stringify({
      msg: "pi-durable harness initialized",
      processBootId: PROCESS_BOOT_ID,
      podIp: getPodIp(),
      sqlitePath: SQLITE_PATH,
      modelProvider: MODEL_PROVIDER,
      modelId: MODEL_ID,
      recoveredTasksOnBoot,
    })
  );
}

async function readWorkspaceFiles(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  try {
    const entries = await fsp.readdir(WORKSPACE_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".pi" || !e.isFile()) continue;
      const fullPath = path.join(WORKSPACE_DIR, e.name);
      result[e.name] = await fsp.readFile(fullPath, "utf8");
    }
  } catch {
    // ignore
  }
  return result;
}

async function buildStateSnapshot(): Promise<Record<string, unknown>> {
  const [inspection, live, inbox, usage, ctxView, workspaceFiles, sqliteStat] = await Promise.all([
    harness.inspect(BG),
    harness.snapshot(LiveDoc, conversation.id, BG),
    harness.snapshot(InboxDoc, conversation.id, BG),
    harness.snapshot(UsageDoc, conversation.id, BG),
    conversation.context(BG),
    readWorkspaceFiles(),
    fsp.stat(SQLITE_PATH).catch(() => null),
  ]);

  const simplifiedMessages = ctxView.messages.map((m) => ({
    role: m.role,
    stopReason: m.role === "assistant" ? m.stopReason : undefined,
    toolName: m.role === "toolResult" ? m.toolName : undefined,
    text: extractText(m.content),
  }));

  return {
    podIp: getPodIp(),
    processBootId: PROCESS_BOOT_ID,
    processStartedAt: PROCESS_STARTED_AT,
    pid: process.pid,
    model: { provider: MODEL_PROVIDER, modelId: MODEL_ID },
    inMemoryRequestCount,
    recoveredTasksOnBoot,
    sqlitePath: SQLITE_PATH,
    sqliteSizeBytes: sqliteStat ? sqliteStat.size : 0,
    inspection: {
      scheduling: inspection.scheduling,
      activeTasks: inspection.tasks.map((t) => ({
        id: t.record.id,
        kind: t.record.kind,
        schedulerState: t.state,
        phase:
          (t.record.state as { checkpoint?: { phase?: unknown }; status?: unknown } | undefined)
            ?.checkpoint?.phase ??
          (t.record.state as { status?: unknown } | undefined)?.status,
      })),
      activeSubmissions: inspection.submissions,
    },
    live: live ?? {},
    inbox: inbox ?? {},
    usage: usage ?? {},
    transcriptSummary: {
      entryCount: ctxView.entries.length,
      messageCount: ctxView.messages.length,
      messages: simplifiedMessages,
    },
    workspaceFiles,
  };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2) + "\n";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  if (req.method === "GET" && url.pathname === "/readyz") {
    if (!ready) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("not ready\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  if (!ready) {
    sendJson(res, 503, { error: "Harness not ready yet" });
    return;
  }

  try {
    if (req.method === "GET" && (url.pathname === "/state" || url.pathname === "/")) {
      inMemoryRequestCount++;
      const state = await buildStateSnapshot();
      sendJson(res, 200, state);
      return;
    }

    if (req.method === "POST" && url.pathname === "/submit") {
      inMemoryRequestCount++;
      const body = await readJsonBody(req);
      const prompt = typeof body.prompt === "string" ? body.prompt : "Build app.js and test.js";
      const wait = body.wait !== false;
      const whenBusy =
        body.whenBusy === "steer" || body.whenBusy === "reject" ? body.whenBusy : "followUp";

      const submission = await conversation.submit(
        {
          type: "input",
          content: prompt,
          whenBusy,
          ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
        },
        BG
      );

      if (!wait) {
        // Give the scheduler ~80ms to enter the first tool call before returning 202
        await new Promise((r) => setTimeout(r, 80));
        const state = await buildStateSnapshot();
        sendJson(res, 202, {
          action: "submit",
          wait: false,
          submissionId: submission.id,
          state,
        });
        return;
      }

      const settled = await submission.wait(BG);
      await conversation.waitForIdle(BG);
      const state = await buildStateSnapshot();
      sendJson(res, 200, {
        action: "submit",
        wait: true,
        submissionId: submission.id,
        settled,
        state,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/steer") {
      inMemoryRequestCount++;
      const body = await readJsonBody(req);
      const prompt =
        typeof body.prompt === "string" ? body.prompt : "Steer: also export steered metadata";
      const wait = body.wait !== false;

      const submission = await conversation.submit(
        {
          type: "input",
          content: prompt,
          whenBusy: "steer",
          ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
        },
        BG
      );

      if (!wait) {
        const state = await buildStateSnapshot();
        sendJson(res, 202, {
          action: "steer",
          wait: false,
          submissionId: submission.id,
          state,
        });
        return;
      }

      const settled = await submission.wait(BG);
      await conversation.waitForIdle(BG);
      const state = await buildStateSnapshot();
      sendJson(res, 200, {
        action: "steer",
        wait: true,
        submissionId: submission.id,
        settled,
        state,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wait") {
      inMemoryRequestCount++;
      await conversation.waitForIdle(BG);
      const state = await buildStateSnapshot();
      sendJson(res, 200, {
        action: "wait",
        state,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const abortController = new AbortController();
      req.on("close", () => abortController.abort());
      const streamCtx = withAbortSignal(abortController.signal, BG);

      const stream = await watchEvents(harness, conversation.id, streamCtx);
      res.write(`data: ${JSON.stringify(stream.snapshot)}\n\n`);
      stream.start(async (events) => {
        for (const ev of events) {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      });
      return;
    }

    sendJson(res, 404, { error: `Unknown route ${req.method} ${url.pathname}` });
  } catch (err) {
    console.error("[HTTP error]", err);
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Graceful SIGTERM Handler ─────────────────────────────────────────────────

let shuttingDown = false;
async function handleShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    JSON.stringify({
      msg: "Received signal, closing harness and flushing SQLite cleanly",
      signal,
      processBootId: PROCESS_BOOT_ID,
    })
  );
  try {
    if (harness) {
      await harness.close(BG);
    }
  } catch (err) {
    console.error("[Shutdown harness.close error]", err);
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      msg: `HTTP server listening on :${PORT}`,
      processBootId: PROCESS_BOOT_ID,
    })
  );
  initHarness().catch((err) => {
    console.error("Failed to initialize pi-durable harness:", err);
    process.exit(1);
  });
});
