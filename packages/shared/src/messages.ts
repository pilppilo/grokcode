import { ToolError } from "./errors.js";

/**
 * Project OpenCode v2 (`content` parts) and v1 (`info` + `parts`) messages
 * into a compact view. Final text comes before tool calls. Reasoning is
 * omitted unless asked for. When text must be shortened, the end is kept
 * and the cut is marked — that end is the answer, not the earlier reasoning.
 */

export const DEFAULT_LIST_LIMIT = 30;
export const LIST_TEXT_MAX = 32_000;
export const LATEST_TEXT_MAX = 48_000;
export const SUMMARY_TEXT_MAX = 64_000;
export const REASONING_MAX = 4_000;
export const TOOL_OUTPUT_SUMMARY_MAX = 500;
export const TOOL_OUTPUT_FULL_MAX = 8_000;
export const TOOL_INPUT_MAX = 180;
export const LIST_TOOL_MAX = 40;
export const SUMMARY_TOOL_MAX = 8;
export const DEFAULT_PART_LIMIT = 20;
export const DEFAULT_PAGE_CHARS = 16_000;

const MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "system",
  "synthetic",
  "shell",
  "skill",
  "compaction",
  "idle",
  "agent-switched",
  "model-switched",
  "location-switched",
]);

const TEXT_PART_TYPES = new Set(["text", "response"]);
const REASONING_PART_TYPES = new Set(["reasoning", "thinking"]);
const TOOL_PART_TYPES = new Set(["tool", "tool-invocation", "tool-call", "tool-result"]);
const INPUT_KEYS = ["command", "cmd", "path", "filePath", "file", "query", "pattern", "description", "prompt", "url"];

export interface ToolCallView {
  id?: string;
  name: string;
  status?: string;
  /** Short head of the tool input. The command or path is what identifies the call. */
  input?: string;
  output?: string;
  outputTruncated?: boolean;
  outputOmitted?: number;
  error?: string;
}

export interface MessageView {
  id?: string;
  role?: string;
  /** Final text parts, not reasoning. The end is kept when this is cut. */
  text: string;
  textTruncated?: boolean;
  textOmitted?: number;
  finish?: string;
  error?: string;
  created?: number;
  completed?: number;
  toolCount?: number;
  /** Tool calls dropped from the start of the list so the latest calls remain. */
  toolsOmitted?: number;
  tools?: ToolCallView[];
  reasoning?: string;
  reasoningTruncated?: boolean;
  reasoningOmitted?: number;
}

export interface LatestAssistant {
  id?: string;
  finish?: string;
  error?: string;
  created?: number;
  completed?: number;
  toolCount?: number;
  toolsOmitted?: number;
  tools?: ToolCallView[];
  textTruncated?: boolean;
  textOmitted?: number;
  /** Last field so a tail-truncated payload still ends on the answer. */
  text: string;
}

export interface MessageListResult {
  order: "asc" | "desc";
  count: number;
  hint?: string;
  messages: MessageView[];
  latest?: LatestAssistant;
}

export interface PartView {
  index: number;
  type: string;
  name?: string;
  status?: string;
  input?: string;
  text?: string;
  output?: string;
  error?: string;
  totalChars?: number;
  truncated?: boolean;
  omittedStart?: number;
  omittedEnd?: number;
  nextOffset?: number;
}

export interface MessagePage {
  id?: string;
  role?: string;
  finish?: string;
  error?: string;
  created?: number;
  completed?: number;
  partOffset: number;
  partLimit: number;
  partCount: number;
  nextPartOffset?: number;
  prevPartOffset?: number;
  textOffset: number;
  textTotal: number;
  textTruncated: boolean;
  nextTextOffset?: number;
  prevTextOffset?: number;
  toolCount?: number;
  toolsOmitted?: number;
  tools?: ToolCallView[];
  parts: PartView[];
  /** Last field. Defaults to the end of the final text when it does not fit. */
  text: string;
}

export interface SessionState {
  status: string;
  lastActivity?: number;
  session: { id: string; title?: string; directory?: string; activity: string };
  messageId?: string;
  finish?: string;
  error?: string;
  outcome?: string;
  created?: number;
  completed?: number;
  toolCount?: number;
  toolsOmitted?: number;
  tools?: ToolCallView[];
  textTruncated?: boolean;
  textOmitted?: number;
  text: string;
}

export type ToolOutputMode = "summary" | "full" | "none";

