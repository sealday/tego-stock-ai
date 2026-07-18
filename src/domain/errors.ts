export const ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'RATE_LIMITED',
  'PROVIDER_PERMISSION',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorOptions {
  status: number;
  retryable: boolean;
  providerCode?: string;
  cause?: unknown;
}

const SAFE_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  INVALID_INPUT: 'The request input is invalid',
  NOT_FOUND: 'The requested market data was not found',
  RATE_LIMITED: 'Too many requests',
  PROVIDER_PERMISSION: 'Market data access is not permitted',
  PROVIDER_RATE_LIMIT: 'Market data provider rate limit reached',
  PROVIDER_UNAVAILABLE: 'Market data provider is unavailable',
  INTERNAL_ERROR: 'An internal error occurred',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable;
    if (options.providerCode !== undefined) {
      this.providerCode = options.providerCode;
    }
  }
}

export function safeErrorMessage(code: ErrorCode): string {
  return SAFE_MESSAGES[code];
}

export function invalidInput(): AppError {
  return new AppError('INVALID_INPUT', SAFE_MESSAGES.INVALID_INPUT, {
    status: 400,
    retryable: false,
  });
}

export function notFound(): AppError {
  return new AppError('NOT_FOUND', SAFE_MESSAGES.NOT_FOUND, {
    status: 404,
    retryable: false,
  });
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new AppError('PROVIDER_UNAVAILABLE', SAFE_MESSAGES.PROVIDER_UNAVAILABLE, {
      status: 503,
      retryable: true,
      providerCode: 'TIMEOUT',
    });
  }

  return new AppError('INTERNAL_ERROR', SAFE_MESSAGES.INTERNAL_ERROR, {
    status: 500,
    retryable: false,
  });
}
