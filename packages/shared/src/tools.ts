import type { OpName } from "./protocol.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** When set, the tool is forwarded to a machine as this op. */
  op?: OpName;
}

const machine = {
  type: "string",
  description:
    "Machine name registered by a grokcode-agent. Required when more than one machine is online. In direct/Tailscale mode this defaults to the local machine.",
};

const sessionId = {
  type: "string",
  description: "OpenCode session id returned by start_session or list_sessions.",
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_machines",
    description:
      "List PCs currently connected to this MCP server. In Cloudflare relay mode this is every agent dialed into the relay. In direct mode it is only the local machine.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "server_info",
    description:
      "Read OpenCode server health, API generation (v1 or v2), version, and the agent default model on a machine. defaultModel is null when that PC has no GROKCODE_DEFAULT_MODEL.",
    op: "server_info",
    inputSchema: { type: "object", properties: { machine }, required: [] },
  },
  {
    name: "list_projects",
    description: "List projects known to OpenCode on a machine.",
    op: "list_projects",
    inputSchema: { type: "object", properties: { machine } },
  },
  {
    name: "list_sessions",
    description: "List OpenCode sessions, optionally filtered by absolute project directory.",
    op: "list_sessions",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        directory: { type: "string", description: "Absolute project directory. Optional." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        search: { type: "string" },
      },
    },
  },
  {
    name: "start_session",
    description:
      "Create an OpenCode session for an absolute working directory. Optional model is `provider/model` (for example `opencode-go/deepseek-v4.1-flash`). When model is omitted, the agent uses that PC's GROKCODE_DEFAULT_MODEL if one is set. Optional agent is the OpenCode agent id (for example `build`).",
    op: "start_session",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        directory: { type: "string", description: "Absolute working directory on that PC." },
        title: { type: "string" },
        agent: { type: "string" },
        model: { type: "string", description: "provider/model id." },
      },
      required: ["directory"],
    },
  },
  {
    name: "send_prompt",
    description:
      "Send a user prompt to a session. OpenCode v2 admits the prompt and runs it in the background; v1 uses prompt_async. Default is async: the call returns as soon as the prompt is accepted. Set wait=true to poll until the session is idle, needs permission, or the sync budget (about 20s) runs out — then poll get_session / get_messages. Do not expect this tool to block for a multi-minute agent turn.",
    op: "send_prompt",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        text: { type: "string" },
        agent: { type: "string" },
        model: { type: "string", description: "provider/model id, applied before the prompt." },
        wait: { type: "boolean", description: "Poll until idle, permission, or the sync budget. Default false." },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: 25000,
          description: "Cap for wait=true. Clamped to the server sync budget (default 20000).",
        },
      },
      required: ["sessionId", "text"],
    },
  },
  {
    name: "wait_session",
    description:
      "Poll a session until it is idle, a permission is pending, or the sync budget expires. Use after send_prompt wait=false. Returns status running when the budget expires; call again or use get_messages.",
    op: "get_session",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        timeoutMs: { type: "integer", minimum: 0, maximum: 25000 },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_messages",
    description: "List messages in a session. Text is extracted from v1 parts and v2 message bodies. Large payloads are truncated.",
    op: "get_messages",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_session",
    description:
      "Get one session plus activity: idle, busy, or retry. On v2, busy means the session is in GET /api/session/active. On v1, busy means it appears in GET /session/status.",
    op: "get_session",
    inputSchema: { type: "object", properties: { machine, sessionId }, required: ["sessionId"] },
  },
  {
    name: "get_diff",
    description:
      "Get the file diff for a session. v2 diffs a turn (optional messageId selects the user message that starts it). v1 returns the session diff, optionally for one message.",
    op: "get_diff",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        messageId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "list_pending_permissions",
    description:
      "List permission requests OpenCode is waiting on. Pass sessionId to limit to one session. Approve or deny them with respond_permission before the agent can continue.",
    op: "list_pending_permissions",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId: { type: "string" },
        directory: { type: "string", description: "v2 location filter when sessionId is omitted." },
      },
    },
  },
  {
    name: "respond_permission",
    description:
      "Answer a pending OpenCode permission. decision: approve (once), once, always, deny, or reject. deny and reject stop the tool. always remembers the rule when OpenCode supports it.",
    op: "respond_permission",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        requestId: { type: "string" },
        decision: { type: "string", enum: ["approve", "once", "always", "deny", "reject"] },
        message: { type: "string", description: "Optional feedback shown to the model on reject." },
      },
      required: ["sessionId", "requestId", "decision"],
    },
  },
  {
    name: "abort",
    description: "Interrupt the active turn. v2 calls POST /api/session/:id/interrupt. v1 calls POST /session/:id/abort.",
    op: "abort",
    inputSchema: { type: "object", properties: { machine, sessionId }, required: ["sessionId"] },
  },
  {
    name: "list_agents",
    description: "List OpenCode agents available at a directory.",
    op: "list_agents",
    inputSchema: {
      type: "object",
      properties: { machine, directory: { type: "string" } },
    },
  },
  {
    name: "list_models",
    description: "List models the OpenCode server can use.",
    op: "list_models",
    inputSchema: {
      type: "object",
      properties: { machine, directory: { type: "string" } },
    },
  },
  {
    name: "run_command",
    description: "Run an OpenCode slash command in a session (v2 POST /command, v1 POST /session/:id/command).",
    op: "run_command",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        command: { type: "string", description: "Command name without the leading slash." },
        arguments: { type: "string" },
        agent: { type: "string" },
      },
      required: ["sessionId", "command"],
    },
  },
  {
    name: "list_forms",
    description:
      "List pending questions/forms OpenCode is waiting on (v2 forms, or the v1 question tool when that server exposes it).",
    op: "list_forms",
    inputSchema: {
      type: "object",
      properties: { machine, sessionId: { type: "string" }, directory: { type: "string" } },
    },
  },
  {
    name: "reply_form",
    description:
      "Answer a pending form. For v2, `answer` is the form answer JSON. For the v1 question tool, pass { answers: [[\"Yes\"]] }.",
    op: "reply_form",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        formId: { type: "string" },
        answer: { description: "Form answer JSON, or { answers: string[][] } for the v1 question tool." },
      },
      required: ["sessionId", "formId", "answer"],
    },
  },
  {
    name: "delete_session",
    description: "Delete an OpenCode session and its children.",
    op: "delete_session",
    inputSchema: { type: "object", properties: { machine, sessionId }, required: ["sessionId"] },
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
