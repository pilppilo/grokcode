import { ToolError, detectOpenCode, type OpenCodeClient, type OpenCodeControl, type OpenCodeStatus } from "grokcode-shared";

import { START_OPENCODE_READY_MS, launchDetached, requestOpenCode, serveLaunch } from "./launch.js";
import { readPidRecord, writePidRecord } from "./ownership.js";
import { isPidAlive, listeningPid } from "./ports.js";
import { probeOpenCode, type ProbeResult } from "./supervisor.js";

export interface OpenCodeServiceOptions {
  baseUrl: string;
  host: string;
  port: number;
  command: string;
  username: string;
  password?: string;
  env: NodeJS.ProcessEnv;
  pidFile: string;
  signal: AbortSignal;
  log: (line: string) => void;
  /** Test hook. Production uses a detached Start-Process / unref'd child. */
  launch?: () => Promise<{ pid?: number }> | { pid?: number };
  probe?: () => Promise<ProbeResult>;
  identify?: () => Promise<{ version?: string; api?: "v1" | "v2" } | undefined>;
  listeningPid?: () => Promise<number | undefined>;
  sleep?: (ms: number) => Promise<void>;
}

export interface OpenCodeService {
  control: OpenCodeControl;
  getClient: () => Promise<OpenCodeClient>;
  /** Retry the HTTP connection with backoff. Does not start or stop a server. */
  watch: () => void;
}

export function createOpenCodeService(options: OpenCodeServiceOptions): OpenCodeService {
  const auth = {
    username: options.username,
    ...(options.password ? { password: options.password } : {}),
  };
  let current: OpenCodeClient | undefined;
  let inflight: Promise<OpenCodeClient> | undefined;
  let lastError = "OpenCode is not reachable.";
  let watching = false;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const connect = (): Promise<OpenCodeClient> => {
    if (inflight) return inflight;
    inflight = detectOpenCode({ baseUrl: options.baseUrl, auth, timeoutMs: 4_000 })
      .then((client) => {
        current = client;
        return client;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  const getClient = async (): Promise<OpenCodeClient> => {
    if (current) return current;
    if (inflight) {
      try {
        return await inflight;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new ToolError(
      `OpenCode is unavailable at ${options.baseUrl}. ${lastError} The agent will keep retrying and will not start a server unless start_opencode is called.`,
      "opencode_unavailable",
    );
  };

  const watch = () => {
    if (watching) return;
    watching = true;
    let delay = 1_000;
    const loop = async () => {
      while (!options.signal.aborted) {
        const wasDown = !current;
        try {
          await connect();
          delay = 1_000;
          if (wasDown) {
            const version = current?.version ? ` (${current.version})` : "";
            options.log(`OpenCode is reachable at ${options.baseUrl}${version}.`);
          }
          await sleep(5_000);
        } catch (err) {
          current = undefined;
          lastError = err instanceof Error ? err.message : String(err);
          if (options.signal.aborted) return;
          options.log(`OpenCode unavailable at ${options.baseUrl}. Retrying in ${Math.round(delay / 1000)}s.`);
          await sleep(delay);
          delay = Math.min(delay * 2, 30_000);
        }
      }
    };
    void loop();
  };

  const probe = options.probe ?? (() => probeOpenCode(options.baseUrl, auth));
  const identify =
    options.identify ??
    (async () => {
      try {
        const client = await detectOpenCode({ baseUrl: options.baseUrl, auth, timeoutMs: 4_000 });
        current = client;
        return { ...(client.version ? { version: client.version } : {}), api: client.api };
      } catch {
        return undefined;
      }
    });
  const pidOf = options.listeningPid ?? (() => listeningPid(options.host, options.port));

  const knownPid = async (): Promise<number | undefined> => {
    const heard = await pidOf();
    if (heard) return heard;
    const record = readPidRecord(options.pidFile);
    const recorded = record?.listenerPid ?? record?.spawnPid;
    return isPidAlive(recorded) ? recorded : undefined;
  };

  const control: OpenCodeControl = {
    async status(): Promise<OpenCodeStatus> {
      const pid = await knownPid();
      try {
        const client = await detectOpenCode({ baseUrl: options.baseUrl, auth, timeoutMs: 3_000 });
        current = client;
        return {
          reachable: true,
          url: options.baseUrl,
          ...(client.version ? { version: client.version } : {}),
          api: client.api,
          ...(pid ? { pid } : {}),
          started: false,
        };
      } catch {
        return { reachable: false, url: options.baseUrl, ...(pid ? { pid } : {}), started: false };
      }
    },
    async start(directory?: string): Promise<OpenCodeStatus> {
      const childEnv = { ...options.env };
      if (options.password) {
        childEnv.OPENCODE_PASSWORD = options.password;
        childEnv.OPENCODE_SERVER_PASSWORD = options.password;
      }
      const spec = serveLaunch(options.host, options.port, options.command, childEnv, directory);
      return requestOpenCode({
        host: options.host,
        port: options.port,
        signal: options.signal,
        probe,
        launch: options.launch ?? (() => launchDetached(spec)),
        identify,
        listeningPid: pidOf,
        writePid: (record) => writePidRecord(options.pidFile, record),
        sleep,
        readyTimeoutMs: START_OPENCODE_READY_MS,
      });
    },
  };

  return { control, getClient, watch };
}
