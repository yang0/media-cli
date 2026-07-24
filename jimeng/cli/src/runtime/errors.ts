export class AppError extends Error {
  public readonly exitCode: number;
  public readonly causeValue: unknown;

  public constructor(message: string, exitCode = 1, causeValue?: unknown) {
    super(message);
    this.name = "AppError";
    this.exitCode = exitCode;
    this.causeValue = causeValue;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

export function getExitCode(error: unknown): number {
  return error instanceof AppError ? error.exitCode : 1;
}
