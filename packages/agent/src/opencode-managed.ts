import { readFileSync } from "node:fs";
import path from "node:path";

import { ToolError } from "grokcode-shared";

import { decodeConfigText } from "./envfile.js";

/** Hostname and port from OpenCode's managed-service config. The password is never copied out. */
export interface ServiceEndpointConfig {
  hostname?: string;
  port?: number;
}

/** url and pid from the running service registration. The password is never copied out. */
export interface ServiceRegistration {
  url?: string;
  pid?: number;
}

export function openCodeServiceConfigPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return path.join(base, "opencode", "service.json");
}

export function openCodeServiceStatePath(home: string, env: NodeJS.ProcessEnv = {}): string {
  const base = env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state");
  return path.join(base, "opencode", "service.json");
}

export function readOptionalText(file: string): string | undefined {
  try {
    return decodeConfigText(readFileSync(file));
  } catch {
    return undefined;
  }
}

export function parseServiceConfigText(text: string | undefined): ServiceEndpointConfig {
  const record = parseObject(text);
  if (!record) return {};
  const hostname = typeof record.hostname === "string" ? record.hostname.trim() : "";
  const port = asPort(record.port);
  return {
    ...(hostname ? { hostname } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

export function parseServiceStateText(text: string | undefined): ServiceRegistration {
  const record = parseObject(text);
  if (!record) return {};
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
  return {
    ...(url ? { url } : {}),
    ...(pid !== undefined ? { pid } : {}),
  };
}

export function readServiceEndpoint(
  home: string,
  env: NodeJS.ProcessEnv,
  readText: (file: string) => string | undefined = readOptionalText,
): ServiceEndpointConfig {
  return parseServiceConfigText(safeRead(openCodeServiceConfigPath(home, env), readText));
}

export function readServiceRegistration(
  home: string,
  env: NodeJS.ProcessEnv,
  readText: (file: string) => string | undefined = readOptionalText,
): ServiceRegistration {
  return parseServiceStateText(safeRead(openCodeServiceStatePath(home, env), readText));
}

/**
 * True when the listener is the managed service registered for the OpenCode app.
 * A matching url or a matching pid is enough. The registration password is not read.
 */
export function isManagedService(registration: ServiceRegistration, listener: { url: string; pid?: number }): boolean {
  const wanted = endpointKey(listener.url);
  const registered = registration.url ? endpointKey(registration.url) : undefined;
  if (wanted && registered && wanted === registered) return true;
  if (registration.pid !== undefined && listener.pid !== undefined && registration.pid === listener.pid) return true;
  return false;
}

/**
 * When the managed service is not aimed at this agent's host and port, explain
 * the commands the user must run. This does not change the config.
 * Returns undefined when hostname and port already match.
 */
export function serviceEndpointMismatch(config: ServiceEndpointConfig, host: string, port: number, file: string): string | undefined {
  const hostOk = config.hostname !== undefined && config.hostname.toLowerCase() === host.toLowerCase();
  const portOk = config.port === port;
  if (hostOk && portOk) return undefined;
  const shownHost = config.hostname ?? "(unset)";
  const shownPort = config.port === undefined ? "(unset)" : String(config.port);
  const lines = [
    `OpenCode's managed service (${file}) is ${shownHost}:${shownPort}, and this agent uses ${host}:${port}.`,
    "grokcode will not change that config and will not stop or restart the service.",
    "Run these yourself, then call start_opencode again:",
  ];
  if (!hostOk) lines.push(`  opencode service set hostname ${host}`);
  if (!portOk) lines.push(`  opencode service set port ${port}`);
  lines.push("  opencode service set password <the OPENCODE_PASSWORD this agent uses>");
  lines.push("  opencode service start");
  lines.push("`opencode service set` stops a running service. Run it only when you mean to reconfigure.");
  return lines.join("\n");
}

export function assertServiceEndpoint(
  home: string | undefined,
  env: NodeJS.ProcessEnv,
  host: string,
  port: number,
  readText?: (file: string) => string | undefined,
): void {
  if (!home) {
    throw new ToolError(
      "Cannot check OpenCode's managed service config because no home directory is set (HOME or USERPROFILE).",
      "opencode_service_config",
    );
  }
  const file = openCodeServiceConfigPath(home, env);
  const message = serviceEndpointMismatch(readServiceEndpoint(home, env, readText), host, port, file);
  if (message) throw new ToolError(message, "opencode_service_config");
}

function safeRead(file: string, readText: (file: string) => string | undefined): string | undefined {
  try {
    return readText(file);
  } catch {
    return undefined;
  }
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text || text.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asPort(value: unknown): number | undefined {
  const port = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : undefined;
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

function endpointKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return undefined;
  }
}
