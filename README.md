# pi-openshell-subagent

English | [日本語](#日本語)

A [Pi coding agent](https://pi.dev/) extension that delegates tasks to sub-agents running inside
[NVIDIA OpenShell](https://docs.nvidia.com/openshell/) sandboxes. Each sub-agent gets its own sandbox created from an
OpenShell workload template through the OpenShell TypeScript SDK, runs `pi --mode json -p --no-session` there, streams
its JSON events back to the parent, and the sandbox is deleted when the run ends.

It is derived from Pi's `subagent` example; the only structural change is that the local `spawn` became
"create sandbox → wait for providers → exec → delete". See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Why: the sub-agent never holds a real API key (the OpenShell provider injects a resolve token that the supervisor
swaps at the TLS boundary), its network egress is limited by the sandbox policy, and cleanup is one `delete`.

## Requirements

- Pi 0.87 or later on the host (the parent).
- An OpenShell gateway of the 0.1.0 line (tested with the `dev` build `0.0.117-dev.291`) with a local mTLS gateway
  registered in `~/.config/openshell` (the extension reads the same bundle the `openshell` CLI uses). Remote OIDC
  gateways: set `OPENSHELL_TOKEN` to a bearer token.
- A workload template whose image contains `pi` (for example the image from the official
  [Run Pi in OpenShell](https://docs.nvidia.com/openshell/dev/tutorials/run-pi) tutorial), and a provider for the
  model API (`openshell provider create ...`).
- Bun or Node 20.3+ to install `@nvidia/openshell-sdk`, which is published to GitHub Packages and needs a token with
  `read:packages` (see `.npmrc`).

## Install

```bash
git clone https://github.com/himorishige/pi-openshell-subagent.git
cd pi-openshell-subagent
NPM_GITHUB_TOKEN=$(gh auth token) bun install
pi install /absolute/path/to/pi-openshell-subagent
```

Copy or symlink the agent definitions you want into `~/.pi/agent/agents/` or point `OPENSHELL_SUBAGENT_AGENTS_DIR`
at a directory of `*.md` files (frontmatter `name` / `description` / optional `tools` / `model` / `providers` /
`template`, body = system prompt). `providers` and `template` override the extension-wide defaults per agent, so a
web-search agent can carry only a search-API provider and a PR-review agent only a read-only GitHub provider, each
with its own model and tool allowlist.

```yaml
---
name: pr-reviewer
description: Reads a pull request and reports findings
tools: read, grep, bash
model: openai/gpt-5-mini
providers: github
template: pi-review
---
```

## Resident sandboxes (large codebases)

OpenShell has no bind mount, so a sub-agent gets code by `git clone` (with a GitHub provider) or by
`openshell sandbox upload`. For a large repository, create one sandbox per role once, clone there, and let the agent
reuse it: put `sandbox: <name>` (and optionally `workdir: <path>`) in the agent definition. The extension then skips
creation, starts the sandbox if it is stopped, waits for its providers, runs pi in `workdir`, and never deletes it.
Hand results back through Git (push a branch) rather than files. Reusing a Ready sandbox costs about 40 ms; starting a
stopped one costs about 0.5 s plus roughly 10 s for the providers to be installed again.

```yaml
---
name: repo-worker
description: Works inside the project's resident sandbox
sandbox: proj-worker
workdir: /sandbox/repo
providers: github
---
```

## Configure

| Variable                            | Default         | Meaning                                                              |
| ----------------------------------- | --------------- | -------------------------------------------------------------------- |
| `OPENSHELL_SUBAGENT_TEMPLATE`       | `pi-subagent`   | Workload template name (`openshell sandbox template create ...`)     |
| `OPENSHELL_SUBAGENT_PROVIDERS`      | `fireworks`     | Comma-separated providers attached to every sub-agent sandbox        |
| `OPENSHELL_SUBAGENT_LAUNCH`         | `pi`            | Command that runs pi inside the sandbox (a wrapper script is fine)   |
| `OPENSHELL_SUBAGENT_MODEL`          | (pi default)    | `--model` for sub-agents whose agent file has no `model`             |
| `OPENSHELL_SUBAGENT_AGENTS_DIR`     | `./agents`      | Directory of agent `*.md` files                                      |
| `OPENSHELL_SUBAGENT_TIMEOUT_SECS`   | `600`           | Exec budget per sub-agent                                            |
| `OPENSHELL_SUBAGENT_RESULTS`        | (off)           | Append one JSON line of metrics per run                              |
| `OPENSHELL_SUBAGENT_CREDENTIAL_ENV` | `ANTHROPIC_API_KEY` | Env var whose first 22 chars are recorded (shows the resolve token, never a key) |
| `OPENSHELL_SUBAGENT_ROUTING_LOG`    | (off)           | Optional JSONL routing log inside the sandbox to summarise           |
| `OPENSHELL_SUBAGENT_KEEP=1`         | (off)           | Keep sandboxes after the run for debugging                           |
| `OPENSHELL_GATEWAY_TLS_NAME`        | (off)           | Verify the gateway certificate against this host name when the gateway URL is an IP (running the parent inside a sandbox) |

## Use

Ask the parent Pi to delegate, for example: "use openshell_subagent to run these three tasks in parallel with the
worker agent". Tool parameters: `{agent, task}` for one sub-agent or `{tasks: [{agent, task}, ...]}` for up to 8 in
parallel (4 at a time). The sub-agent cannot see the parent's files; put everything it needs in the task text and
expect a text answer.

## Behaviour worth knowing

- After the sandbox is Ready, the attached providers take a few seconds to install; the extension waits for
  `getSandboxProviderStatus` to report READY before starting pi. Without that wait the model stream can be closed with
  `policy generation is stale`.
- Aborting the parent's tool call aborts the exec and deletes the sandbox.
- Running the parent inside a sandbox is possible but not recommended: the sandbox cannot resolve the gateway host
  (`policy_dns_trusted_gateway_unavailable` with a name-based docker `grpc_endpoint`), so point the gateway metadata at
  the gateway IP, allow that IP with `tls: skip` in the sandbox policy (the supervisor must not terminate the mTLS), and
  set `OPENSHELL_GATEWAY_TLS_NAME` to the certificate's host name. The parent then holds gateway credentials, so use an
  OIDC client-credentials identity scoped to one workspace rather than a local mTLS admin bundle.

## 日本語

Pi coding agent の sub-agent を、1 本ずつ NVIDIA OpenShell の sandbox の中で動かす extension です。親 Pi の tool
呼び出しごとに、OpenShell の workload template から sandbox を作り、provider の反映を待ち、`pi --mode json -p`
を実行して JSON event を親に返し、終わったら sandbox を消します。sub-agent は実鍵を持たず（provider が解決用トークン
を注入し、supervisor が TLS 境界で差し替える）、通信は sandbox の policy で絞られます。

Pi 公式の `subagent` example が元で、ローカル `spawn` を「sandbox 作成 → provider 待ち → exec → delete」に置き換えました。
設定は上の環境変数表のとおりです。`@nvidia/openshell-sdk` は GitHub Packages 配布なので、install には `read:packages`
の token が要ります。
