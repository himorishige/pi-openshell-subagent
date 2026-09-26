// Agent definitions for openshell-subagent: one markdown file per agent with frontmatter
// (name / description / tools / model / providers / template) and the system prompt as the body.
// `sandbox` switches the agent to resident mode: an existing sandbox (created once, e.g. with a cloned repo) is
// reused and started if stopped, instead of being created and deleted per call. `workdir` sets where pi runs.
// `providers` and `template` override the extension-wide defaults, so each agent can get its own credentials,
// egress policy (via the template's image) and model: a web-search agent with a search provider, a PR-review agent
// with a read-only GitHub token, and so on.
// Trimmed from Pi's examples/extensions/subagent/agents.ts: a single directory, no project-scope discovery,
// because the sub-agent runs in a sandbox and must not pick up repo-controlled prompts by accident.

import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  /** Providers attached to this agent's sandbox (overrides OPENSHELL_SUBAGENT_PROVIDERS). */
  providers?: string[];
  /** Workload template for this agent's sandbox (overrides OPENSHELL_SUBAGENT_TEMPLATE). */
  template?: string;
  /** Resident mode: reuse this existing sandbox (start it if stopped) and never delete it. */
  sandbox?: string;
  /** Working directory inside the sandbox for the sub-agent (e.g. a cloned repo). */
  workdir?: string;
  systemPrompt: string;
  filePath: string;
}

/** Minimal frontmatter parser: `---` block with `key: value` lines, then the body. */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter, body: match[2] };
}

function parseToolList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tools = value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

export function loadAgents(dir: string): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  const agents: AgentConfig[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: frontmatter.model || undefined,
      providers: parseToolList(frontmatter.providers),
      template: frontmatter.template || undefined,
      sandbox: frontmatter.sandbox || undefined,
      workdir: frontmatter.workdir || undefined,
      systemPrompt: body.trim(),
      filePath,
    });
  }
  return agents;
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `${a.name}: ${a.description}`).join("; ");
}
