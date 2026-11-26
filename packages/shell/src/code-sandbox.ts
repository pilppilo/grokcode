import { setImmediate } from "node:timers/promises";
import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import { errorCode, ToolError } from "grokcode-shared";

import { CODE_READ_OPS } from "./code-tools.js";

type ReadOp = (typeof CODE_READ_OPS)[keyof typeof CODE_READ_OPS];
export type CodeRead = (op: ReadOp, args: unknown, signal: AbortSignal) => Promise<unknown>;

export async function runCode(code: string, read: CodeRead, signal: AbortSignal): Promise<unknown> {
  const quickjs = await getQuickJS();
  signal.throwIfAborted();
  const vm = quickjs.newRuntime();
  vm.setMemoryLimit(8 * 1024 * 1024);
  vm.setMaxStackSize(256 * 1024);
  let cpuRemaining = 1_000;
  let deadline = 0;
  vm.setInterruptHandler(() => signal.aborted || performance.now() >= deadline);
  const ctx = vm.newContext();
  const handles: QuickJSHandle[] = [];
  const pending = new Map<QuickJSDeferredPromise, Promise<void>>();
  let calls = 0;
  let received = 0;
  let closed = false;
  let notifyAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { notifyAbort = resolve; });
  signal.addEventListener("abort", notifyAbort, { once: true });

  const run = <T>(operation: () => T): T => {
    signal.throwIfAborted();
    if (cpuRemaining <= 0) throw new ToolError("Code execution exceeded its CPU budget.", "code_limit");
    const start = performance.now();
    deadline = start + Math.min(100, cpuRemaining);
    try {
      return operation();
    } finally {
      cpuRemaining -= performance.now() - start;
    }
  };

  const checked = (result: ReturnType<typeof ctx.evalCode>): QuickJSHandle => {
    if (result.error) {
      result.error.dispose();
      throw new ToolError("The script failed or exceeded a sandbox limit.", "code_failed");
    }
    return result.value;
  };

  try {
    for (const [name, op] of Object.entries(CODE_READ_OPS)) {
      const bridge = ctx.newFunction(name, (args) => {
        if (signal.aborted || ++calls > 32 || pending.size >= 4 || ctx.typeof(args) !== "string") {
          throw new Error("Nested read budget exceeded or invalid arguments.");
        }
        const encoded = ctx.getString(args);
        if (Buffer.byteLength(encoded) > 8_192) throw new Error("Nested arguments exceed 8 KiB.");
        const input: unknown = JSON.parse(encoded);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an arguments object.");
        const deferred = ctx.newPromise();
        const work = Promise.resolve().then(async () => {
          let packet: string;
          try {
            if (closed) return;
            signal.throwIfAborted();
            const result = await read(op, input, signal);
            packet = JSON.stringify({ result });
            received += Buffer.byteLength(packet);
            if (received > 512 * 1024) throw new ToolError("Nested output budget exceeded.", "code_limit");
          } catch (error) {
            packet = JSON.stringify({ error: errorCode(error) });
          }
          if (closed || signal.aborted) return;
          const value = ctx.newString(packet);
          try { deferred.resolve(value); } finally { value.dispose(); }
        }).finally(() => {
          deferred.dispose();
          pending.delete(deferred);
        });
        // A runtime allocation failure should surface through the main execution loop.
        void work.catch(() => {});
        pending.set(deferred, work);
        return deferred.handle;
      });
      try { ctx.setProp(ctx.global, name, bridge); } finally { bridge.dispose(); }
    }

    const serialize = checked(run(() => ctx.evalCode(`
      (() => {
        const stringify = JSON.stringify;
        const parse = JSON.parse;
        const tools = Object.create(null);
        for (const name of ${JSON.stringify(Object.keys(CODE_READ_OPS))}) {
          const call = globalThis[name];
          delete globalThis[name];
          tools[name] = async (args) => {
            const reply = parse(await call(stringify(args)));
            if (reply.error) throw new Error(reply.error);
            return reply.result;
          };
        }
        Object.defineProperty(globalThis, "tools", { value: Object.freeze(tools) });
        delete globalThis.Date;
        delete globalThis.Temporal;
        return (result) => stringify(result ?? null);
      })()
    `)));
    handles.push(serialize);
    const result = checked(run(() => ctx.evalCode(`(async () => {\n${code}\n})()`, "code-mode.js", { type: "global" })));
    handles.push(result);

    for (;;) {
      const drained = run(() => vm.executePendingJobs(64));
      if (drained.error) {
        drained.error.dispose();
        throw new ToolError("The script failed or exceeded a sandbox limit.", "code_failed");
      }
      const state = ctx.getPromiseState(result);
      if (state.type === "rejected") {
        state.error.dispose();
        throw new ToolError("The script rejected. Check the code and nested tool arguments.", "code_failed");
      }
      if (state.type === "fulfilled") {
        if (!state.notAPromise) handles.push(state.value);
        const encoded = checked(run(() => ctx.callFunction(serialize, ctx.undefined, state.value)));
        handles.push(encoded);
        if (ctx.typeof(encoded) !== "string") throw new ToolError("Return a JSON value.", "code_failed");
        const json = ctx.getString(encoded);
        if (Buffer.byteLength(json) > 32 * 1024) throw new ToolError("Result exceeds 32 KiB.", "code_limit");
        return JSON.parse(json);
      }
      if (vm.hasPendingJob()) {
        await setImmediate();
      } else if (pending.size) {
        await Promise.race([...pending.values(), aborted]);
      } else {
        throw new ToolError("The script awaits a promise that cannot resolve.", "code_failed");
      }
      signal.throwIfAborted();
    }
  } finally {
    closed = true;
    signal.removeEventListener("abort", notifyAbort);
    for (const deferred of pending.keys()) deferred.dispose();
    for (const handle of handles.reverse()) handle.dispose();
    ctx.dispose();
    vm.dispose();
  }
}
