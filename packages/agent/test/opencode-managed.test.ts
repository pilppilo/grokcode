import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ToolError } from "grokcode-shared";

import { launchDetached, serviceStartLaunch, type SpawnLike } from "../src/launch.ts";
import {
  isManagedService,
  openCodeServiceConfigPath,
  parseServiceConfigText,
  parseServiceStateText,
  serviceEndpointMismatch,
} from "../src/opencode-managed.ts";
import { createOpenCodeService } from "../src/service.ts";

const SECRET = "service-password-should-not-appear";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("service config and state parses drop the password", () => {
  const config = parseServiceConfigText(JSON.stringify({ hostname: "127.0.0.1", port: "4096", password: SECRET }));
  const state = parseServiceStateText(JSON.stringify({ url: "http://127.0.0.1:4096", pid: 42, password: SECRET }));
  assert.deepEqual(config, { hostname: "127.0.0.1", port: 4096 });
  assert.deepEqual(state, { url: "http://127.0.0.1:4096", pid: 42 });
  assert.equal(JSON.stringify({ config, state }).includes(SECRET), false);
  assert.equal(serviceEndpointMismatch(config, "127.0.0.1", 4096, "service.json"), undefined);
});

test("a mismatched managed service names the set commands and does not include the password", () => {
  const message = serviceEndpointMismatch(
    parseServiceConfigText(JSON.stringify({ hostname: "127.0.0.1", port: 28894, password: SECRET })),
    "127.0.0.1",
    4096,
    "/home/ada/.config/opencode/service.json",
  );
  assert.match(message ?? "", /opencode service set port 4096/);
  assert.match(message ?? "", /opencode service set password <the OPENCODE_PASSWORD this agent uses>/);
  assert.doesNotMatch(message ?? "", /opencode service set hostname/);
  assert.equal((message ?? "").includes(SECRET), false);

  const missing = serviceEndpointMismatch({}, "127.0.0.1", 4096, "service.json");
  assert.match(missing ?? "", /opencode service set hostname 127.0.0.1/);
  assert.match(missing ?? "", /opencode service set port 4096/);
  assert.deepEqual(parseServiceConfigText("{not json"), {});
});

test("managedService matches the registered url or pid", () => {
  const registration = { url: "http://127.0.0.1:4096/", pid: 42 };
  assert.equal(isManagedService(registration, { url: "http://127.0.0.1:4096", pid: 99 }), true);
  assert.equal(isManagedService({ url: "http://127.0.0.1:28894", pid: 42 }, { url: "http://127.0.0.1:4096", pid: 42 }), true);
  assert.equal(isManagedService({ url: "http://127.0.0.1:28894", pid: 7 }, { url: "http://127.0.0.1:4096", pid: 42 }), false);
  assert.equal(isManagedService({}, { url: "http://127.0.0.1:4096" }), false);
});

test("start_opencode runs opencode service start when the managed config matches", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "grokcode-managed-"));
  const configFile = openCodeServiceConfigPath(home, {});
  const stateFile = path.join(home, ".local", "state", "opencode", "service.json");
  const files: Record<string, string> = {
    [configFile]: JSON.stringify({ hostname: "127.0.0.1", port: 4096, password: SECRET }),
    [stateFile]: JSON.stringify({ url: "http://127.0.0.1:4096", pid: 42, password: SECRET }),
  };
  const launched: Array<{ command: string; args: string[]; cwd?: string }> = [];
  let probes = 0;
  const service = createOpenCodeService({
    baseUrl: "http://127.0.0.1:4096",
    host: "127.0.0.1",
    port: 4096,
    command: "opencode",
    username: "opencode",
    password: "agent-secret",
    env: { HOME: home },
    home,
    launchMode: "service",
    pidFile: path.join(home, "opencode.pid"),
    signal: new AbortController().signal,
    log: () => {},
    readText: (file) => files[file],
    launch: (spec) => {
      launched.push({ command: spec.command, args: spec.args, ...(spec.cwd ? { cwd: spec.cwd } : {}) });
      return { pid: 7 };
    },
    probe: async () => {
      probes += 1;
      return probes < 3 ? "down" : "up";
    },
    detect: async () => ({ version: "2.3.0", api: "v2" }),
    identify: async () => ({ version: "2.3.0", api: "v2" }),
    listeningPid: async () => 42,
    sleep: async () => {},
  });

  const started = await service.control.start("/work/longcat");
  assert.equal(launched.length, 1);
  assert.equal(launched[0]?.command, "opencode");
  assert.deepEqual(launched[0]?.args, ["service", "start"]);
  assert.equal(launched[0]?.cwd, "/work/longcat");
  assert.equal(started.reachable, true);
  assert.equal(started.started, true);
  assert.equal(started.managedService, true);
  assert.equal(started.version, "2.3.0");
  assert.equal(JSON.stringify(started).includes(SECRET), false);
  assert.equal(JSON.stringify(started).includes("agent-secret"), false);

  const status = await service.control.status();
  assert.equal(status.managedService, true);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});

