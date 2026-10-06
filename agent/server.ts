import http from "node:http";
import { mkdir } from "node:fs/promises";
import { json } from "node:stream/consumers";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

await mkdir("/workspace/.pi", { recursive: true });

const storage = await openNodeSqliteStorage("/workspace/.pi/agent.sqlite");
const models = createModels();
models.setProvider(googleProvider());

const registry = createRegistry();
registry.install(CodingTools);

const harness = await Harness.open(
  storage,
  { models, registry, env: () => new NodeExecutionEnv({ cwd: "/workspace" }) },
  context,
);
const conversation = await harness.root(context, {
  agent: { model: { provider: "google", modelId: "gemini-3.8-flash" }, cwd: "/workspace" },
});
await harness.resume(context);

const server = http.createServer(async (req, res) => {
  if (req.url === "/readyz") return res.end("ok\n");
  const { prompt } = (await json(req)) as { prompt: string };
  const sub = await conversation.submit({ type: "input", content: prompt, whenBusy: "followUp" }, context);
  const settled = await sub.wait(context);
  await conversation.waitForIdle(context);
  const view = await conversation.context(context);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ settled, view }));
});

process.on("SIGTERM", async () => {
  await harness.close(context);
  server.close(() => process.exit(0));
});
server.listen(80, "0.0.0.0");