export interface ProjectOptions {
  includeReasoning: boolean;
  toolOutput: ToolOutputMode;
  textMax: number;
  reasoningMax: number;
  toolOutputMax: number;
  maxTools?: number;
}

export interface MessageListOptions {
  limit?: number;
  tail?: number;
  order?: "asc" | "desc";
  includeReasoning?: boolean;
  includeToolOutput?: ToolOutputMode;
  textMax?: number;
  latestTextMax?: number;
}

export interface MessageReadOptions {
  includeReasoning?: boolean;
  includeToolOutput?: ToolOutputMode;
  partOffset?: number;
  partLimit?: number;
  /** Omit to show the end of the text. `0` starts at the beginning. */
  offset?: number;
  maxChars?: number;
}

export interface SessionLike {
  id: string;
  title?: string;
  directory?: string;
  activity: string;
  raw?: unknown;
}

interface RawTool {
  id?: string;
  name: string;
  status?: string;
  input?: unknown;
  output: string;
  error?: string;
}

interface ListedPart {
  type: string;
  kind: "text" | "reasoning" | "tool";
  name?: string;
  status?: string;
  input?: string;
  error?: string;
  body: string;
}

export function omittedStartMarker(count: number): string {
  return `… omitted ${count} characters from the start …\n`;
}

export function omittedEndMarker(count: number): string {
  return `\n… omitted ${count} characters from the end …`;
}

export interface TextCut {
  text: string;
  truncated: boolean;
  omitted: number;
}

/** Keep the end of `text` and say how many leading characters were removed. */
export function truncateKeepEnd(text: string, max: number): TextCut {
  if (text.length <= max) return { text, truncated: false, omitted: 0 };
  if (max <= 0) return { text: "", truncated: true, omitted: text.length };
  const markerFor = (omitted: number) => omittedStartMarker(omitted);
  if (markerFor(text.length).length >= max) {
    const end = text.slice(text.length - max);
    return { text: end, truncated: true, omitted: text.length - end.length };
  }
  let marker = markerFor(text.length);
  let end = "";
  let omitted = text.length;
  for (let attempt = 0; attempt < 4; attempt++) {
    const room = Math.max(0, max - marker.length);
    end = text.slice(text.length - room);
    omitted = text.length - end.length;
    const next = markerFor(omitted);
    marker = next;
    if (marker.length + end.length <= max) break;
  }
  if (marker.length + end.length > max) {
    const room = Math.max(0, max - marker.length);
    end = text.slice(text.length - room);
    omitted = text.length - end.length;
    marker = markerFor(omitted);
  }
  const combined = marker + end;
  if (combined.length <= max && end.length > 0 && text.endsWith(end)) {
    return { text: combined, truncated: true, omitted };
  }
  const fallback = text.slice(text.length - max);
  return { text: fallback, truncated: true, omitted: text.length - fallback.length };
}

export interface TextWindow {
  text: string;
  offset: number;
  total: number;
  truncated: boolean;
  omittedStart: number;
  omittedEnd: number;
  nextOffset?: number;
  prevOffset?: number;
}

/**
 * A character window. When `offset` is omitted the window sits on the end
 * of the text so the final answer is what shows up first.
 */
export function sliceTextWindow(text: string, offset: number | undefined, maxChars: number): TextWindow {
  const total = text.length;
  const cap = Math.max(1, maxChars);
  const start = offset == null ? Math.max(0, total - cap) : Math.max(0, Math.min(offset, total));
  const end = Math.min(total, start + cap);
  const omittedStart = start;
  const omittedEnd = total - end;
  let body = text.slice(start, end);
  if (omittedStart > 0) body = omittedStartMarker(omittedStart) + body;
  if (omittedEnd > 0) body = body + omittedEndMarker(omittedEnd);
  return {
    text: body,
    offset: start,
    total,
    truncated: omittedStart > 0 || omittedEnd > 0,
    omittedStart,
    omittedEnd,
    ...(omittedEnd > 0 ? { nextOffset: end } : {}),
    ...(start > 0 ? { prevOffset: Math.max(0, start - cap) } : {}),
  };
}

export function messageIdOf(raw: unknown): string | undefined {
  const info = infoOf(raw);
  return pickString(info, ["id", "messageID", "messageId"]);
}

