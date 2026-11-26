import type { ShellTool } from "./tools.js";

export const CODE_READ_OPS = {
  read_file: "shell_read_file",
  list_dir: "shell_list_dir",
  search_files: "shell_search_files",
} as const;

const machine = { type: "string", description: "Machine returned by execute. Optional when only one machine is online." };
const executionId = { type: "string", description: "Execution ID returned by execute." };

export const CODE_TOOLS: ShellTool[] = [
  {
    name: "execute",
    op: "shell_code_execute",
    description: "Run a JavaScript async function body with read-only tools.read_file, tools.list_dir and tools.search_files. Use return to return JSON. No direct file, network or timer access. Returns an execution ID that can be polled or cancelled.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { machine, code: { type: "string", maxLength: 8192 }, wait: { type: "boolean" } }, required: ["code"], additionalProperties: false },
  },
  {
    name: "poll_execution",
    op: "shell_code_poll",
    description: "Wait for a read-only code execution and return its state and result. Set wait to false for an immediate snapshot.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { machine, executionId, wait: { type: "boolean" } }, required: ["executionId"], additionalProperties: false },
  },
  {
    name: "cancel_execution",
    op: "shell_code_cancel",
    description: "Cancel a read-only code execution started by this OAuth client.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { machine, executionId }, required: ["executionId"], additionalProperties: false },
  },
];
