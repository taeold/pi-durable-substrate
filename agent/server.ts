import http from "node:http";
import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const WORKSPACE = process.env.WORKSPACE_DIR || "/workspace";
await mkdir(`${WORKSPACE}/.pi`, { recursive: true });

const storage = await openNodeSqliteStorage(`${WORKSPACE}/.pi/agent.sqlite`);
const models = createModels();
models.setProvider(googleProvider());

const registry = createRegistry();
registry.install(CodingTools);

const harness = await Harness.open(
  storage,
  { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || WORKSPACE }) },
  context,
);
const conversation = await harness.root(context, {
  agent: { model: { provider: "google", modelId: "gemini-3.8-flash" }, cwd: WORKSPACE },
});
await harness.resume(context);

const server = http.createServer(async (req, res) => {
  if (req.url === "/readyz" || req.url === "/healthz") return res.end("ok\n");
  if (req.method === "GET") {
    const view = await conversation.context(context);
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(view));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const { prompt, whenBusy = req.url === "/steer" ? "steer" : "followUp" } = JSON.parse(
    Buffer.concat(chunks).toString() || "{}",
  );
  const sub = await conversation.submit({ type: "input", content: prompt, whenBusy }, context);
  const settled = await sub.wait(context);
  await conversation.waitForIdle(context);
  const view = await conversation.context(context);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ settled, view }));
});

process.on("SIGTERM", async () => {
  await harness.close(context);
  server.close(() => process.exit(0));
});
server.listen(Number(process.env.PORT || 80), "0.0.0.0");