export function messageRole(raw: unknown): string | undefined {
  const info = infoOf(raw);
  const role = pickString(info, ["role"]);
  if (role && role !== "message") return role;
  const type = pickString(info, ["type"]);
  if (type && MESSAGE_ROLES.has(type)) return type;
  return role ?? type;
}

export function toMessageView(raw: unknown): MessageView {
  return projectMessage(raw, {
    includeReasoning: false,
    toolOutput: "summary",
    textMax: LIST_TEXT_MAX,
    reasoningMax: REASONING_MAX,
    toolOutputMax: TOOL_OUTPUT_SUMMARY_MAX,
    maxTools: LIST_TOOL_MAX,
  });
}

export function projectMessage(raw: unknown, options: ProjectOptions): MessageView {
  if (!isRecord(raw)) return { text: "" };
  const info = infoOf(raw);
  const role = messageRole(raw);
  const id = messageIdOf(raw);
  const parts = partsOf(raw);
  const created = messageCreated(raw);
  const completed = messageCompleted(raw);
  const error = formatError(info.error);
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const tools: RawTool[] = [];

  for (const part of parts) {
    if (!isRecord(part)) continue;
    const kind = classify(part);
    if (kind === "reasoning") reasoningParts.push(partText(part));
    else if (kind === "tool") {
      const tool = asTool(part);
      if (tool) tools.push(tool);
    } else if (kind === "text") textParts.push(partText(part));
  }

  if (role === "shell") {
    const command = pickString(info, ["command"]) ?? "";
    const output = typeof info.output === "string" ? info.output : "";
    tools.push({
      name: "shell",
      ...(pickString(info, ["status"]) ? { status: pickString(info, ["status"]) } : {}),
      input: command,
      output,
      ...(error ? { error } : {}),
    });
    if (isBlank(textParts) && command) textParts.push(command);
  }

  if (role === "compaction" && typeof info.summary === "string" && isBlank(textParts)) textParts.push(info.summary);
  if (isBlank(textParts)) {
    if (typeof info.text === "string") textParts.push(info.text);
    else if (typeof raw.text === "string") textParts.push(raw.text);
    else if (typeof info.content === "string") textParts.push(info.content);
    else if (typeof raw.content === "string") textParts.push(raw.content);
  }

  const cut = truncateKeepEnd(textParts.filter((chunk) => chunk !== "").join("\n"), options.textMax);
  const finish = messageFinish(raw, parts);
  const { shown, omitted } = tailItems(tools, options.maxTools);
  const toolViews = shown.map((tool) => toToolView(tool, options.toolOutput, options.toolOutputMax));
  const showTools = role === "assistant" || role === "shell" || tools.length > 0;

  let reasoningCut: TextCut | undefined;
  if (options.includeReasoning && reasoningParts.some((chunk) => chunk !== "")) {
    reasoningCut = truncateKeepEnd(reasoningParts.filter((chunk) => chunk !== "").join("\n"), options.reasoningMax);
  }

  return {
    ...(id ? { id } : {}),
    ...(role ? { role } : {}),
    text: cut.text,
    ...(cut.truncated ? { textTruncated: true, textOmitted: cut.omitted } : {}),
    ...(finish ? { finish } : {}),
    ...(error ? { error } : {}),
    ...(created != null ? { created } : {}),
    ...(completed != null ? { completed } : {}),
    ...(showTools
      ? {
          toolCount: tools.length,
          ...(omitted > 0 ? { toolsOmitted: omitted } : {}),
          tools: toolViews,
        }
      : {}),
    ...(reasoningCut
      ? {
          reasoning: reasoningCut.text,
          ...(reasoningCut.truncated
            ? { reasoningTruncated: true, reasoningOmitted: reasoningCut.omitted }
            : {}),
        }
      : {}),
  };
}

export function projectMessageList(raws: unknown[], options: MessageListOptions = {}): MessageListResult {
  const order = options.order === "asc" ? "asc" : "desc";
  const count = options.tail ?? options.limit ?? DEFAULT_LIST_LIMIT;
  const selected = selectMessages(raws, { order, count, tail: options.tail != null || order === "desc" });
  const projected = selected.map((raw) => projectMessage(raw, projectOptions(options, options.textMax ?? LIST_TEXT_MAX)));
  const latestRaw = newestAssistant(raws);
  const latest = latestRaw
    ? toLatest(
        projectMessage(latestRaw, {
          ...projectOptions(options, options.latestTextMax ?? LATEST_TEXT_MAX),
          includeReasoning: false,
          maxTools: SUMMARY_TOOL_MAX,
        }),
      )
    : undefined;
  const truncated = projected.some((message) => message.textTruncated) || latest?.textTruncated === true;
  return {
    order,
    count: projected.length,
    ...(truncated
      ? { hint: "Some text was cut from the start. Call get_message with offset and maxChars to read the rest." }
      : {}),
    messages: projected,
    ...(latest ? { latest } : {}),
  };
}

