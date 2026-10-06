# `pi-durable-substrate`

A ~50-line durable AI coding agent built with [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) (`CodingTools` + `gemini-3.8-flash`) running inside [Agent Substrate (`agent-substrate/substrate`)](https://github.com/agent-substrate/substrate) gVisor sandboxes on Kubernetes (`kind` or GKE).

## The Entire Agent Server (`server.ts`)

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

---

## Architecture: How `@earendil-works/pi-durable` and Agent Substrate Fit Together

1. **Built-In `CodingTools` (`read`, `write`, `edit`, `bash`)**:
   `@earendil-works/pi-durable/tools` ships `CodingTools`, a pre-built extension providing durable `read`, `write`, `edit`, and `bash` tools bound to `NodeExecutionEnv({ cwd: "/workspace" })`. Read-only/idempotent file operations (`read`, `write`, `edit`) are marked `replay: "safe"` so interrupted mid-turn executions automatically replay on recovery, while `bash` is marked `replay: "unsafe"` so a crash mid-command surfaces a structured interruption to the model rather than blindly re-running side effects.
2. **`SNAPSHOT_CONTENT_SCOPE_DATA` + `/workspace/.pi/agent.sqlite`**:
   Because `@earendil-works/pi-durable` persists every conversation entry, tool checkpoint, and `pi.inbox` steering item into `/workspace/.pi/agent.sqlite` (using Node 24's built-in `node:sqlite`), the `ActorTemplate` only needs `SNAPSHOT_CONTENT_SCOPE_DATA` on `/workspace` (`durableDir: {}`). On `kubectl ate suspend actor`, `SIGTERM` triggers `await harness.close(context)` to flush SQLite cleanly before `/workspace` is snapshotted to object storage and the worker pod is freed.
3. **Snapshot Tagging & Actor Branching (`CreateTag` + `CreateActor --tag`)**:
   Any suspended actor's `/workspace` + SQLite state can be tagged as an immutable checkpoint and forked into new independent actors:
   ```bash
   kubectl ate suspend actor demo-agent -a ate-demo-pi
   kubectl ate create tag checkpoint-v1 --actor demo-agent -a ate-demo-pi
   kubectl ate create actor demo-agent-fork --template pi-durable-data --tag checkpoint-v1 -a ate-demo-pi
   ```
   When you send different Turn 2 prompts via `curl -H "ate-target-actor: ate-demo-pi/demo-agent"` and `curl -H "ate-target-actor: ate-demo-pi/demo-agent-fork"`, `atenet-router` automatically wakes both actors on separate worker pods from the shared Turn 1 SQLite transcript and `/workspace` files, and their state diverges cleanly.
4. **Zero-Secret `EgressPolicy` Credential Injection**:
   In `template.yaml`, the actor is given a placeholder `GEMINI_API_KEY="ate-placeholder-key"` and trusts the `egress-mitm.ate.dev` CA bundle via `NODE_EXTRA_CA_CERTS=/run/ate/trust-bundle.pem`. When `googleProvider()` (`gemini-3.8-flash`) calls `https://generativelanguage.googleapis.com/v1beta`, `atenet-egress` intercepts the outbound request and replaces `x-goog-api-key` with the real secret fetched from the credential provider (`egress-policy.yaml`) — ensuring real API keys never enter actor memory, `/workspace`, or snapshots.

---

## Quickstart

```bash
# 1. Build and push the actor image pinned by digest
docker build -t localhost:5001/pi-durable-actor:latest .
docker push localhost:5001/pi-durable-actor:latest
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' localhost:5001/pi-durable-actor:latest)
# Update image: in template.yaml with ${DIGEST}

# 2. Deploy WorkerPool, Atespace, and ActorTemplate
kubectl apply -f workerpool.yaml
kubectl ate create atespace ate-demo-pi
kubectl ate create actor-template -f template.yaml

# 3. Port-forward atenet-router and run the 5-step walkthrough
kubectl port-forward -n ate-system svc/atenet-router 8000:80 &
./demo.sh
```
