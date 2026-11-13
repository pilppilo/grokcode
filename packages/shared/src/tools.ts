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
    name: "opencode_status",
    description:
      "Read whether opencode serve is reachable on this machine. Returns reachable, url, version, and pid when one is known. Does not start or stop OpenCode.",
    op: "opencode_status",
    inputSchema: { type: "object", properties: { machine }, required: [] },
  },
  {
    name: "start_opencode",
    description:
      "Start opencode serve on this machine's configured host and port. only call when the user explicitly asks to open/start OpenCode. If a server is already reachable, return its status and do not start another. The process is detached: the agent will not stop it on exit. There is no stop or restart tool.",
    op: "start_opencode",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        directory: {
          type: "string",
          description: "Optional absolute working directory for the new server. Ignored when a server is already reachable.",
        },
      },
      required: [],
    },
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
      "Send a user prompt to a session. OpenCode v2 admits the prompt and runs it in the background; v1 uses prompt_async. Default is async: the call returns as soon as the prompt is accepted. Set wait=true to poll until the session is idle, needs permission, or the sync budget (about 20s) runs out — then poll get_session_summary or get_messages. Do not expect this tool to block for a multi-minute agent turn.",
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
      "Poll a session until it is idle, a permission is pending, or the sync budget expires. Use after send_prompt wait=false. Returns status running when the budget expires; call again or use get_session_summary.",
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
    description:
      "List messages in a session, newest first by default. Each assistant message leads with its final text, then a compact tool list (name, short input, status, summarized output). Reasoning is omitted unless includeReasoning is true. If text must be cut, the end is kept and the cut is marked. Use get_message to read one long message in pages, and get_session_summary for the latest answer alone.",
    op: "get_messages",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum messages. With order=desc (the default) these are the newest. Default 30.",
        },
        tail: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Newest N messages. They are still ordered by `order`. Same as last.",
        },
        last: { type: "integer", minimum: 1, maximum: 200, description: "Alias of tail." },
        order: {
          type: "string",
          enum: ["desc", "asc"],
          description: "desc (default) is newest first. asc is oldest first.",
        },
        includeReasoning: {
          type: "boolean",
          description: "Include reasoning text. Default false. A long reasoning block keeps its end and marks the cut.",
        },
        includeToolOutput: {
          type: "string",
          enum: ["summary", "full", "none"],
          description: "summary (default) keeps the end of each tool output. full keeps a longer end. none omits output text.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_message",
    description:
      "Read one message by id, for either OpenCode v2 content parts or v1 info/parts. Final text defaults to its ending when it is longer than maxChars. Page parts with partOffset and partLimit (the default page is the last parts). Page characters with offset and maxChars. Pass offset 0 to start at the beginning. Omitted ranges are marked.",
    op: "get_message",
    inputSchema: {
      type: "object",
      properties: {
        machine,
        sessionId,
        messageId: { type: "string", description: "Message id from get_messages or get_session_summary." },
        partOffset: {
          type: "integer",
          minimum: 0,
          description: "Index into the filtered part list. Default is the last page of parts.",
        },
        partLimit: { type: "integer", minimum: 1, maximum: 100, description: "Parts per page. Default 20." },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset. Omit it to show the end of the text. 0 starts at the beginning.",
        },
        maxChars: { type: "integer", minimum: 1, maximum: 60000, description: "Character window. Default 16000." },
        includeReasoning: { type: "boolean", description: "Include reasoning parts. Default false." },
        includeToolOutput: {
          type: "string",
          enum: ["summary", "full", "none"],
          description: "Default full, windowed by offset and maxChars. summary keeps a short end of each output. none omits output text.",
        },
      },
      required: ["sessionId", "messageId"],
    },
  },
  {
    name: "get_session_summary",
    description:
      "Latest state of a session: status (idle, busy, or retry), last activity time, the last assistant message's final text, its finish reason or error, and the last few tool calls. Use this after a long turn. The final text is kept in full up to a large cap; past that, the end is kept and the cut is marked.",
    op: "get_session_summary",
    inputSchema: { type: "object", properties: { machine, sessionId }, required: ["sessionId"] },
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