export function readMessage(raw: unknown, options: MessageReadOptions = {}): MessagePage {
  const info = infoOf(raw);
  const role = messageRole(raw);
  const id = messageIdOf(raw);
  const created = messageCreated(raw);
  const completed = messageCompleted(raw);
  const error = formatError(info.error);
  const finish = messageFinish(raw, partsOf(raw));
  const includeReasoning = options.includeReasoning === true;
  const mode = options.includeToolOutput ?? "full";
  const maxChars = options.maxChars ?? DEFAULT_PAGE_CHARS;
  const partLimit = options.partLimit ?? DEFAULT_PART_LIMIT;
  const listed = listParts(raw, includeReasoning);
  const partCount = listed.length;
  const defaultPartOffset = Math.max(0, partCount - partLimit);
  const partOffset = Math.min(Math.max(0, options.partOffset ?? defaultPartOffset), partCount);
  const page = listed.slice(partOffset, partOffset + partLimit);
  const finalText = listed
    .filter((part) => part.kind === "text")
    .map((part) => part.body)
    .filter((chunk) => chunk !== "")
    .join("\n");
  const textWindow = sliceTextWindow(finalText, options.offset, maxChars);
  const allTools = listed.filter((part) => part.kind === "tool");
  const { shown, omitted } = tailItems(allTools, LIST_TOOL_MAX);
  const tools = shown.map((part) =>
    toToolView(
      { name: part.name ?? "tool", ...(part.status ? { status: part.status } : {}), input: part.input, output: part.body, ...(part.error ? { error: part.error } : {}) },
      mode === "none" ? "none" : "summary",
      TOOL_OUTPUT_SUMMARY_MAX,
    ),
  );

  const parts: PartView[] = page.map((part, index) => {
    const view: PartView = { index: partOffset + index, type: part.type };
    if (part.name) view.name = part.name;
    if (part.status) view.status = part.status;
    if (part.input) view.input = part.input;
    if (part.error) view.error = part.error;
    if (part.kind === "tool" && mode === "none") return view;
    if (part.kind === "tool" && mode === "summary") {
      const cut = truncateKeepEnd(part.body, Math.min(TOOL_OUTPUT_SUMMARY_MAX, maxChars));
      if (cut.text) view.output = cut.text;
      view.totalChars = part.body.length;
      if (cut.truncated) {
        view.truncated = true;
        view.omittedStart = cut.omitted;
      }
      return view;
    }
    const window = sliceTextWindow(part.body, options.offset, maxChars);
    if (part.kind === "tool") {
      if (window.text) view.output = window.text;
    } else if (window.text) view.text = window.text;
    view.totalChars = window.total;
    if (window.truncated) {
      view.truncated = true;
      view.omittedStart = window.omittedStart;
      view.omittedEnd = window.omittedEnd;
    }
    if (window.nextOffset != null) view.nextOffset = window.nextOffset;
    return view;
  });

  return {
    ...(id ? { id } : {}),
    ...(role ? { role } : {}),
    ...(finish ? { finish } : {}),
    ...(error ? { error } : {}),
    ...(created != null ? { created } : {}),
    ...(completed != null ? { completed } : {}),
    partOffset,
    partLimit,
    partCount,
    ...(partOffset + partLimit < partCount ? { nextPartOffset: partOffset + partLimit } : {}),
    ...(partOffset > 0 ? { prevPartOffset: Math.max(0, partOffset - partLimit) } : {}),
    textOffset: textWindow.offset,
    textTotal: textWindow.total,
    textTruncated: textWindow.truncated,
    ...(textWindow.nextOffset != null ? { nextTextOffset: textWindow.nextOffset } : {}),
    ...(textWindow.prevOffset != null ? { prevTextOffset: textWindow.prevOffset } : {}),
    ...(allTools.length > 0 || role === "assistant"
      ? { toolCount: allTools.length, ...(omitted > 0 ? { toolsOmitted: omitted } : {}), tools }
      : {}),
    parts,
    text: textWindow.text,
  };
}

