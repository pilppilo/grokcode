export class GrokcodeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "GrokcodeError";
  }
}

export class ToolError extends GrokcodeError {
  constructor(message: string, code: string, status?: number, details?: unknown) {
    super(message, code, status, details);
    this.name = "ToolError";
  }
}

export class HubError extends GrokcodeError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = "HubError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorCode(err: unknown): string {
  if (err instanceof GrokcodeError) return err.code;
  return "error";
}
