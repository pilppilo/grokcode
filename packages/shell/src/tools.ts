import type { ShellOpName, ToolAnnotations } from "grokcode-shared";

export const SHELL_SERVER_NAME = "grokcode-shell";
export const SHELL_SERVER_VERSION = "0.1.0";
export const SEARCH_IGNORED_DIRECTORIES = ["node_modules", "dist", "build", "target", "__pycache__"] as const;

export const SHELL_INSTRUCTIONS = [
  "grokcode-shell runs commands and edits files on the owner's own PCs.",
  "Call list_machines first to discover reachable machines, their configured projects, and allowed roots. Specify a project to resolve relative file paths within its root. Pass machine when more than one PC is online.",
  "get_machine_info reports the OS, the shell (pwsh on Windows, bash on Linux), and the allowed roots.",
  "Call check_repo with a project and optional project-relative cwd to discover repository guidance. When a project tool reports a different guidance scope or fingerprint, call check_repo for that scope. Local policy and user authorization govern every tool call.",
  "Read every file your design depends on in full before writing about it. Use read_files for several small files and continue any partial read with read_file.",
  "run_command takes argv (the program plus arguments) and an absolute cwd inside those roots. It does not invoke a shell unless shell is true and that machine's policy sets allowShell, which means an arbitrary shell.",
  "Commands are deny-by-default. A command must match the per-machine allowlist, and a hard deny list blocks privilege escalation, recursive deletes of a drive root, and argument-based code execution such as git -c.",
  "wait defaults to true and blocks for up to about 45 seconds. Poll get_job or poll_output for running jobs, or use kill_job to cancel.",
  "read_file, read_files, list_dir, write_file, edit_file, and apply_patch stay inside the allowed roots and refuse symlink escapes.",
  "git_commit_push only commits paths you name, and only on a branch in the policy allowlist. Push stays off unless the policy sets git.push. If push is requested while git.push is false, nothing is staged or committed. A successful result includes the commit SHA. If the commit succeeds and the push fails, the error includes that SHA: retry only the push and do not create another commit.",
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

const project = { type: "string", description: "Project name from list_machines." };
const taskId = { type: "string", description: "Task ID returned by run_task." };

export const READ_FILES_MAX_PATHS = 8;
export const READ_FILES_MAX_BYTES = 46_000;

const tools: ShellTool[] = [
  {
    name: "run_task",
    description: "Start a project command configured in local policy and return its task ID. Defaults to the test command.",
    op: "shell_run_task",
    annotations: mutating,
    inputSchema: {
      type: "object", properties: { machine, project, task: { type: "string", description: "Configured task name. Defaults to test." } },
      required: ["project"], additionalProperties: false,
    },
  },
  {
    name: "get_task_status",
    description: "Get task phase and exit code.",
    op: "shell_task_status",
    annotations: readOnly,
    inputSchema: { type: "object", properties: { machine, taskId }, required: ["taskId"], additionalProperties: false },
  },
  {
    name: "get_task_activity",
    description: "Read the task's retained output tail. Poll until done.",
    op: "shell_task_activity",
    annotations: readOnly,
    inputSchema: {
      type: "object", properties: { machine, taskId, offset: { type: "integer", minimum: 0 } },
      required: ["taskId"], additionalProperties: false,
    },
  },
  {
    name: "cancel_task",
    description: "Request task cancellation. Poll activity until the final output is available.",
    op: "shell_cancel_task",
    annotations: mutating,
    inputSchema: { type: "object", properties: { machine, taskId }, required: ["taskId"], additionalProperties: false },
  },
  {
    name: "check_repo",
    description: "Show the project Git summary and discover repository guidance for the optional project-relative cwd.",
    op: "shell_check_repo",
    annotations: readOnly,
    inputSchema: { type: "object", properties: { machine, project, cwd: { type: "string", description: "Directory relative to the project root. Defaults to the root." } }, required: ["project"], additionalProperties: false },
  },
  {
    name: "run_tests",
    description: "Run the project policy's configured test command. Poll the returned job ID if the tests are still running.",
    op: "shell_run_tests",
    annotations: mutating,
    inputSchema: {
      type: "object",
      properties: { machine, project, filter: { type: "string", description: "One positional test filter." } },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "list_machines",
    description: "List connected PCs with OS and allowed roots when available. Read-only.",
    annotations: readOnly,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_machine_info",
    description:
      "Read one machine's OS, shell (pwsh on Windows, bash on Linux), allowed roots, and the commands and subcommands its policy allowlists. Read-only. Does not run a command.",
    op: "shell_info",
    annotations: readOnly,
    inputSchema: { type: "object", properties: { machine }, additionalProperties: false },
  },
  {
    name: "run_command",
    description:
      "Run a program on a machine. argv is the program and its arguments with no shell interpretation. cwd must be an absolute path inside the allowed roots. shell true is rejected unless that machine's policy sets allowShell, and even then a hard deny list blocks piping curl into a shell, sudo, and recursive deletes of a drive root. wait defaults to true for up to about 45 seconds. A running command returns a jobId; poll get_job or poll_output. Destructive: the client should ask the owner to confirm.",
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
          description: "Run the command string in an arbitrary shell (pwsh on Windows, bash on Linux). Default false. Denied unless policy allowShell is true.",
        },
        command: { type: "string", description: "Shell command string. Used only when shell is true." },
        stdin: { type: "boolean", description: "Keep stdin open for send_input. Requires allowJobInput." },
        timeoutMs: { type: "integer", minimum: 100, maximum: 120000, description: "Kill the process after this many milliseconds." },
        wait: {
          type: "boolean",
          description: "Wait up to about 45 seconds for the process to exit. Default true; false returns immediately with a jobId.",
        },
      },
      required: ["cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "get_job",
    description: "Wait up to about 45 seconds for command status, exit code, and an output preview. If bytes were omitted, pass outputFile to read_file for the saved output, or nextOffset to poll_output. Status output_limit means the command exceeded the capture budget.",
    op: "shell_job",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        jobId: { type: "string" },
        wait: { type: "boolean", description: "Set false to return the current status immediately." },
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
    description: "Read a UTF-8 file inside the allowed roots. Start without a line range and follow nextOffset until hasMore is false to read the whole file. Each page includes up to 800 lines or 38,000 source bytes. A line range limits the read to those lines. fileComplete reports whether this response covers the entire file. Follow the coverage note for unread lines outside the range.",
    op: "shell_read_file",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        path: { type: "string", description: "Absolute file path inside the allowed roots, or the outputFile value from a finished job." },
        offset: { type: "integer", minimum: 0, description: "UTF-8 byte offset. Use the previous page's nextOffset to continue." },
        startLine: { type: "integer", minimum: 1, description: "First line of the range, inclusive. Repeat on continuation requests." },
        endLine: { type: "integer", minimum: 1, description: "Last line of the range, inclusive. Repeat on continuation requests." },
        maxBytes: { type: "integer", minimum: 1, description: "Maximum source bytes, capped at 38,000 and by machine policy." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_files",
    description: `Read up to ${READ_FILES_MAX_PATHS} UTF-8 files in one call, in path order, within a ${READ_FILES_MAX_BYTES.toLocaleString("en-US")}-byte reply. The summary identifies complete, partial, and unread files. Follow the reported offset with read_file to finish a partial file.`,
    op: "shell_read_files",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        project,
        paths: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 4096 },
          minItems: 1,
          maxItems: READ_FILES_MAX_PATHS,
          description: "File paths inside the allowed roots. Use absolute paths, or paths relative to the named project.",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List the first 500 sorted entries in a directory inside the allowed roots. File entries show size in bytes and a line count when available. Large files use a sample-based estimate. Symlink entries show the name and type only.",
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
        path: { type: "string", description: "Absolute destination inside the allowed roots." },
        contents: { type: "string", description: "Complete UTF-8 replacement contents." },
      },
      required: ["path", "contents"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace exact UTF-8 text in an existing file. Matching treats LF and CRLF as equivalent. By default the old text must occur exactly once. Returns line counts and preserves the file's permissions. Ask the owner to confirm this write.",
    op: "shell_edit_file",
    annotations: { ...mutating, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        machine,
        path: { type: "string", description: "Destination file inside the allowed roots." },
        oldText: { type: "string", minLength: 1, description: "Exact text to find, including whitespace." },
        newText: { type: "string", description: "Replacement text. Use an empty string to delete the match." },
        replaceAll: { type: "boolean", description: "Replace all non-overlapping matches. Defaults to false." },
      },
      required: ["path", "oldText", "newText"],
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
    description: "Run git status --porcelain inside a repository under the allowed roots. Requires git status on the allowlist. The arguments are fixed. Read-only.",
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
    name: "list_jobs",
    description: "List retained jobs and collect job completion notices for this session.",
    op: "shell_list_jobs",
    annotations: { ...mutating, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: { machine }, additionalProperties: false },
  },
  {
    name: "send_input",
    description: "Write text to an opted-in job's stdin. Include a newline if the command expects one.",
    op: "shell_send_input",
    annotations: mutating,
    inputSchema: {
      type: "object",
      properties: { machine, jobId: { type: "string" }, input: { type: "string", minLength: 1, maxLength: 4096 } },
      required: ["jobId", "input"],
      additionalProperties: false,
    },
  },
  {
    name: "kill_job",
    description: "Cancel a running command on this machine. Destructive.",
    op: "shell_kill_job",
    annotations: { ...mutating, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { machine, jobId: { type: "string", description: "Job identifier returned by run_command." } },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description: `Find literal text under cwd, which defaults to the root of the named project. By default, skips ${SEARCH_IGNORED_DIRECTORIES.join(", ")} directories and *.map files. An explicitly scoped dependency search includes its build folders. Hidden paths, sensitive paths, and binary files are excluded. Symlinks are skipped, with an exception for in-scope pnpm package aliases when includeIgnored is true. Reports the search scope, exclusions, and limits reached. Requires the rg policy entry.`,
    op: "shell_search_files",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        cwd: { type: "string", description: "Absolute directory inside the allowed roots, or a path relative to the named project. Required without a project." },
        query: { type: "string", description: "Case-sensitive literal text." },
        glob: { type: "string", description: "Optional filename glob using * and ?, such as *.ts. Use a glob ending in .map to search source maps." },
        includeIgnored: { type: "boolean", description: `Include ${SEARCH_IGNORED_DIRECTORIES.join(", ")} directories and in-scope pnpm package aliases. Defaults to false.` },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    description: "Read unstaged Git changes by default. Set staged to true to inspect staged changes. External diff, text conversion, and Git filters are disabled.",
    op: "shell_git_diff",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        cwd: { type: "string", description: "Absolute repository directory inside the allowed roots." },
        staged: { type: "boolean", description: "Inspect staged changes instead of unstaged changes. Defaults to false." },
      },
      required: ["cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "git_log",
    description: "Read recent Git commits as a compact one-line log.",
    op: "shell_git_log",
    annotations: readOnly,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        cwd: { type: "string", description: "Absolute repository directory inside the allowed roots." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum commits. Defaults to 20." },
      },
      required: ["cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "git_commit_push",
    description:
      "Stage the named relative paths, commit them, and optionally push. The current branch must match the policy branch allowlist. Force push is impossible. push true is rejected before anything is staged or committed unless policy git.push is true, and that rejection leaves the index and HEAD unchanged. A successful result includes the commit SHA. If the commit succeeds and the push then fails, the tool result is an error that still includes the commit SHA and the push error: the commit already exists, so retry only the push and do not create another commit. Destructive: the client should ask the owner to confirm.",
    op: "shell_git_commit",
    annotations: mutating,
    inputSchema: {
      type: "object",
      properties: {
        machine,
        cwd: { type: "string", description: "Absolute repository directory inside the allowed roots." },
        message: { type: "string", description: "Commit message." },
        paths: { type: "array", items: { type: "string" }, minItems: 1, description: "Relative paths to stage. No git add -A." },
        push: {
          type: "boolean",
          description:
            "Push HEAD to origin under the same branch name. Default false. When policy git.push is false, true is denied before any git add or git commit.",
        },
      },
      required: ["cwd", "message", "paths"],
      additionalProperties: false,
    },
  },
];

const projectFileTools = new Set(["run_command", "read_file", "list_dir", "write_file", "edit_file", "search_files", "apply_patch", "git_status", "git_diff", "git_log", "git_commit_push"]);

export const SHELL_TOOLS: ShellTool[] = tools.map((tool) => {
  const title = tool.name.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
  const inputSchema = projectFileTools.has(tool.name) ? {
    ...tool.inputSchema,
    properties: {
      ...tool.inputSchema.properties as Record<string, unknown>,
      project: { type: "string", description: "Named project. A path or cwd can be relative to its root." },
    },
  } : tool.inputSchema;
  return { ...tool, inputSchema, annotations: { ...tool.annotations, title } };
});