export function summarizeSession(session: SessionLike, raws: unknown[], textMax = SUMMARY_TEXT_MAX): SessionState {
  const assistant = newestAssistant(raws);
  const projected = assistant
    ? projectMessage(assistant, {
        includeReasoning: false,
        toolOutput: "summary",
        textMax,
        reasoningMax: 0,
        toolOutputMax: TOOL_OUTPUT_SUMMARY_MAX,
        maxTools: SUMMARY_TOOL_MAX,
      })
    : undefined;
  const idle = newestByRole(raws, "idle");
  const outcome = idle ? messageFinish(idle, partsOf(idle)) : undefined;
  const stamps = [
    sessionActivityTime(session.raw),
    assistant ? messageCompleted(assistant) : undefined,
    assistant ? messageCreated(assistant) : undefined,
    idle ? messageCreated(idle) : undefined,
  ].filter((value): value is number => value != null);
  const lastActivity = stamps.length > 0 ? Math.max(...stamps) : undefined;
  return {
    status: session.activity,
    ...(lastActivity != null ? { lastActivity } : {}),
    session: {
      id: session.id,
      ...(session.title ? { title: session.title } : {}),
      ...(session.directory ? { directory: session.directory } : {}),
      activity: session.activity,
    },
    ...(projected?.id ? { messageId: projected.id } : {}),
    ...(projected?.finish ? { finish: projected.finish } : {}),
    ...(projected?.error ? { error: projected.error } : {}),
    ...(outcome ? { outcome } : {}),
    ...(projected?.created != null ? { created: projected.created } : {}),
    ...(projected?.completed != null ? { completed: projected.completed } : {}),
    ...(projected?.toolCount != null ? { toolCount: projected.toolCount } : {}),
    ...(projected?.toolsOmitted ? { toolsOmitted: projected.toolsOmitted } : {}),
    ...(projected?.tools ? { tools: projected.tools } : {}),
    ...(projected?.textTruncated ? { textTruncated: true, textOmitted: projected.textOmitted } : {}),
    text: projected?.text ?? "",
  };
}

export function parseToolOutputMode(value: unknown): ToolOutputMode {
  if (value == null || value === "") return "summary";
  if (value === true || value === "full" || value === "true") return "full";
  if (value === false || value === "none" || value === "false") return "none";
  if (value === "summary") return "summary";
  throw new ToolError("includeToolOutput must be summary, full, or none.", "invalid_argument");
}

function projectOptions(options: MessageListOptions, textMax: number): ProjectOptions {
  return {
    includeReasoning: options.includeReasoning === true,
    toolOutput: options.includeToolOutput ?? "summary",
    textMax,
    reasoningMax: REASONING_MAX,
    toolOutputMax: options.includeToolOutput === "full" ? TOOL_OUTPUT_FULL_MAX : TOOL_OUTPUT_SUMMARY_MAX,
    maxTools: LIST_TOOL_MAX,
  };
}

function selectMessages(
  raws: unknown[],
  opts: { order: "asc" | "desc"; count: number; tail: boolean },
): unknown[] {
  const count = Math.max(0, opts.count);
  const decorated = raws.map((raw, index) => ({ raw, index, time: messageCreated(raw) }));
  const chronological = decorated.some((item) => item.time != null)
    ? [...decorated].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.index - b.index)
    : decorated;
  const selected = count === 0 ? [] : opts.tail ? chronological.slice(-count) : chronological.slice(0, count);
  const shown = opts.order === "desc" ? [...selected].reverse() : selected;
  return shown.map((item) => item.raw);
}

function newestAssistant(raws: unknown[]): unknown | undefined {
  return newestByRole(raws, "assistant");
}

function newestByRole(raws: unknown[], role: string): unknown | undefined {
  const matched = raws.filter((raw) => messageRole(raw) === role);
  if (matched.length === 0) return undefined;
  if (!matched.some((raw) => messageCreated(raw) != null || messageCompleted(raw) != null)) {
    return matched[matched.length - 1];
  }
  return [...matched].sort((a, b) => stampOf(a) - stampOf(b)).at(-1);
}

function stampOf(raw: unknown): number {
  return messageCompleted(raw) ?? messageCreated(raw) ?? 0;
}

