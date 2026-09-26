// openshell-subagent: a Pi extension that delegates tasks to sub-agents running in OpenShell sandboxes.
//
// Derived from Pi's examples/extensions/subagent. The one structural change: instead of spawning a local `pi`
// process, each sub-agent gets its own OpenShell sandbox (created from a workload template through the TypeScript
// SDK), runs `pi --mode json -p --no-session` there, and the sandbox is deleted when the run ends.
// Modes: single ({agent, task}) and parallel ({tasks: [{agent, task}, ...]}). Chain mode was dropped for the PoC.
//
// Configuration (environment of the parent pi):
//   OPENSHELL_SUBAGENT_TEMPLATE      workload template name        (default pi-subagent)
//   OPENSHELL_SUBAGENT_PROVIDERS     comma-separated providers     (default fireworks)
//   OPENSHELL_SUBAGENT_LAUNCH        command that runs pi inside   (default pi)
//   OPENSHELL_SUBAGENT_MODEL         model when the agent file has none (default: pi's own default)
//   OPENSHELL_SUBAGENT_CREDENTIAL_ENV env var recorded as resolve-token evidence (default ANTHROPIC_API_KEY)
//   OPENSHELL_SUBAGENT_ROUTING_LOG   optional routing log inside the sandbox to summarise (default off)
//   OPENSHELL_SUBAGENT_AGENTS_DIR    directory of agent *.md files (default ../../agents next to this file)
//   OPENSHELL_SUBAGENT_TIMEOUT_SECS  exec budget per sub-agent     (default 600)
//   OPENSHELL_SUBAGENT_RESULTS       jsonl file for run metrics    (default off)
//   OPENSHELL_SUBAGENT_KEEP=1        keep sandboxes for debugging

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatAgentList, loadAgents } from "./agents.ts";
import {
  configFromEnv,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  runParallel,
  runSubagent,
  type SingleResult,
} from "./runner.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
});

const Params = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
});

interface Details {
  mode: "single" | "parallel";
  results: SingleResult[];
}

function agentsDir(): string {
  return process.env.OPENSHELL_SUBAGENT_AGENTS_DIR ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "agents");
}

function summarize(r: SingleResult): string {
  const t = r.timeline;
  const routing = r.routing ? ` routing=${r.routing.lines} lines, judge=${r.routing.judgeCalls}, sessions=${r.routing.sessionIds.length}` : "";
  return `${r.sandbox} model=${r.model ?? "?"} exit=${r.exitCode} create=${t.createMs}ms providers=${t.providersMs}ms exec=${t.execMs}ms delete=${t.deleteMs}ms total=${t.totalMs}ms turns=${r.usage.turns} tokens=${r.usage.input}/${r.usage.output}${routing}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "openshell_subagent",
    label: "OpenShell sub-agent",
    description: [
      "Delegate a task to a sub-agent that runs in its own OpenShell sandbox (isolated context, isolated network and credentials).",
      "Modes: single (agent + task) or parallel (tasks array). Agents with a `sandbox` in their definition reuse that resident sandbox (e.g. one with a cloned repo); others get a fresh sandbox per call. The sub-agent has no access to this machine's files;",
      "give it everything it needs in the task text and expect a text answer back.",
      `Agents: ${formatAgentList(loadAgents(agentsDir()))}.`,
    ].join(" "),
    parameters: Params,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agents = loadAgents(agentsDir());
      const sm = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
      const parent = String(sm?.getSessionId?.() ?? `pid-${process.pid}`).slice(0, 36);
      const config = configFromEnv(process.env, parent);

      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const details = (mode: Details["mode"], results: SingleResult[]): Details => ({ mode, results });

      if (Number(hasTasks) + Number(hasSingle) !== 1) {
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode. Available agents: ${formatAgentList(agents)}` }],
          details: details("single", []),
          isError: true,
        };
      }

      const resolve = (name: string) => agents.find((a) => a.name === name);

      if (hasTasks && params.tasks) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
            details: details("parallel", []),
            isError: true,
          };
        }
        const missing = params.tasks.map((t) => t.agent).filter((n) => !resolve(n));
        if (missing.length > 0) {
          return {
            content: [{ type: "text", text: `Unknown agent(s): ${missing.join(", ")}. Available: ${formatAgentList(agents)}` }],
            details: details("parallel", []),
            isError: true,
          };
        }
        const jobs = params.tasks.map((t) => ({ agent: resolve(t.agent)!, task: t.task }));
        const live: SingleResult[] = [];
        const results = await runParallel(config, jobs, {
          signal,
          concurrency: MAX_CONCURRENCY,
          onEach: (i, partial) => {
            live[i] = partial;
            const done = live.filter((r) => r && r.timeline.totalMs > 0).length;
            onUpdate?.({
              content: [{ type: "text", text: `Parallel: ${done}/${jobs.length} done` }],
              details: details("parallel", live.filter(Boolean)),
            });
          },
        });
        const ok = results.filter((r) => !isFailedResult(r)).length;
        const body = results
          .map((r) => `### [${r.agent}] ${isFailedResult(r) ? "failed" : "completed"} (${r.sandbox})\n\n${getResultOutput(r)}`)
          .join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${body}` }],
          details: details("parallel", results),
        };
      }

      const agent = resolve(params.agent!);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${formatAgentList(agents)}` }],
          details: details("single", []),
          isError: true,
        };
      }
      const result = await runSubagent(config, agent, params.task!, {
        signal,
        onUpdate: (partial) =>
          onUpdate?.({
            content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
            details: details("single", [partial]),
          }),
      });
      if (isFailedResult(result)) {
        return {
          content: [{ type: "text", text: `Sub-agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
          details: details("single", [result]),
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
        details: details("single", [result]),
      };
    },

    renderCall(args, theme) {
      if (args.tasks && args.tasks.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("openshell_subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} sandboxes)`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 50 ? `${t.task.slice(0, 50)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        return new Text(text, 0, 0);
      }
      const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("openshell_subagent "))}${theme.fg("accent", args.agent ?? "...")}\n  ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as Details | undefined;
      if (!d || d.results.length === 0) {
        const c = result.content[0];
        return new Text(c?.type === "text" ? c.text : "(no output)", 0, 0);
      }
      let text = "";
      for (const r of d.results) {
        const running = r.timeline.totalMs === 0;
        const icon = running ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
        text += `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))} ${theme.fg("dim", summarize(r))}\n`;
        const out = getResultOutput(r);
        const preview = expanded ? out : out.split("\n").slice(0, 4).join("\n");
        text += `${theme.fg("toolOutput", preview)}\n`;
      }
      if (!expanded) text += theme.fg("muted", "(Ctrl+O to expand)");
      return new Text(text.trimEnd(), 0, 0);
    },
  });
}
