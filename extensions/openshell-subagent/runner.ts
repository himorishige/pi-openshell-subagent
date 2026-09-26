// Core of openshell-subagent, independent of Pi's extension API so it can be exercised with plain `bun run`.
//
// One sub-agent run = one OpenShell sandbox:
//   createFromTemplate (providers attached, labels set) -> waitReady -> exec `pi --mode json -p --no-session ...`
//   -> parse the JSON event stream exactly like Pi's subagent example -> optionally read a routing log for metrics
//   -> delete the sandbox (always, also on abort).
// The Fireworks key is never on this side: the provider puts a resolve token in the sandbox and the supervisor
// swaps it at the TLS boundary. What crosses the gateway API is the task text and the sub-agent's JSON output.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentConfig } from "./agents.ts";
import { connectActiveGateway, deleteSandbox, execLines, spawnSandbox, type GatewayConnection } from "./sandbox.ts";

export interface RunnerConfig {
  /** Workload template name (image, cpu, memory). */
  template: string;
  /** Provider names attached to every sub-agent sandbox. */
  providers: string[];
  /** Command inside the sandbox that runs pi (a wrapper script may start sidecars first). */
  launch: string;
  /** Model passed to the sub-agent when the agent file has none. */
  defaultModel: string;
  /** Per-run wall-clock budget for the exec. */
  timeoutSecs: number;
  /** Keep the sandbox after the run (debugging). */
  keep: boolean;
  /** Append one JSON line per run here (metrics for the article); empty = off. */
  resultsFile?: string;
  /** Label value identifying the parent (Pi session id or pid). */
  parent: string;
  /** Env var whose first 22 chars are recorded as evidence of the resolve token (never the key). */
  credentialEnv: string;
  /** Optional routing log (one JSON object per line) read from the sandbox after the run; empty = skip. */
  routingLog: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv, parent: string): RunnerConfig {
  return {
    template: env.OPENSHELL_SUBAGENT_TEMPLATE ?? "pi-subagent",
    providers: (env.OPENSHELL_SUBAGENT_PROVIDERS ?? "fireworks")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    launch: env.OPENSHELL_SUBAGENT_LAUNCH ?? "pi",
    defaultModel: env.OPENSHELL_SUBAGENT_MODEL ?? "",
    timeoutSecs: Number(env.OPENSHELL_SUBAGENT_TIMEOUT_SECS ?? "600"),
    keep: env.OPENSHELL_SUBAGENT_KEEP === "1",
    resultsFile: env.OPENSHELL_SUBAGENT_RESULTS || undefined,
    parent,
    credentialEnv: env.OPENSHELL_SUBAGENT_CREDENTIAL_ENV ?? "ANTHROPIC_API_KEY",
    routingLog: env.OPENSHELL_SUBAGENT_ROUTING_LOG ?? "",
  };
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Subset of a Pi message we read from the JSON stream (kept loose: the sub-agent's pi may be a different version). */
export interface StreamMessage {
  role: string;
  content?: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface Timeline {
  createMs: number; // createFromTemplate + waitReady
  providersMs: number; // extra wait until the attached providers report READY
  execMs: number; // pi run inside the sandbox
  deleteMs: number; // delete + waitDeleted
  totalMs: number;
}

export interface RoutingStats {
  /** Lines in the routing log (one per upstream call), when OPENSHELL_SUBAGENT_ROUTING_LOG is set. */
  lines: number;
  /** Distinct Switchyard session ids seen (expected 1 per sub-agent). */
  sessionIds: string[];
  /** Calls whose tier is "classifier" (judge invocations). */
  judgeCalls: number;
  /** Route ids seen (auto / auto-explore / weak-only ...). */
  routes: string[];
}

export interface SingleResult {
  agent: string;
  task: string;
  sandbox: string;
  exitCode: number;
  messages: StreamMessage[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  timeline: Timeline;
  routing?: RoutingStats;
  /** First 22 chars of the credential env var as seen inside the sandbox (proves the resolve token, never a key). */
  credentialPrefix?: string;
  aborted?: boolean;
}

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function getFinalOutput(messages: StreamMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}

export function isFailedResult(r: SingleResult): boolean {
  return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || r.aborted === true;
}

export function getResultOutput(r: SingleResult): string {
  if (isFailedResult(r)) return r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
  return getFinalOutput(r.messages) || "(no output)";
}

let connection: Promise<GatewayConnection> | undefined;
/** One SDK client per process; the transport multiplexes every sandbox over the same HTTP/2 connection. */
export function gateway(): Promise<GatewayConnection> {
  if (!connection) connection = connectActiveGateway();
  return connection;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function sandboxSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "agent";
}

/** Parse a routing log (one JSON object per line with session_id / route_id / tier fields). */
export function parseRouting(lines: string[]): RoutingStats {
  const sessionIds = new Set<string>();
  const routes = new Set<string>();
  let judgeCalls = 0;
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: { session_id?: string; tier?: string; route_id?: string };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    count++;
    if (rec.session_id) sessionIds.add(rec.session_id);
    if (rec.route_id) routes.add(rec.route_id);
    if (rec.tier === "classifier") judgeCalls++;
  }
  return { lines: count, sessionIds: [...sessionIds], judgeCalls, routes: [...routes] };
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Called after every parsed event that changed the result (streaming UI). */
  onUpdate?: (partial: SingleResult) => void;
}

export async function runSubagent(
  config: RunnerConfig,
  agent: AgentConfig,
  task: string,
  opts: RunOptions = {},
): Promise<SingleResult> {
  const { client } = await gateway();
  const sandbox = `sa-${sandboxSafe(agent.name)}-${shortId()}`;
  const model = agent.model ?? config.defaultModel ?? "";
  const result: SingleResult = {
    agent: agent.name,
    task,
    sandbox,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model,
    timeline: { createMs: 0, providersMs: 0, execMs: 0, deleteMs: 0, totalMs: 0 },
  };
  const t0 = performance.now();
  const emit = () => opts.onUpdate?.(result);

  let created = false;
  try {
    const spawned = await spawnSandbox(client, {
      template: config.template,
      name: sandbox,
      providers: config.providers,
      labels: { role: "subagent", agent: sandboxSafe(agent.name), parent: config.parent },
      signal: opts.signal,
    });
    created = true;
    result.timeline.createMs = spawned.readyMs;
    result.timeline.providersMs = spawned.providersMs;
    emit();

    const args = [config.launch, "--mode", "json", "-p", "--no-session"];
    if (model) args.push("--model", model);
    if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
    if (agent.systemPrompt) args.push("--append-system-prompt", agent.systemPrompt);
    args.push(`Task: ${task}`);

    const tExec = performance.now();
    const exitCode = await execLines(client, sandbox, args, {
      timeoutSecs: config.timeoutSecs,
      signal: opts.signal,
      onStderr: (chunk) => {
        result.stderr += chunk;
      },
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        let event: { type?: string; message?: StreamMessage };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          result.messages.push(msg);
          if (msg.role === "assistant") {
            result.usage.turns++;
            const u = msg.usage;
            if (u) {
              result.usage.input += u.input ?? 0;
              result.usage.output += u.output ?? 0;
              result.usage.cacheRead += u.cacheRead ?? 0;
              result.usage.cacheWrite += u.cacheWrite ?? 0;
              result.usage.cost += u.cost?.total ?? 0;
              result.usage.contextTokens = u.totalTokens ?? 0;
            }
            if (msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          }
          emit();
        } else if (event.type === "tool_result_end" && event.message) {
          result.messages.push(event.message);
          emit();
        }
      },
    });
    result.timeline.execMs = Math.round(performance.now() - tExec);
    result.exitCode = exitCode;

    // Evidence for the article, read from inside the sandbox: the credential is a resolve token, and the
    // routing log shows how many upstream calls one sub-agent session made (judge + model).
    if (!opts.signal?.aborted) {
      const lines: string[] = [];
      await execLines(
        client,
        sandbox,
        [
          "sh",
          "-c",
          `printf 'CRED=%s\\n' "$(printf %s "$${config.credentialEnv}" | cut -c1-22)"; [ -n "${config.routingLog}" ] && cat "${config.routingLog}" 2>/dev/null; true`,
        ],
        { timeoutSecs: 30, onStdoutLine: (l) => lines.push(l) },
      ).catch(() => undefined);
      const cred = lines.find((l) => l.startsWith("CRED="));
      if (cred) result.credentialPrefix = cred.slice(5);
      result.routing = parseRouting(lines.filter((l) => !l.startsWith("CRED=")));
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      result.aborted = true;
      result.stopReason = "aborted";
    } else {
      result.errorMessage = err instanceof Error ? err.message : String(err);
      result.stopReason = "error";
    }
    if (result.exitCode === -1) result.exitCode = 1;
  } finally {
    if (created && !config.keep) {
      const tDel = performance.now();
      await deleteSandbox(client, sandbox);
      result.timeline.deleteMs = Math.round(performance.now() - tDel);
    }
    result.timeline.totalMs = Math.round(performance.now() - t0);
    if (config.resultsFile) appendResult(config.resultsFile, result);
    emit();
  }
  return result;
}

function appendResult(file: string, r: SingleResult): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      agent: r.agent,
      sandbox: r.sandbox,
      model: r.model,
      exitCode: r.exitCode,
      stopReason: r.stopReason,
      aborted: r.aborted ?? false,
      timeline: r.timeline,
      usage: r.usage,
      routing: r.routing,
      credentialPrefix: r.credentialPrefix,
      outputChars: getFinalOutput(r.messages).length,
    };
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // metrics are best effort
  }
}

/** Run several sub-agents concurrently, each in its own sandbox. */
export async function runParallel(
  config: RunnerConfig,
  jobs: Array<{ agent: AgentConfig; task: string }>,
  opts: RunOptions & { concurrency?: number; onEach?: (index: number, partial: SingleResult) => void } = {},
): Promise<SingleResult[]> {
  const limit = Math.max(1, Math.min(opts.concurrency ?? 4, jobs.length));
  const results: SingleResult[] = new Array(jobs.length);
  let next = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      results[i] = await runSubagent(config, jobs[i].agent, jobs[i].task, {
        signal: opts.signal,
        onUpdate: (partial) => opts.onEach?.(i, partial),
      });
    }
  });
  await Promise.all(workers);
  return results;
}