test("start_opencode refuses a managed service on a different port and does not launch", async () => {
  const home = "/home/ada";
  let launches = 0;
  const service = createOpenCodeService({
    baseUrl: "http://127.0.0.1:4096",
    host: "127.0.0.1",
    port: 4096,
    command: "opencode",
    username: "opencode",
    env: { HOME: home },
    home,
    pidFile: path.join(home, "opencode.pid"),
    signal: new AbortController().signal,
    log: () => {},
    readText: () => JSON.stringify({ hostname: "127.0.0.1", port: 28894, password: SECRET }),
    launch: () => {
      launches += 1;
      return { pid: 1 };
    },
    probe: async () => "down",
    sleep: async () => {},
  });
  await assert.rejects(service.control.start(), (err: unknown) => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, "opencode_service_config");
    assert.match(err.message, /opencode service set port 4096/);
    assert.equal(err.message.includes(SECRET), false);
    return true;
  });
  assert.equal(launches, 0);
});

test("GROKCODE_OPENCODE_LAUNCH=serve still starts a standalone server", async () => {
  const launched: string[][] = [];
  let probes = 0;
  const service = createOpenCodeService({
    baseUrl: "http://127.0.0.1:4096",
    host: "127.0.0.1",
    port: 4096,
    command: "opencode",
    username: "opencode",
    env: {},
    launchMode: "serve",
    pidFile: "/tmp/grokcode-serve-pid",
    signal: new AbortController().signal,
    log: () => {},
    readText: () => {
      throw new Error("serve mode must not read the service config");
    },
    launch: (spec) => {
      launched.push([spec.command, ...spec.args]);
      return { pid: 9 };
    },
    probe: async () => {
      probes += 1;
      return probes < 3 ? "down" : "up";
    },
    identify: async () => ({ api: "v2" }),
    listeningPid: async () => undefined,
    sleep: async () => {},
  });
  const started = await service.control.start();
  assert.deepEqual(launched, [["opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096"]]);
  assert.equal(started.started, true);
  assert.equal(started.reachable, true);
  assert.equal(started.managedService, false);
});

test("opencode_status reports managedService false when the registration is a different server", async () => {
  const home = "/home/ada";
  const service = createOpenCodeService({
    baseUrl: "http://127.0.0.1:4096",
    host: "127.0.0.1",
    port: 4096,
    command: "opencode",
    username: "opencode",
    env: {},
    home,
    pidFile: path.join(home, "missing.pid"),
    signal: new AbortController().signal,
    log: () => {},
    readText: (file) =>
      file.includes(`${path.sep}.local${path.sep}state${path.sep}`)
        ? JSON.stringify({ url: "http://127.0.0.1:28894", pid: 8, password: SECRET })
        : undefined,
    detect: async () => ({ version: "2.3.0", api: "v2" }),
    listeningPid: async () => 42,
    sleep: async () => {},
  });
  const status = await service.control.status();
  assert.equal(status.reachable, true);
  assert.equal(status.managedService, false);
  assert.equal(JSON.stringify(status).includes(SECRET), false);

  const down = createOpenCodeService({
    baseUrl: "http://127.0.0.1:9",
    host: "127.0.0.1",
    port: 9,
    command: "opencode",
    username: "opencode",
    env: {},
    home,
    pidFile: path.join(home, "missing.pid"),
    signal: new AbortController().signal,
    log: () => {},
    detect: async () => {
      throw new Error("down");
    },
    listeningPid: async () => undefined,
    sleep: async () => {},
  });
  const unreachable = await down.control.status();
  assert.equal(unreachable.reachable, false);
  assert.equal(unreachable.managedService, undefined);
});

test("Windows service start uses the resolved executable and does not wait", async () => {
  const exe = "C:\\npm\\opencode.exe";
  let script = "";
  const spawnImpl: SpawnLike = (_command, args) => {
    script = String(args[args.length - 1] ?? "");
    return {
      pid: 3,
      stdout: {
        on(_event: string, listener: (chunk: Buffer) => void) {
          listener(Buffer.from("3\n"));
        },
      },
      stderr: { on() {} },
      once(event, listener) {
        if (event === "exit") (listener as (code: number) => void)(0);
      },
    };
  };
  const spec = serviceStartLaunch("opencode", { PATH: "C:\\npm" }, "C:\\work\\longcat");
  const launched = await launchDetached({
    ...spec,
    platform: "win32",
    exists: (file) => file.toLowerCase() === exe.toLowerCase(),
    spawnImpl,
  });
  assert.equal(launched.pid, 3);
  assert.match(script, /opencode\.exe/);
  assert.match(script, /'service'/);
  assert.match(script, /'start'/);
  assert.match(script, /WorkingDirectory/);
  assert.match(script, /C:\\work\\longcat/);
  assert.doesNotMatch(script, /-Wait/);
});

test("installers print the one-time service setup and do not run it", () => {
  for (const file of ["deploy/install.sh", "deploy/install-windows.ps1"]) {
    const text = readFileSync(path.join(root, file), "utf8");
    assert.match(text, /This installer does not run these commands/);
    assert.match(text, /opencode service set hostname 127\.0\.0\.1/);
    assert.match(text, /opencode service set port 4096/);
    assert.match(text, /opencode service set password <the OPENCODE_PASSWORD/);
    assert.match(text, /opencode service start/);
    assert.equal(/^\s*opencode service /m.test(text), false);
  }
});
