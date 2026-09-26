// OpenShell SDK wrapper for the openshell-subagent Pi extension.
//
// Connects to the active local gateway with the same mTLS bundle the `openshell` CLI uses
// (~/.config/openshell/gateways/<name>/mtls), so the extension needs no extra credentials on the host.
// Responsibilities: create one sandbox per sub-agent from a workload template, wait for Ready, run a command,
// stream its output line by line, and delete the sandbox afterwards (also on abort).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { OpenShellClient, type SandboxRef } from "@nvidia/openshell-sdk";

export interface GatewayConnection {
  client: OpenShellClient;
  gatewayName: string;
  endpoint: string;
}

interface GatewayMetadata {
  name: string;
  gateway_endpoint: string;
  auth_mode: string;
}

function configDir(): string {
  return process.env.OPENSHELL_CONFIG_DIR ?? join(homedir(), ".config", "openshell");
}

/** Resolve the active gateway exactly like the CLI: OPENSHELL_GATEWAY, then ~/.config/openshell/active_gateway. */
export function activeGatewayName(): string {
  const fromEnv = process.env.OPENSHELL_GATEWAY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return readFileSync(join(configDir(), "active_gateway"), "utf8").trim();
}

/**
 * Running inside an OpenShell sandbox, the gateway is reachable only by IP (policy DNS refuses the host-gateway
 * aliases when the driver has no trusted gateway address) while its certificate carries host names. Set
 * OPENSHELL_GATEWAY_TLS_NAME to the name the certificate is issued for; the chain is still verified against the CA.
 */
function pinServerIdentity(): void {
  const name = process.env.OPENSHELL_GATEWAY_TLS_NAME;
  if (!name) return;
  const original = tls.checkServerIdentity;
  tls.checkServerIdentity = (_host, cert) => original(name, cert);
}

/** Build an SDK client for the active local gateway (mTLS) or a remote one (OIDC bearer via OPENSHELL_TOKEN). */
export async function connectActiveGateway(): Promise<GatewayConnection> {
  pinServerIdentity();
  const gatewayName = activeGatewayName();
  const dir = join(configDir(), "gateways", gatewayName);
  const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as GatewayMetadata;
  const endpoint = meta.gateway_endpoint;

  if (meta.auth_mode === "mtls") {
    const mtls = join(dir, "mtls");
    const client = await OpenShellClient.connect({
      gateway: endpoint,
      caCert: readFileSync(join(mtls, "ca.crt")),
      clientCert: readFileSync(join(mtls, "tls.crt")),
      clientKey: readFileSync(join(mtls, "tls.key")),
    });
    return { client, gatewayName, endpoint };
  }

  const token = process.env.OPENSHELL_TOKEN;
  if (!token) {
    throw new Error(
      `gateway "${gatewayName}" uses auth_mode=${meta.auth_mode}; set OPENSHELL_TOKEN (OIDC bearer) for the SDK`,
    );
  }
  const client = await OpenShellClient.connect({ gateway: endpoint, oidcToken: token });
  return { client, gatewayName, endpoint };
}

export interface SpawnSandboxOptions {
  /** Workload template name (image, cpu, memory come from it). */
  template: string;
  /** Sandbox name; must be unique in the workspace. */
  name: string;
  /** Provider names to attach at creation (their keys are injected as resolve tokens). */
  providers: string[];
  labels?: Record<string, string>;
  /** Seconds to wait for Ready. */
  readyTimeoutSecs?: number;
  signal?: AbortSignal;
}

export interface SpawnedSandbox {
  ref: SandboxRef;
  /** Wall-clock milliseconds from createFromTemplate() until Ready. */
  readyMs: number;
  /** Additional milliseconds until every attached provider reported READY (credentials + policy installed). */
  providersMs: number;
}

const PROVIDER_READINESS_READY = 3; // openshell.v1.ProviderReadinessState.READY

/**
 * Wait until the supervisor has installed every attached provider (credentials, composed policy, process env).
 * `waitReady` only covers the sandbox phase; the provider install lands a few seconds later and bumps the policy
 * generation, which closes any L7 tunnel that was opened in between ("policy generation is stale"). A sub-agent
 * that starts streaming from the model in that window loses its response, so we wait here first.
 */
