import assert from "node:assert/strict";
import test from "node:test";

import { assessOpenCode, ensureOpenCode, type PidRecord } from "../src/ownership.ts";
import type { SuperviseOptions, SupervisedProcess } from "../src/supervisor.ts";

const host = "127.0.0.1";

test("auto attaches to a foreign server only when the password is accepted", () => {
  const foreign = assessOpenCode({
    mode: "auto",
    host,
    port: 4096,
    listenerPid: 77,
    probe: "up",
    recordAlive: false,
  });
  assert.equal(foreign.type, "attach");
  if (foreign.type === "attach") {
    assert.equal(foreign.owned, false);
    assert.match(foreign.message, /did not start it/);
    assert.match(foreign.message, /Password accepted/);
  }

  const rejected = assessOpenCode({
    mode: "auto",
    host,
    port: 4096,
    listenerPid: 77,
    probe: "unauthorized",
    recordAlive: false,
  });
  assert.equal(rejected.type, "spawn-next");
  if (rejected.type === "spawn-next") assert.match(rejected.message, /rejected OPENCODE_PASSWORD/);
});

test("spawn replaces a foreign server unless asked to move, and reuses one this agent started", () => {
  const replace = assessOpenCode({
    mode: "spawn",
    host,
    port: 4096,
    listenerPid: 77,
    probe: "up",
    recordAlive: false,
  });
  assert.equal(replace.type, "replace");

  const move = assessOpenCode({
    mode: "spawn",
    onForeign: "next-port",
    host,
    port: 4096,
    listenerPid: 77,
    probe: "up",
    recordAlive: false,
  });
  assert.equal(move.type, "spawn-next");

  const record: PidRecord = { listenerPid: 77, spawnPid: 70, host, port: 4096 };
  const ours = assessOpenCode({
    mode: "spawn",
    host,
    port: 4096,
    listenerPid: 77,
    probe: "up",
    record,
    recordAlive: true,
  });
  assert.equal(ours.type, "attach");
  if (ours.type === "attach") assert.equal(ours.owned, true);
});

test("attach never kills and waits when OpenCode is down or rejects the password", () => {
  const ok = assessOpenCode({ mode: "attach", host, port: 4096, listenerPid: 9, probe: "up", recordAlive: false });
  assert.equal(ok.type, "attach");
  if (ok.type === "attach") assert.equal(ok.owned, false);
  const down = assessOpenCode({ mode: "attach", host, port: 4096, probe: "down", recordAlive: false });
  assert.equal(down.type, "wait");
  const denied = assessOpenCode({
    mode: "attach",
    onForeign: "replace",
    host,
    port: 4096,
    listenerPid: 9,
    probe: "unauthorized",
    recordAlive: false,
  });
  assert.equal(denied.type, "wait");
  if (denied.type === "wait") assert.match(denied.message, /rejected OPENCODE_PASSWORD/);
});

test("ensureOpenCode spawns when the port is free and does not kill an accepted foreign server", async () => {
  const spawned: SuperviseOptions[] = [];
  const killed: number[] = [];
  let pidFile: PidRecord | undefined;
  const supervise = async (options: SuperviseOptions): Promise<SupervisedProcess> => {
    spawned.push(options);
    await options.onReady?.({ spawnPid: 50 });
    return { password: () => options.password ?? "generated", pid: () => 50, stop: async () => {} };
  };

  const started = await ensureOpenCode({
    mode: "auto",
    host,
    port: 4096,
    command: "opencode",
    env: {},
    signal: new AbortController().signal,
    verbose: false,
    pidFile: "/tmp/unused",
    log: () => {},
    deps: {
      probe: async () => "down",
      listeningPid: async () => undefined,
      portBusy: async () => false,
      killPid: async (pid) => {
        killed.push(pid);
      },
      readPidFile: () => pidFile,
      writePidFile: (record) => {
        pidFile = record;
      },
      clearPidFile: () => {
        pidFile = undefined;
      },
      supervise,
      sleep: async () => {},
      alive: () => false,
    },
  });
  assert.equal(started.baseUrl, "http://127.0.0.1:4096");
  assert.equal(started.owned, true);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]?.args, ["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
  assert.equal(pidFile?.spawnPid, 50);
  await started.stop();
  assert.equal(pidFile, undefined);

  const attached = await ensureOpenCode({
    mode: "auto",
    host,
    port: 4096,
    command: "opencode",
    password: "pw",
    env: {},
    signal: new AbortController().signal,
    verbose: false,
    pidFile: "/tmp/unused",
    log: () => {},
    deps: {
      probe: async () => "up",
      listeningPid: async () => 77,
      portBusy: async () => true,
      killPid: async (pid) => {
        killed.push(pid);
      },
      readPidFile: () => undefined,
      writePidFile: () => {},
      clearPidFile: () => {},
      supervise,
      sleep: async () => {},
      alive: () => false,
    },
  });
  assert.equal(attached.owned, false);
  assert.equal(spawned.length, 1);
  assert.deepEqual(killed, []);
  await attached.stop();
});

