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

test("attach never kills and fails closed when the password is rejected", () => {
  const ok = assessOpenCode({ mode: "attach", host, port: 4096, listenerPid: 9, probe: "up", recordAlive: false });
  assert.equal(ok.type, "attach");
  const down = assessOpenCode({ mode: "attach", host, port: 4096, probe: "down", recordAlive: false });
  assert.equal(down.type, "fail");
  const denied = assessOpenCode({
    mode: "attach",
    onForeign: "replace",
    host,
    port: 4096,
    listenerPid: 9,
    probe: "unauthorized",
    recordAlive: false,
  });
  assert.equal(denied.type, "fail");
  if (denied.type === "fail") assert.match(denied.message, /rejected OPENCODE_PASSWORD/);
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