function toLatest(message: MessageView): LatestAssistant {
  return {
    ...(message.id ? { id: message.id } : {}),
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.created != null ? { created: message.created } : {}),
    ...(message.completed != null ? { completed: message.completed } : {}),
    ...(message.toolCount != null ? { toolCount: message.toolCount } : {}),
    ...(message.toolsOmitted ? { toolsOmitted: message.toolsOmitted } : {}),
    ...(message.tools ? { tools: message.tools } : {}),
    ...(message.textTruncated ? { textTruncated: true, textOmitted: message.textOmitted } : {}),
    text: message.text,
  };
}

function listParts(raw: unknown, includeReasoning: boolean): ListedPart[] {
  const parts = partsOf(raw);
  const listed: ListedPart[] = [];
  if (parts.length === 0) {
    const info = infoOf(raw);
    const role = messageRole(raw);
    let text = pickString(info, ["text"]) ?? (isRecord(raw) ? pickString(raw, ["text"]) : undefined);
    if (!text && role === "compaction" && typeof info.summary === "string") text = info.summary;
    if (!text && role === "shell") text = pickString(info, ["command"]);
    if (text) listed.push({ type: "text", kind: "text", body: text });
    if (role === "shell") {
      const command = pickString(info, ["command"]);
      listed.push({
        type: "tool",
        kind: "tool",
        name: "shell",
        ...(pickString(info, ["status"]) ? { status: pickString(info, ["status"]) } : {}),
        ...(command ? { input: command } : {}),
        body: typeof info.output === "string" ? info.output : "",
      });
    }
    return listed;
  }
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const kind = classify(part);
    if (kind === "reasoning") {
      if (!includeReasoning) continue;
      listed.push({ type: "reasoning", kind: "reasoning", body: partText(part) });
      continue;
    }
    if (kind === "tool") {
      const tool = asTool(part);
      if (!tool) continue;
      const input = inputSummary(tool.input, TOOL_INPUT_MAX);
      listed.push({
        type: "tool",
        kind: "tool",
        name: tool.name,
        ...(tool.status ? { status: tool.status } : {}),
        ...(input ? { input } : {}),
        ...(tool.error ? { error: tool.error } : {}),
        body: tool.output,
      });
      continue;
    }
    if (kind === "text") listed.push({ type: "text", kind: "text", body: partText(part) });
  }
  return listed;
}

function toToolView(tool: RawTool, mode: ToolOutputMode, outputMax: number): ToolCallView {
  const input = inputSummary(tool.input, TOOL_INPUT_MAX);
  const view: ToolCallView = {
    ...(tool.id ? { id: tool.id } : {}),
    name: tool.name,
    ...(tool.status ? { status: tool.status } : {}),
    ...(input ? { input } : {}),
    ...(tool.error ? { error: truncateKeepEnd(tool.error, 500).text } : {}),
  };
  if (mode === "none" || tool.output === "") return view;
  const cut = truncateKeepEnd(tool.output, outputMax);
  view.output = cut.text;
  if (cut.truncated) {
    view.outputTruncated = true;
    view.outputOmitted = cut.omitted;
  }
  return view;
}

function tailItems<T>(items: T[], max: number | undefined): { shown: T[]; omitted: number } {
  if (max == null || items.length <= max) return { shown: items, omitted: 0 };
  return { shown: items.slice(items.length - max), omitted: items.length - max };
}

function asTool(part: Record<string, unknown>): RawTool | undefined {
  const state = isRecord(part.state) ? part.state : undefined;
  const name = pickString(part, ["name", "tool", "toolName"]) ?? (state ? pickString(state, ["tool", "name"]) : undefined) ?? "tool";
  const status = (state ? pickString(state, ["status"]) : undefined) ?? pickString(part, ["status"]);
  const input = state && "input" in state ? state.input : part.input ?? part.args ?? part.arguments;
  const output = outputText(state ?? part);
  const error = formatError(state?.error ?? part.error);
  const id = pickString(part, ["id", "callID", "callId"]);
  return {
    ...(id ? { id } : {}),
    name,
    ...(status ? { status } : {}),
    input,
    output,
    ...(error ? { error } : {}),
  };
}

