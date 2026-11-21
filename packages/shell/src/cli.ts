#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { parseArgs } from "node:util";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { detectPlatform } from "grokcode-shared";

import { createShellRuntime, policyFromFile } from "./execute.js";
import { createFrameParser, encodeFrame, handleStdioMessage, localBackend } from "./stdio.js";

const VERSION = "0.1.0";

export const HELP = `grokcode-shell — local stdio MCP server for the Antigravity CLI

Speaks MCP over stdin/stdout (Content-Length frames, or one JSON object per line).
The same tools are available remotely at https://<worker>/gemini/mcp.

  grokcode-shell --policy ~/.config/grokcode/policy.json --name expinsider

Options:
  --policy <file>   Policy JSON. Defaults to GROKCODE_SHELL_POLICY, then
                    ~/.config/grokcode/policy.json
  --name <name>     Machine name reported by list_machines. Default: local,
                    or GROKCODE_MACHINE_NAME
  --help
  --version

The process denies every command and file path until a policy with roots is loaded.
Run it as a normal user, not an administrator or root.
`;

export interface StdioIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

function homeFrom(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || "/";
}

function defaultPolicy(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.GROKCODE_SHELL_POLICY?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homeFrom(env), ".config", "grokcode", "policy.json");
}

export async function runStdio(argv: string[], env: NodeJS.ProcessEnv, io: StdioIo): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      policy: { type: "string" },
      name: { type: "string" },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (parsed.values.help) {
    io.stderr.write(HELP);
    return 0;
  }
  if (parsed.values.version) {
    io.stderr.write(`${VERSION}\n`);
    return 0;
  }
  const platform = detectPlatform();
  const home = homeFrom(env);
  const policyPath = parsed.values.policy ?? defaultPolicy(env);
  const name = parsed.values.name ?? (env.GROKCODE_MACHINE_NAME?.trim() || "local");
  const runtime = createShellRuntime({
    platform,
    home,
    loadPolicy: () => policyFromFile(policyPath, platform, home),
    auditPath: path.join(path.dirname(policyPath), "shell-audit.log"),
  });
  const backend = localBackend(name, runtime);
  io.stderr.write(`grokcode-shell ${VERSION} as ${name}. Policy ${policyPath}.\n`);
  const parser = createFrameParser(
    (message) => {
      void handleStdioMessage(message, backend)
        .then((response) => {
          if (response !== undefined) io.stdout.write(encodeFrame(response));
        })
        .catch((err: unknown) => {
          io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        });
    },
    (err) => io.stderr.write(`${err.message}\n`),
  );
  io.stdin.on("data", (chunk: Buffer | string) => {
    parser(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  await new Promise<void>((resolve) => {
    io.stdin.on("end", () => resolve());
    io.stdin.on("close", () => resolve());
  });
  runtime.killAll();
  return 0;
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runStdio(process.argv.slice(2), process.env, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
