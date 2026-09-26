---
name: openshell-subagent
description: How the parent Pi delegates work to sub-agents that run inside NVIDIA OpenShell sandboxes through the openshell_subagent tool. Use when deciding whether to delegate, when writing or choosing an agent definition, before the first delegation in a session (pre-flight), when preparing a resident sandbox for a project, or when a delegation fails (provider not ready, gateway unreachable, sandbox stuck). Trigger keywords - openshell_subagent, sub-agent, subagent, sandbox, delegate, resident sandbox, OpenShell, provider, template, policy_denied, policy generation is stale.
---

# openshell-subagent

The `openshell_subagent` tool runs one sub-agent per OpenShell sandbox. The sub-agent is a separate `pi` process with
its own context window, its own network policy and its own credentials (injected by an OpenShell provider as resolve
tokens; it never sees a real key). It cannot see the parent's files. Everything it needs must be in the task text, and
what comes back is text.

## 1. Delegate or do it yourself

Delegate when the work is self-contained and benefits from isolation: reading or summarising material you paste into
the task, generating code from a spec, reviewing a pull request that lives on GitHub, searching the web, or anything
that should run with a narrower set of credentials than the parent has. Do it yourself when the work needs the
parent's working tree, several rounds of clarification, or takes less time than a sandbox round trip (about 11 s for a
fresh sandbox: 0.8 s to Ready plus roughly 10 s until the providers are installed; about 40 ms to reuse a resident one).

Put the deliverable itself in the task: paste the code, the diff, the requirements. Ask for the answer as text. If the
sub-agent must produce files, give it a resident sandbox with a cloned repository and ask it to push a branch.

## 2. Agent definitions

Agents are markdown files with frontmatter. The body is the system prompt.

```yaml
---
name: pr-reviewer
description: Reads a pull request and reports findings
tools: read, grep, bash           # Pi tool allowlist for the sub-agent
model: openai/gpt-5-mini          # optional; otherwise OPENSHELL_SUBAGENT_MODEL or pi's default
providers: github                 # optional; overrides OPENSHELL_SUBAGENT_PROVIDERS for this agent
template: pi-review               # optional; overrides OPENSHELL_SUBAGENT_TEMPLATE
sandbox: proj-review              # optional; resident mode - reuse this sandbox, never delete it
workdir: /sandbox/repo            # optional; where pi runs inside the sandbox
---
```

Give each role only what it needs. A web-search agent carries only the search-API provider; a PR-review agent carries
a read-only GitHub token; a code-fix agent carries the inference provider and a token that may push. The boundary is
enforced by the sandbox policy and the provider profile, not by the prompt, so a prompt that goes wrong cannot cross
it. Model and tools are chosen per agent as well: cheap models for reading, stronger ones for judgement.

## 3. Pre-flight (once per session, before the first delegation)

Run these on the host and read the output before calling the tool.

```bash
openshell status                       # Status: Connected, Authentication: Authenticated
openshell provider list                # the providers named in agent definitions must exist
openshell sandbox template list        # the templates named in agent definitions must exist
openshell sandbox list                 # resident sandboxes named in agent definitions must exist (Ready or Stopped)
```

If a provider or template is missing, stop and ask a person to create it. Do not create providers yourself: creating
one means handing an API key or a personal access token to the gateway, and that decision belongs to a human.
Templates and resident sandboxes may be created on request (section 4).

## 4. Resident sandboxes (large repositories)

OpenShell has no bind mount. A sub-agent gets code by cloning it inside the sandbox or by `openshell sandbox upload`.
For a repository of any size, prepare one sandbox per role once and let the agent reuse it:

```bash
openshell sandbox template create pi-review --image <image with pi and gh> --cpu 2 --memory 4Gi
openshell sandbox create --name proj-review --template pi-review --provider github --label role=review -- sleep infinity
openshell sandbox exec -n proj-review -- git clone https://github.com/<org>/<repo>.git /sandbox/repo
```

Then set `sandbox: proj-review` and `workdir: /sandbox/repo` in the agent definition. Keep the sandbox running while
it is in use; `openshell sandbox stop` frees compute but the next use pays about 0.5 s to start plus roughly 10 s for
the providers to be reinstalled. The workspace survives stop and start, so the clone is done once and later runs
`git pull`. Results travel back through Git (a pushed branch, a pull request), never through files.

## 5. When a delegation fails

| Symptom                                                        | Meaning and what to do                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `upstream transport error` right after the sandbox is created | The provider was installed after the sandbox became Ready and the policy generation changed. The extension waits for this; if you see it, the wait timed out - check `openshell sandbox provider status <sandbox> <provider>` |
| `providers not ready after 60s`                                | The provider install did not complete. `openshell sandbox provider status` shows persisted / installed flags; `openshell logs <sandbox> --source sandbox` shows why |
| `502 upstream_error` from the model                            | No provider attached, or the key was overwritten inside the sandbox. `openshell sandbox provider list <sandbox>`      |
| `policy_denied` in the sandbox log                             | The sub-agent tried a destination the policy does not allow. Ask a person before adding a rule; `openshell policy update --dry-run` shows the effect |
| Gateway unreachable from the extension                         | `openshell status` on the host. If the parent itself runs inside a sandbox, see the README section on `OPENSHELL_GATEWAY_TLS_NAME` |
| Sandbox left behind after an abort                             | `openshell sandbox list --selector role=subagent` and `openshell sandbox delete <name>`                               |

For gateway, driver, TLS and provider-endpoint diagnosis beyond this table, use NVIDIA's own skills from the OpenShell
repository: `skills/debug-openshell-cluster` (gateway health, Docker/Podman/Kubernetes drivers, TLS and auth) and
`skills/debug-inference` (provider attachment, endpoint policy, `credential_endpoint_mismatch`,
`host.openshell.internal`). They are maintained upstream and are not copied here.

## 6. Boundaries the parent must respect

- Do not upload secrets into a sandbox. Providers exist so that keys never enter the workload.
- Do not widen a sandbox policy or attach a provider to satisfy a sub-agent's request without a person's decision.
- Resident sandboxes are shared state: do not delete or recreate one that another session may be using.
- The parent has whatever the gateway credential allows. Prefer an OIDC client-credentials identity scoped to one
  workspace over a local mTLS bundle when the parent runs unattended.