function deps(over: Record<string, unknown> = {}) {
  const killed: number[] = [];
  const spawned: SuperviseOptions[] = [];
  const base = {
    probe: async () => "down" as const,
    listeningPid: async () => undefined as number | undefined,
    portBusy: async () => false,
    killPid: async (pid: number) => {
      killed.push(pid);
    },
    readPidFile: () => undefined as PidRecord | undefined,
    writePidFile: () => {},
    clearPidFile: () => {},
    supervise: async (options: SuperviseOptions): Promise<SupervisedProcess> => {
      spawned.push(options);
      return { password: () => "generated", pid: () => 50, stop: async () => {} };
    },
    sleep: async () => {},
    alive: () => false,
    killed,
    spawned,
  };
  return { ...base, ...over, killed, spawned };
}

test("attach waits without spawning and does not kill OpenCode when the agent stops", async () => {
  const harness = deps({
    probe: async () => "up" as const,
    listeningPid: async () => 77,
    alive: () => true,
  });
  const running = await ensureOpenCode({
    mode: "attach",
    host,
    port: 4096,
    command: "opencode",
    env: {},
    signal: new AbortController().signal,
    verbose: false,
    pidFile: "/tmp/unused",
    log: () => {},
    deps: harness,
  });
  assert.equal(running.owned, false);
  assert.equal(harness.spawned.length, 0);
  await running.stop();
  assert.deepEqual(harness.killed, []);

  const quiet = deps();
  const down = await ensureOpenCode({
    mode: "attach",
    host,
    port: 4096,
    command: "opencode",
    env: {},
    signal: new AbortController().signal,
    verbose: false,
    pidFile: "/tmp/unused",
    log: () => {},
    deps: quiet,
  });
  assert.equal(down.owned, false);
  assert.equal(down.baseUrl, "http://127.0.0.1:4096");
  await down.stop();
  assert.deepEqual(quiet.killed, []);
  assert.equal(quiet.spawned.length, 0);
});

test("attach mode never reaches spawnAt even if a pid file and replace policy are set", async () => {
  const harness = deps({
    probe: async () => "down" as const,
    listeningPid: async () => 77,
    portBusy: async () => true,
    readPidFile: () => ({ listenerPid: 77, spawnPid: 70, host, port: 4096 }),
    alive: () => true,
    supervise: async () => {
      throw new Error("spawnAt was called");
    },
  });
  const ensured = await ensureOpenCode({
    mode: "attach",
    onForeign: "replace",
    host,
    port: 4096,
    command: "opencode",
    env: {},
    signal: new AbortController().signal,
    verbose: false,
    pidFile: "/tmp/unused",
    log: () => {},
    deps: harness,
  });
  assert.equal(ensured.owned, false);
  assert.equal(ensured.baseUrl, "http://127.0.0.1:4096");
  await ensured.stop();
  assert.deepEqual(harness.killed, []);
});

test("a server started on request is not killed when the agent exits", async () => {
  const record: PidRecord = { listenerPid: 77, spawnPid: 70, host, port: 4096, detached: true };
  const harness = deps({
    probe: async () => "up" as const,
    listeningPid: async () => 77,
    readPidFile: () => record,
    alive: () => true,
  });
  const ensured = await ensureOpenCode({
    mode: "spawn",
    host,
    port: 4096,
    command: "opencode",
    env: {},
    signal: new AbortController().signal,
    verbose: false,
    pidFile: "/tmp/unused",
    log: () => {},
    deps: harness,
  });
  assert.equal(ensured.owned, false);
  await ensured.stop();
  assert.deepEqual(harness.killed, []);
  assert.equal(harness.spawned.length, 0);
});
