import type { ShellOpName, ToolAnnotations } from "grokcode-shared";

export const SHELL_SERVER_NAME = "grokcode-shell";
export const SHELL_SERVER_VERSION = "0.1.0";

export const SHELL_INSTRUCTIONS = [
  "grokcode-shell runs commands and edits files on the owner's own PCs.",
  "Call list_machines first. Pass machine on every later tool when more than one PC is online.",
  "get_machine_info reports the OS, the shell (pwsh on Windows, bash on Linux), and the allowed roots.",
  "run_command takes argv (the program plus arguments) and an absolute cwd inside those roots. It does not invoke a shell unless shell is true and that machine's policy allows it.",
  "Commands are deny-by-default. A command must match the per-machine allowlist, and a hard deny list blocks privilege escalation, recursive deletes of a drive root, and argument-based code execution such as git -c.",
  "wait defaults to false. The tool returns a jobId. Poll get_job or poll_output until status is exited or timed_out. wait true only blocks for about 20 seconds.",
  "read_file, list_dir, write_file, and apply_patch stay inside the allowed roots and refuse symlink escapes.",
  "git_commit_push only commits paths you name, and only on a branch in the policy allowlist. Push stays off unless the policy sets git.push.",
  "Mutating tools are marked destructive so the client can ask the owner to confirm. There is no second prompt on the PC.",
].join(" ");

const machine = {
  type: "string",
  description:
    "Machine name registered by grokcode-agent. Required when more than one machine is online. In the local Antigravity stdio process this defaults to that PC.",
};

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export interface ShellTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  op?: ShellOpName;
  annotations: ToolAnnotations;
}

export const SHELL_TOOLS: ShellTool[] = [
  {
    name: "list_machines",
    description: "List PCs currently connected to this shell bridge. Read-only.",
    annotations: readOnly,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_machine_info",
    description:
      "Read one machine's OS, shell (pwsh on Windows, bash on Linux), allowed roots, and the command names its policy allowlists. Read-only. Does not run a command.",
    op: "shell_info",
    annotations: readOnly,
    inputSchema: { type: "object", properties: { machine }, additionalProperties: false },
  },
  {
    name: "run_command",
    description:
      "Run a program on a machine. argv is the program and its arguments with no shell interpretation. cwd must be an absolute path inside the allowed roots. shell true is rejected unless that machine's policy sets allowShell, and even then a hard deny list blocks piping curl into a shell, sudo, and recursive deletes of a drive root. wait defaults to false and returns a jobId; poll get_job or poll_output. Destructive: the client should ask the owner to confirm.",
    op: "shell_run",
    annotations: mutating,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        argv: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 64,
          description: "Program and arguments. Ignored when shell is true.",
        },
        cwd: { type: "string", description: "Absolute working directory inside the allowed roots." },
        shell: {
          type: "boolean",
          description: "Opt in to pwsh (Windows) or bash (Linux). Default false. Denied unless policy allowShell is true.",
        },
        command: { type: "string", description: "Shell command string. Used only when shell is true." },
        timeoutMs: { type: "integer", minimum: 100, maximum: 120000, description: "Kill the process after this many milliseconds." },
        wait: {
          type: "boolean",
          description: "Poll until the process exits or about 20 seconds pass. Default false, which returns a jobId.",
        },
      },
      required: ["cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "get_job",
    description: "Read a command started by run_command: status, exit code, and the output collected so far. Read-only.",
    op: "shell_job",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        jobId: { type: "string" },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "poll_output",
    description: "Read command output since a character offset. Pass the previous nextOffset. Read-only.",
    op: "shell_job",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        jobId: { type: "string" },
        offset: { type: "integer", minimum: 0, description: "Character offset. Use 0 to start at the beginning." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file inside the allowed roots. Symlinks that leave the roots are denied. Read-only.",
    op: "shell_read_file",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        path: { type: "string", description: "Absolute file path inside the allowed roots." },
        offset: { type: "integer", minimum: 0, description: "Byte offset. Default 0." },
        maxBytes: { type: "integer", minimum: 1, description: "Maximum bytes. Capped by policy." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List one directory inside the allowed roots. Entries are names and types. Symlink targets are not returned. Read-only.",
    op: "shell_list_dir",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        path: { type: "string", description: "Absolute directory inside the allowed roots." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or replace a UTF-8 file inside the allowed roots. Refuses symlink escapes, sensitive paths, and paths outside the roots. Destructive: the client should ask the owner to confirm.",
    op: "shell_write_file",
    annotations: { ...mutating, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        machine,
        path: { type: "string" },
        contents: { type: "string" },
      },
      required: ["path", "contents"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description:
      "Apply a unified diff to files under cwd. Every path must stay inside the allowed roots. Destructive: the client should ask the owner to confirm.",
    op: "shell_apply_patch",
    annotations: { ...mutating, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        machine,
        cwd: { type: "string", description: "Absolute directory the diff paths are relative to." },
        patch: { type: "string", description: "Unified diff (--- / +++ / @@ hunks)." },
      },
      required: ["cwd", "patch"],
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description: "Run git status --porcelain inside a repository under the allowed roots. The arguments are fixed. Read-only.",
    op: "shell_git_status",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        cwd: { type: "string", description: "Absolute repository directory inside the allowed roots." },
      },
      required: ["cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "git_commit_push",
    description:
      "Stage the named relative paths, commit them, and optionally push. The current branch must match the policy branch allowlist. Force push is impossible. push true is rejected unless policy git.push is true. Destructive: the client should ask the owner to confirm.",
    op: "shell_git_commit",
    annotations: mutating,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        cwd: { type: "string" },
        message: { type: "string" },
        paths: { type: "array", items: { type: "string" }, minItems: 1, description: "Relative paths to stage. No git add -A." },
        push: { type: "boolean", description: "Push HEAD to origin under the same branch name. Default false." },
      },
      required: ["cwd", "message", "paths"],
      additionalProperties: false,
    },
  },
];
