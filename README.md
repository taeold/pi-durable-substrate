# `pi-durable-substrate`

Durable, stateful AI coding agents built with [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) running inside [Agent Substrate (`agent-substrate/substrate`)](https://github.com/agent-substrate/substrate) gVisor sandboxes on Kubernetes (`kind` or GKE).

## Why `@earendil-works/pi-durable` + Agent Substrate?

`@earendil-works/pi-durable` turns the Pi agent loop into an explicit, SQLite-backed state machine (`pi.generation`, `pi.tool`, `pi.turn_finalize`, `pi.inbox`, `pi.live`, `pi.usage`) with zero in-memory hidden state across steps.

Agent Substrate (`ate`) provides Kubernetes-native **stateful actor lifecycle management** (`CreateActor`, `SuspendActor`, `ResumeActor`, `RevertActor`, `CreateTag`) backed by gVisor (`runsc`) sandboxes, on-demand ingress wake-up (`atenet-router`), and zero-secret outbound credential injection (`atenet-egress`).

Combining the two gives you two complementary durability layers:

| Layer | Responsibility | Storage Artifact |
| :--- | :--- | :--- |
| **`@earendil-works/pi-durable`** | Step-by-step agent state machine, journaled transcript entries, mid-turn `/steer` inbox, and `replay: "safe"` vs `"unsafe"` tool crash recovery | `/workspace/.pi/agent.sqlite` (via Node 24 built-in `node:sqlite`) |
| **Agent Substrate (`ate`)** | Sandbox scale-to-zero (`SuspendActor`), cold/warm auto-resume on HTTP request (`ate-target-actor`), O(1) snapshot tagging (`CreateTag`), and actor branching/forking | `/workspace` tar.zst (`SNAPSHOT_CONTENT_SCOPE_DATA`) or full gVisor memory + filesystem checkpoint (`SNAPSHOT_CONTENT_SCOPE_FULL`) in GCS / S3 (`rustfs`) |

---

## Repository Structure

- [`server.ts`](./server.ts) — Node.js 24 HTTP actor server using native TypeScript execution (`node server.ts`). Initializes `@earendil-works/pi-durable` on `/workspace/.pi/agent.sqlite`, registers 4 durable workspace tools (`read_file`, `write_file`, `list_files`, `run_shell`), automatically resumes interrupted mid-turn tasks on boot (`harness.resume()`), and flushes SQLite cleanly on `SIGTERM` (`harness.close()`).
- [`Dockerfile`](./Dockerfile) — `node:24-slim` container image running `node server.ts` on `:80`.
- [`workerpool.yaml`](./workerpool.yaml) — `ate-demo-pi` namespace and 2-replica gVisor `WorkerPool`.
- [`template.yaml`](./template.yaml) — `ActorTemplate` manifests for both `pi-durable-data` (`SNAPSHOT_CONTENT_SCOPE_DATA`) and `pi-durable-full` (`SNAPSHOT_CONTENT_SCOPE_FULL`), plus optional `systemInfo` trust bundle projection for HTTPS egress interception.
- [`egress-policy.yaml`](./egress-policy.yaml) — `EgressPolicy` manifest that injects real `GEMINI_API_KEY` (`x-goog-api-key`), `ANTHROPIC_API_KEY` (`x-api-key`), and `OPENAI_API_KEY` (`Authorization: Bearer`) headers at the `atenet-egress` gateway so secrets never enter actor memory or snapshots.
- [`demo.sh`](./demo.sh) — End-to-end walkthrough testing creation, Turn 1 execution, `SuspendActor`, snapshot tagging (`checkpoint-v1`), actor forking (`demo-agent-fork`), divergent Turn 2 execution, and mid-turn `/steer`.

---

## HTTP API Endpoints

Route requests to any actor through `atenet-router` by setting the `ate-target-actor: <atespace>/<actor-name>` header (if the actor is `ACTOR_STATE_SUSPENDED`, `atenet-router` automatically wakes it before forwarding the request):

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/healthz` | `GET` | Liveness probe (`200 ok`) |
| `/readyz` | `GET` | Readiness probe (`200 ok` once SQLite + `harness.resume()` complete) |
| `/state` | `GET` | Full inspection of `processBootId`, `inMemoryRequestCount`, `recoveredTasksOnBoot`, SQLite transcript summary, and `/workspace` file contents |
| `/submit` | `POST` | Submit a user prompt (`{"prompt": "...", "wait": true\|false, "whenBusy": "followUp"\|"steer"\|"reject"}`) |
| `/steer` | `POST` | Inject a mid-turn steering instruction (`whenBusy: "steer"`) into `pi.inbox` |
| `/wait` | `POST` | Wait for all active/recovered durable tasks in the conversation to settle (`conversation.waitForIdle()`) |
| `/events` | `GET` | Server-Sent Events (SSE) stream of live durable harness events (`watchEvents`) |

---

## Quickstart

### 1. Build and Push the Actor Image (Pinned by Digest)

Agent Substrate requires `ActorTemplate` container images to be pinned by `@sha256:...` digest so snapshots remain valid across restarts:

```bash
docker build -t localhost:5001/pi-durable-actor:latest .
docker push localhost:5001/pi-durable-actor:latest
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' localhost:5001/pi-durable-actor:latest)
echo "Pinned image: ${DIGEST}"
```

Update `image:` in `template.yaml` with `${DIGEST}`.

### 2. Deploy WorkerPool, Atespace, and ActorTemplates

```bash
kubectl apply -f workerpool.yaml
kubectl rollout status deployment/pi-durable -n ate-demo-pi

kubectl ate create atespace ate-demo-pi
kubectl ate create actor-template -f template.yaml

# Wait ~20s for golden snapshots to build:
kubectl ate get actor-template -a ate-demo-pi
```

### 3. Port-Forward `atenet-router` and Run the Walkthrough

```bash
kubectl port-forward -n ate-system svc/atenet-router 8000:80 &
./demo.sh
```

---

## Key Capabilities & Measured Latencies (`kind` with `/dev/kvm`)

| Capability | Command / Action | Measured Latency | What Happens Under the Hood |
| :--- | :--- | :--- | :--- |
| **Create Actor** | `kubectl ate create actor demo-agent --template pi-durable-data -a ate-demo-pi` | **92 – 100 ms** | Registers actor metadata pointing to the template's golden snapshot (`ACTOR_STATE_SUSPENDED`, 0 pods consumed). |
| **Turn 1 (Golden Resume + 3 Tool Calls)** | `POST /submit` (`"Turn 1: scaffold app.js"`) | **820 – 1168 ms** | `atenet-router` wakes actor onto a warm worker pod, runs 3-step turn (`write_file("app.js")`, `write_file("test.js")`, `list_files`), commits 8 entries to `/workspace/.pi/agent.sqlite`. |
| **Scale-to-Zero (`SuspendActor` - `DATA`)** | `kubectl ate suspend actor demo-agent -a ate-demo-pi` | **350 – 359 ms** | Sends `SIGTERM` (`harness.close()` flushes SQLite), tars `/workspace` (`.pi/agent.sqlite` + generated files) to object storage, frees worker pod. |
| **Scale-to-Zero (`SuspendActor` - `FULL`)** | `kubectl ate suspend actor pi-full-1 -a ate-demo-pi` | **445 ms** | Checkpoints full gVisor sandbox memory + filesystem + open FDs (`processBootId` and RAM counters preserved). |
| **Cold Auto-Resume (`DATA` Scope)** | `GET /state` on suspended `DATA` actor | **1762 ms** | Cold-boots fresh Node 24 container (`new processBootId`), mounts `/workspace` snapshot from object storage, reopens `/workspace/.pi/agent.sqlite` with 100% of prior history and files intact. |
| **Warm Auto-Resume (`FULL` Scope)** | `GET /state` on suspended `FULL` actor | **820 ms** | Restores gVisor memory image directly; both `processBootId` (in-RAM state) and `/workspace/.pi/agent.sqlite` are preserved. |
| **Mid-Turn `/steer`** | `POST /submit` (`wait:false`) + `POST /steer` | **3258 ms** *(incl. 3000ms tool delay)* | Queues steer message in `pi.inbox` while Step 1 tool executes; injects steer before Step 2 LLM call. |
| **Mid-Turn `SuspendActor` + Crash Recovery** | `kubectl ate suspend actor` mid-tool + `POST /wait` | **5082 ms** *(incl. cold boot + 3000ms tool replay)* | `SIGTERM` aborts in-flight `write_file` before completion; on wake, new container detects unfinished `pi.tool` (task 12) + `pi.generation` (task 9) in SQLite and automatically replays `write_file` (`replay: "safe"`). |
| **Tag Snapshot & Fork Actor** | `kubectl ate create tag checkpoint-v1` + `kubectl ate create actor demo-agent-fork --tag checkpoint-v1` | **110 ms** (tag) / **95 ms** (fork) | Copies snapshot to immutable tag URI; forked actor and original actor auto-resume on separate worker pods from identical Turn 1 state and diverge cleanly on Turn 2. |

---

## Using Live Gemini / Anthropic / OpenAI Models with Egress Credential Injection

By default, `server.ts` uses the deterministic `scripted` provider (`MODEL_PROVIDER=scripted`) so all demos work out-of-the-box without external API keys.

To run with live **Gemini 2.5 Flash** (`MODEL_PROVIDER=google`, `MODEL_ID=gemini-2.5-flash`) without exposing API keys inside the sandbox or snapshots:

1. Create a Kubernetes Secret with your real API key and grant `ate-demo-pi` access in `k8s-credential-provider-namespace-policy`.
2. Uncomment the `system-info` volume (`egress-mitm.ate.dev` trust bundle) and `NODE_EXTRA_CA_CERTS=/run/ate/trust-bundle.pem` + `GEMINI_API_KEY=ate-placeholder-key` in [`template.yaml`](./template.yaml).
3. Apply [`egress-policy.yaml`](./egress-policy.yaml) to your actor:
   ```bash
   kubectl ate create egress-policy demo-agent -a ate-demo-pi -f egress-policy.yaml
   ```
