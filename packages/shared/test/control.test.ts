import assert from "node:assert/strict";
import test from "node:test";

import { executeOp, type OpenCodeControl } from "../src/executor.ts";

test("tools report OpenCode unavailable until start_opencode, which does not require a client", async () => {
  const control: OpenCodeControl = {
    status: async () => ({ reachable: false, url: "http://127.0.0.1:4096", started: false }),
    start: async (directory) => ({
      reachable: true,
      url: "http://127.0.0.1:4096",
      version: "2.2.1",
      api: "v2",
      pid: 42,
      started: directory == null,
    }),
  };
  await assert.rejects(
    () => executeOp({ opencodeControl: control }, "get_session", { sessionId: "ses_1" }),
    /opencode_unavailable|unavailable/,
  );
  const status = (await executeOp({ opencodeControl: control }, "opencode_status", {})) as { reachable: boolean };
  assert.equal(status.reachable, false);
  const started = (await executeOp({ opencodeControl: control }, "start_opencode", {})) as {
    started: boolean;
    pid: number;
    version: string;
  };
  assert.equal(started.started, true);
  assert.equal(started.pid, 42);
  assert.equal(started.version, "2.2.1");
  await assert.rejects(
    () => executeOp({ opencodeControl: control, allowDirs: ["/work"], platform: "posix", home: "/home/ada" }, "start_opencode", { directory: "/etc" }),
    /allowlist/,
  );
});