function classify(part: Record<string, unknown>): "text" | "reasoning" | "tool" | "other" {
  const type = typeof part.type === "string" ? part.type : "";
  if (REASONING_PART_TYPES.has(type)) return "reasoning";
  if (TOOL_PART_TYPES.has(type)) return "tool";
  if (isRecord(part.state) && (typeof part.tool === "string" || typeof part.name === "string" || typeof part.toolName === "string")) {
    return "tool";
  }
  if (TEXT_PART_TYPES.has(type)) return "text";
  if (!type && typeof part.text === "string") return "text";
  return "other";
}

function outputText(source: Record<string, unknown>): string {
  const direct = source.output ?? source.result;
  if (typeof direct === "string") return direct;
  if (typeof direct === "number" || typeof direct === "boolean") return String(direct);
  const fromContent = contentToText(source.content ?? direct);
  if (fromContent) return fromContent;
  if (isRecord(direct)) return safeJson(direct);
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.output === "string") return content.output;
    return "";
  }
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const item of content) {
    if (typeof item === "string") chunks.push(item);
    else if (isRecord(item)) {
      if (typeof item.text === "string") chunks.push(item.text);
      else if (item.type === "file") chunks.push(`[file ${pickString(item, ["name", "uri"]) ?? "attachment"}]`);
    }
  }
  return chunks.join("\n");
}

function partText(part: Record<string, unknown>): string {
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return contentToText(part.content);
}

function inputSummary(input: unknown, max: number): string | undefined {
  if (input == null) return undefined;
  let text: string | undefined;
  if (typeof input === "string") text = input;
  else if (isRecord(input)) {
    for (const key of INPUT_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.trim() !== "") {
        text = value;
        break;
      }
    }
    text ??= safeJson(input);
  } else text = safeJson(input);
  if (!text) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

export function formatError(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (!isRecord(value)) return undefined;
  const data = isRecord(value.data) ? value.data : undefined;
  const message =
    (typeof value.message === "string" && value.message) ||
    (data && typeof data.message === "string" && data.message) ||
    (typeof value.error === "string" && value.error) ||
    "";
  const name =
    (typeof value.name === "string" && value.name) ||
    (typeof value.type === "string" && value.type !== "error" && value.type) ||
    "";
  if (name && message && name !== message) return `${name}: ${message}`;
  return message || name || undefined;
}

function messageFinish(raw: unknown, parts: unknown[]): string | undefined {
  const info = infoOf(raw);
  const direct = pickString(info, ["finish", "rawFinish", "outcome"]);
  if (direct) return direct;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (!isRecord(part)) continue;
    if (part.type !== "step-finish" && part.type !== "finish") continue;
    const reason = pickString(part, ["reason", "finish"]);
    if (reason) return reason;
  }
  return undefined;
}

function messageCreated(raw: unknown): number | undefined {
  const info = infoOf(raw);
  const fromInfo = isRecord(info.time) ? readTimePoint(info.time.created) : undefined;
  if (fromInfo != null) return fromInfo;
  if (isRecord(raw) && isRecord(raw.time)) return readTimePoint(raw.time.created);
  return undefined;
}

function messageCompleted(raw: unknown): number | undefined {
  const info = infoOf(raw);
  const time = isRecord(info.time) ? info.time : isRecord(raw) && isRecord(raw.time) ? raw.time : undefined;
  if (!time) return undefined;
  return readTimePoint(time.completed) ?? readTimePoint(time.updated) ?? readTimePoint(time.streamed);
}

function sessionActivityTime(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  const time = isRecord(raw.time) ? raw.time : undefined;
  const points = [
    time ? readTimePoint(time.updated) : undefined,
    time ? readTimePoint(time.completed) : undefined,
    time ? readTimePoint(time.created) : undefined,
    readTimePoint(raw.updated),
    readTimePoint(raw.updatedAt),
  ].filter((value): value is number => value != null);
  return points.length > 0 ? Math.max(...points) : undefined;
}

function readTimePoint(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : undefined;
}

function partsOf(raw: unknown): unknown[] {
  if (!isRecord(raw)) return [];
  if (Array.isArray(raw.content)) return raw.content;
  if (Array.isArray(raw.parts)) return raw.parts;
  const info = isRecord(raw.info) ? raw.info : undefined;
  if (info && Array.isArray(info.content)) return info.content;
  if (info && Array.isArray(info.parts)) return info.parts;
  return [];
}

function infoOf(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return isRecord(raw.info) ? raw.info : raw;
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.trim() !== "") return found;
  }
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isBlank(chunks: string[]): boolean {
  return chunks.every((chunk) => chunk === "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
