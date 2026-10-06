# pi-durable-substrate

A simple durable AI coding agent built with [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) running on [Agent Substrate](https://github.com/agent-substrate/substrate).

## `server.ts`

```ts
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
```

## How it works

`pi-durable` runs the coding agent loop and writes every conversation turn and tool checkpoint to a SQLite database at `/workspace/.pi/agent.sqlite`.

Agent Substrate runs each agent as an isolated actor with `/workspace` mounted as a durable directory (`durableDir` in `template.yaml`).

1. **Suspend and auto-resume**: When you suspend an actor (`kubectl ate suspend actor`), Agent Substrate sends `SIGTERM` so `pi-durable` flushes SQLite, snapshots `/workspace` to object storage, and stops the container. When the next HTTP request arrives for that actor, the router restores `/workspace` onto a worker pod and wakes the server back up before forwarding the request.
2. **Checkpoint and fork**: Because both the agent history (`agent.sqlite`) and the working files live in `/workspace`, you can tag a suspended actor (`kubectl ate create tag`) and create a new actor from that tag (`kubectl ate create actor --tag`). Both actors start from the same history and files, then diverge on subsequent requests.
3. **Egress credential injection**: The sandbox runs with a placeholder `GEMINI_API_KEY`. Outbound calls to `generativelanguage.googleapis.com` pass through the Agent Substrate egress proxy, which injects the real API key from `egress-policy.yaml` so secrets never enter the sandbox or its snapshots.

## Quickstart

```bash
# 1. Build and push the actor image
docker build -t localhost:5001/pi-durable-actor:latest .
docker push localhost:5001/pi-durable-actor:latest
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' localhost:5001/pi-durable-actor:latest)
# Update image: in template.yaml with ${DIGEST}

# 2. Deploy WorkerPool, Atespace, and ActorTemplate
kubectl apply -f workerpool.yaml
kubectl ate create atespace ate-demo-pi
kubectl ate create actor-template -f template.yaml

# 3. Port-forward the router and run the demo
kubectl port-forward -n ate-system svc/atenet-router 8000:80 &
./demo.sh
```