export async function waitProvidersReady(
  client: OpenShellClient,
  name: string,
  providers: string[],
  timeoutSecs = 60,
  signal?: AbortSignal,
  workspace = "default",
): Promise<void> {
  const deadline = Date.now() + timeoutSecs * 1000;
  const pending = new Set(providers);
  while (pending.size > 0) {
    if (signal?.aborted) throw new Error("aborted while waiting for providers");
    for (const provider of [...pending]) {
      const res = await client.raw.getSandboxProviderStatus({
        sandbox: name,
        provider,
        receiptId: "",
        workspaceScope: { selection: { case: "workspace", value: workspace } },
      });
      if (res.status?.state === PROVIDER_READINESS_READY) pending.delete(provider);
    }
    if (pending.size === 0) return;
    if (Date.now() > deadline) throw new Error(`providers not ready after ${timeoutSecs}s: ${[...pending].join(", ")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Create a sandbox from the template, wait until the supervisor reports Ready and until the providers are
 *  installed. The canonical command is a long-lived `sleep` so the sandbox stays up while we exec the sub-agent. */
export async function spawnSandbox(client: OpenShellClient, opts: SpawnSandboxOptions): Promise<SpawnedSandbox> {
  const started = performance.now();
  const created = await client.sandbox.createFromTemplate({
    name: opts.name,
    workloadTemplate: opts.template,
    providers: opts.providers,
    labels: opts.labels,
    command: ["sleep", "infinity"],
    tty: false,
  });
  const ref = await client.sandbox.waitReady(created.name, opts.readyTimeoutSecs ?? 180, { signal: opts.signal });
  const readyMs = Math.round(performance.now() - started);
  await waitProvidersReady(client, created.name, opts.providers, 60, opts.signal, ref.workspace || "default");
  return { ref, readyMs, providersMs: Math.round(performance.now() - started) - readyMs };
}

export interface ResidentSandbox {
  ref: SandboxRef;
  /** Milliseconds spent starting the sandbox (0 when it was already Ready). */
  startMs: number;
  /** Milliseconds until every attached provider reported READY. */
  providersMs: number;
  /** Providers found attached to the sandbox. */
  providers: string[];
  /** True when the sandbox had to be started. */
  started: boolean;
}

/**
 * Resident mode: reuse a sandbox that was created once (typically with a cloned repository in it). If it is
 * stopped, completed or errored, start it again and wait for Ready; then wait for its providers like spawnSandbox
 * does. The caller must never delete a resident sandbox.
 */
export async function ensureResidentSandbox(
  client: OpenShellClient,
  name: string,
  opts: { readyTimeoutSecs?: number; signal?: AbortSignal } = {},
): Promise<ResidentSandbox> {
  const t0 = performance.now();
  let ref = await client.sandbox.get(name);
  const workspace = ref.workspace || "default";
  let started = false;
  if (ref.phase === "stopped" || ref.phase === "completed" || ref.phase === "error") {
    await client.raw.startSandbox({
      name,
      requestId: "",
      workspaceScope: { selection: { case: "workspace", value: workspace } },
    });
    started = true;
  }
  if (ref.phase !== "ready") {
    ref = await client.sandbox.waitReady(name, opts.readyTimeoutSecs ?? 180, { signal: opts.signal });
  }
  const startMs = Math.round(performance.now() - t0);
  const providers = (await client.sandbox.listAllProviders(name)).map((p) => p.name);
  await waitProvidersReady(client, name, providers, 60, opts.signal, workspace);
  return { ref, startMs, providersMs: Math.round(performance.now() - t0) - startMs, providers, started };
}

export interface ExecLinesOptions {
  workdir?: string;
  environment?: Record<string, string>;
  timeoutSecs?: number;
  signal?: AbortSignal;
  onStdoutLine: (line: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Run a command in the sandbox and deliver stdout line by line (the sub-agent writes one JSON event per line). */
export async function execLines(
  client: OpenShellClient,
  name: string,
  command: string[],
  opts: ExecLinesOptions,
): Promise<number> {
  let buffer = "";
  let exitCode = 0;
  const stream = client.sandbox.execStream(name, command, {
    workdir: opts.workdir,
    environment: opts.environment,
    timeoutSecs: opts.timeoutSecs,
    noLoginShell: true,
    signal: opts.signal,
  });
  for await (const event of stream) {
    if (!("stream" in event)) {
      exitCode = event.exitCode;
      continue;
    }
    const chunk = event.data.toString("utf8");
    if (event.stream === "stderr") {
      opts.onStderr?.(chunk);
      continue;
    }
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) opts.onStdoutLine(line);
  }
  if (buffer.trim()) opts.onStdoutLine(buffer);
  return exitCode;
}

/** Delete the sandbox and wait until the gateway no longer lists it. Never throws: cleanup runs in finally blocks. */
export async function deleteSandbox(client: OpenShellClient, name: string, timeoutSecs = 120): Promise<boolean> {
  try {
    const deletion = await client.sandbox.delete(name, { allowMissing: true });
    if (deletion.outcome === "accepted" || deletion.outcome === "unknown") {
      await client.sandbox.waitDeleted(name, timeoutSecs, { expectedSandboxId: deletion.sandboxId });
    }
    return true;
  } catch {
    return false;
  }
}
