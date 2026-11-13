import assert from "node:assert/strict";
import test from "node:test";

import { launchDetached, requestOpenCode, windowsStartScript, type SpawnLike } from "../src/launch.ts";
import type { PidRecord } from "../src/ownership.ts";
import { createOpenCodeService } from "../src/service.ts";

test("windows launcher uses Start-Process and does not wait", () => {
  const script = windowsStartScript("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4096"], "C:\\work");
  assert.match(script, /Start-Process/);
  assert.doesNotMatch(script, /-Wait/);
  assert.match(script, /WindowStyle Hidden/);
  assert.match(script, /4096/);
});

test("start_opencode is idempotent and an agent abort does not kill the process", async () => {
  let launches = 0;
  let up = false;
  const killed: number[] = [];
  let record: PidRecord | undefined;
  const ac = new AbortController();
  const deps = {
    host: "127.0.0.1",
    port: 4096,
    signal: ac.signal,
    probe: async () => (up ? "up" : "down") as "up" | "down",
    launch: async () => {
      launches += 1;
      up = true;
      return { pid: 4242 };
    },
    identify: async () => ({ version: "2.2.1", api: "v2" as const }),
    listeningPid: async () => 4242,
    writePid: (next: PidRecord) => {
      record = next;
    },
    sleep: async () => {},
  };

  const first = await requestOpenCode(deps);
  assert.equal(first.started, true);
  assert.equal(first.reachable, true);
  assert.equal(first.pid, 4242);
  assert.equal(first.version, "2.2.1");
  assert.equal(record?.detached, true);
  assert.equal(record?.spawnPid, 4242);

  const second = await requestOpenCode(deps);
  assert.equal(second.started, false);
  assert.equal(second.reachable, true);
  assert.equal(launches, 1);

  up = false;
  const aborting = new AbortController();
  let slept = 0;
  const left = await requestOpenCode({
    ...deps,
    signal: aborting.signal,
    launch: async () => {
      launches += 1;
      return { pid: 5252 };
    },
    sleep: async () => {
      slept += 1;
      aborting.abort();
    },
    readyTimeoutMs: 5_000,
  });
  assert.equal(left.reachable, false);
  assert.equal(left.started, true);
  assert.equal(left.pid, 5252);
  assert.equal(slept, 1);
  assert.deepEqual(killed, []);
  assert.equal(launches, 2);
});

test("detached spawn options are not tied to the agent process", async () => {
  const seen: { command: string; args: readonly string[]; detached?: boolean; stdio?: SpawnLike extends never ? never : unknown }[] = [];
  const spawnImpl: SpawnLike = (command, args, options) => {
    seen.push({ command, args, detached: options.detached, stdio: options.stdio });
    return { pid: 7, unref() {}, once() {} };
  };
  const launched = await launchDetached({
    command: "opencode",
    args: ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
    env: {},
    spawnImpl,
  });
  assert.equal(launched.pid, 7);
  assert.equal(seen[0]?.detached, true);
  assert.equal(seen[0]?.stdio, "ignore");
});

test("the service start does not register a kill on the agent signal", async () => {
  const ac = new AbortController();
  let launches = 0;
  const service = createOpenCodeService({
    baseUrl: "http://127.0.0.1:9",
    host: "127.0.0.1",
    port: 9,
    command: "opencode",
    username: "opencode",
    env: {},
    pidFile: "/tmp/grokcode-does-not-exist-pid",
    signal: ac.signal,
    log: () => {},
    probe: async () => "up",
    identify: async () => ({ version: "2.2.1", api: "v2" }),
    listeningPid: async () => 77,
    launch: async () => {
      launches += 1;
      return { pid: 77 };
    },
    sleep: async () => {},
  });
  const status = await service.control.status();
  assert.equal(status.reachable, false);
  const started = await service.control.start();
  assert.equal(started.started, false);
  assert.equal(launches, 0);
  ac.abort();
  assert.equal(launches, 0);
});