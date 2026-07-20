export interface AiClientConfiguration {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly signal: AbortSignal;
}

export interface AiChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export type AiStreamErrorCode =
  | 'configuration'
  | 'authentication'
  | 'provider'
  | 'network'
  | 'invalid-response';

export type AiStreamEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'complete' }
  | { readonly type: 'aborted' }
  | {
      readonly type: 'error';
      readonly code: AiStreamErrorCode;
      readonly message: string;
    };

export type AiFetchClient = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AiClient {
  stream(messages: readonly AiChatMessage[]): AsyncGenerator<AiStreamEvent, void>;
}

type ParsedFrame =
  | { readonly type: 'ignore' }
  | { readonly type: 'event'; readonly event: AiStreamEvent }
  | { readonly type: 'done' };

const SAFE_AUTHENTICATION_ERROR = 'AI 提供商拒绝了凭据，请检查 API key。';
const SAFE_PROVIDER_ERROR = 'AI 服务返回错误，请检查提供商设置。';
const SAFE_NETWORK_ERROR = '无法连接 AI 提供商，请稍后重试。';
const SAFE_MALFORMED_ERROR = 'AI 服务返回了无法解析的流数据。';
const SAFE_INTERRUPTED_ERROR = 'AI 响应流意外中断。';
const SAFE_INVALID_CONTENT_TYPE_ERROR = 'AI 服务返回了无效的流式响应。';
const SAFE_SIZE_LIMIT_ERROR = 'AI 响应超过安全大小限制。';

// Bound hostile or accidentally unbounded provider streams while leaving ample room for a report.
export const MAX_AI_SSE_BYTES = 2 * 1024 * 1024;
// Bound memory held before an SSE frame delimiter arrives.
export const MAX_AI_SSE_FRAME_BYTES = 256 * 1024;
// Bound report text retained by the UI and eligible for local draft persistence.
export const MAX_AI_REPORT_TEXT_BYTES = 512 * 1024;
// Flush accumulated UI text before it becomes expensive to retain or reconcile.
export const AI_DELTA_FLUSH_BYTES = 16 * 1024;
// Bound render frequency even when a provider emits one tiny SSE frame per network read.
export const AI_DELTA_FLUSH_FRAMES = 128;
// Keep subsequent streamed text perceptibly live when byte and frame thresholds are not reached.
export const AI_DELTA_FLUSH_INTERVAL_MS = 50;

export function buildChatCompletionsUrl(
  baseUrl: string,
  applicationOrigin = runtimeApplicationOrigin(),
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('AI base URL must be an absolute URL');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('AI base URL must not contain credentials');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError('AI base URL must not contain a query or fragment');
  }
  if (applicationOrigin !== undefined) {
    const applicationUrl = new URL(applicationOrigin);
    if (canonicalOrigin(url) === canonicalOrigin(applicationUrl)) {
      throw new TypeError('AI base URL must not use the application origin');
    }
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new TypeError('AI base URL must use HTTPS except for localhost or loopback testing');
  }

  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/chat/completions`;
  return url.toString();
}

export function createAiClient(
  configuration: AiClientConfiguration,
  fetchClient: AiFetchClient = fetch,
): AiClient {
  return {
    stream: (messages) =>
      streamChatCompletion(configuration, messages, fetchClient, runtimeApplicationOrigin()),
  };
}

async function* streamChatCompletion(
  configuration: AiClientConfiguration,
  messages: readonly AiChatMessage[],
  fetchClient: AiFetchClient,
  applicationOrigin: string | undefined,
): AsyncGenerator<AiStreamEvent, void> {
  if (configuration.signal.aborted) {
    yield { type: 'aborted' };
    return;
  }

  let requestUrl: string;
  try {
    requestUrl = buildChatCompletionsUrl(configuration.baseUrl, applicationOrigin);
    if (configuration.model.trim().length === 0 || configuration.apiKey.trim().length === 0) {
      throw new TypeError('Model and API key are required');
    }
  } catch {
    yield {
      type: 'error',
      code: 'configuration',
      message: 'AI 提供商地址、模型或 API key 配置无效。',
    };
    return;
  }

  let response: Response;
  try {
    response = await fetchClient(requestUrl, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${configuration.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: configuration.model, messages, stream: true }),
      signal: configuration.signal,
      redirect: 'error',
    });
  } catch {
    yield configuration.signal.aborted
      ? { type: 'aborted' }
      : { type: 'error', code: 'network', message: SAFE_NETWORK_ERROR };
    return;
  }

  if (!response.ok) {
    await cancelBodySafely(response.body);
    yield response.status === 401 || response.status === 403
      ? { type: 'error', code: 'authentication', message: SAFE_AUTHENTICATION_ERROR }
      : { type: 'error', code: 'provider', message: SAFE_PROVIDER_ERROR };
    return;
  }

  if (!isEventStreamContentType(response.headers.get('content-type'))) {
    await cancelBodySafely(response.body);
    yield {
      type: 'error',
      code: 'invalid-response',
      message: SAFE_INVALID_CONTENT_TYPE_ERROR,
    };
    return;
  }

  if (response.body === null) {
    yield { type: 'error', code: 'invalid-response', message: SAFE_INTERRUPTED_ERROR };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reachedDone = false;
  let rawBytes = 0;
  let reportBytes = 0;
  let pendingDelta = '';
  let pendingDeltaBytes = 0;
  let pendingDeltaFrames = 0;
  let emittedFirstDelta = false;
  let lastDeltaFlushAt = Date.now();
  let outstandingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const takePendingDelta = (): AiStreamEvent | undefined => {
    if (pendingDelta.length === 0) {
      return undefined;
    }
    const event: AiStreamEvent = { type: 'delta', text: pendingDelta };
    pendingDelta = '';
    pendingDeltaBytes = 0;
    pendingDeltaFrames = 0;
    emittedFirstDelta = true;
    lastDeltaFlushAt = Date.now();
    return event;
  };
  const appendDelta = (text: string, bytes: number): AiStreamEvent | undefined => {
    pendingDelta += text;
    pendingDeltaBytes += bytes;
    pendingDeltaFrames += 1;
    const shouldFlush =
      !emittedFirstDelta ||
      pendingDeltaBytes >= AI_DELTA_FLUSH_BYTES ||
      pendingDeltaFrames >= AI_DELTA_FLUSH_FRAMES ||
      Date.now() - lastDeltaFlushAt >= AI_DELTA_FLUSH_INTERVAL_MS;
    return shouldFlush ? takePendingDelta() : undefined;
  };
  const cancelReader = () => {
    void cancelReaderSafely(reader);
  };
  configuration.signal.addEventListener('abort', cancelReader, { once: true });

  try {
    while (!reachedDone) {
      if (configuration.signal.aborted) {
        const pendingEvent = takePendingDelta();
        if (pendingEvent !== undefined) {
          yield pendingEvent;
        }
        yield { type: 'aborted' };
        return;
      }

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        outstandingRead ??= reader.read();
        if (pendingDelta.length > 0 && emittedFirstDelta) {
          const remainingDelay = Math.max(
            0,
            AI_DELTA_FLUSH_INTERVAL_MS - (Date.now() - lastDeltaFlushAt),
          );
          if (remainingDelay === 0) {
            const pendingEvent = takePendingDelta();
            if (pendingEvent !== undefined) {
              yield pendingEvent;
            }
            continue;
          }
          const outcome = await readUntilFlushDeadline(outstandingRead, remainingDelay);
          if (outcome.type === 'flush') {
            const pendingEvent = takePendingDelta();
            if (pendingEvent !== undefined) {
              yield pendingEvent;
            }
            continue;
          }
          result = outcome.result;
        } else {
          result = await outstandingRead;
        }
        outstandingRead = undefined;
      } catch {
        outstandingRead = undefined;
        const pendingEvent = takePendingDelta();
        if (pendingEvent !== undefined) {
          yield pendingEvent;
        }
        yield configuration.signal.aborted
          ? { type: 'aborted' }
          : { type: 'error', code: 'network', message: SAFE_NETWORK_ERROR };
        return;
      }

      if (result.done) {
        buffer += decoder.decode();
        break;
      }
      rawBytes += result.value.byteLength;
      if (rawBytes > MAX_AI_SSE_BYTES) {
        const pendingEvent = takePendingDelta();
        if (pendingEvent !== undefined) {
          yield pendingEvent;
        }
        yield sizeLimitError();
        return;
      }
      buffer += decoder.decode(result.value, { stream: true });

      const extracted = extractFrames(buffer);
      buffer = extracted.remaining;
      if (utf8ByteLength(buffer) > MAX_AI_SSE_FRAME_BYTES) {
        const pendingEvent = takePendingDelta();
        if (pendingEvent !== undefined) {
          yield pendingEvent;
        }
        yield sizeLimitError();
        return;
      }
      const readyDeltas: AiStreamEvent[] = [];
      let terminalEvent: AiStreamEvent | undefined;
      for (const frame of extracted.frames) {
        if (utf8ByteLength(frame) > MAX_AI_SSE_FRAME_BYTES) {
          terminalEvent = sizeLimitError();
          break;
        }
        const parsed = parseFrame(frame);
        if (parsed.type === 'ignore') {
          continue;
        }
        if (parsed.type === 'done') {
          reachedDone = true;
          break;
        }
        if (parsed.event.type === 'delta') {
          const nextBytes = utf8ByteLength(parsed.event.text);
          if (reportBytes + nextBytes > MAX_AI_REPORT_TEXT_BYTES) {
            terminalEvent = sizeLimitError();
            break;
          }
          reportBytes += nextBytes;
          const readyDelta = appendDelta(parsed.event.text, nextBytes);
          if (readyDelta !== undefined) {
            readyDeltas.push(readyDelta);
          }
          continue;
        }
        if (parsed.event.type === 'error') {
          terminalEvent = parsed.event;
          break;
        }
      }
      if (terminalEvent !== undefined || reachedDone) {
        const pendingEvent = takePendingDelta();
        if (pendingEvent !== undefined) {
          readyDeltas.push(pendingEvent);
        }
      }
      for (const event of readyDeltas) {
        yield event;
      }
      if (terminalEvent !== undefined) {
        yield terminalEvent;
        return;
      }
    }

    if (!reachedDone && buffer.trim().length > 0) {
      if (utf8ByteLength(buffer) > MAX_AI_SSE_FRAME_BYTES) {
        const pendingEvent = takePendingDelta();
        if (pendingEvent !== undefined) {
          yield pendingEvent;
        }
        yield sizeLimitError();
        return;
      }
      const parsed = parseFrame(buffer);
      if (parsed.type === 'done') {
        reachedDone = true;
      } else if (parsed.type === 'event') {
        if (parsed.event.type === 'delta') {
          const nextBytes = utf8ByteLength(parsed.event.text);
          if (reportBytes + nextBytes > MAX_AI_REPORT_TEXT_BYTES) {
            const pendingEvent = takePendingDelta();
            if (pendingEvent !== undefined) {
              yield pendingEvent;
            }
            yield sizeLimitError();
            return;
          }
          reportBytes += nextBytes;
          const readyDelta = appendDelta(parsed.event.text, nextBytes);
          if (readyDelta !== undefined) {
            yield readyDelta;
          }
        } else {
          const pendingEvent = takePendingDelta();
          if (pendingEvent !== undefined) {
            yield pendingEvent;
          }
          yield parsed.event;
          return;
        }
      }
    }

    const pendingEvent = takePendingDelta();
    if (pendingEvent !== undefined) {
      yield pendingEvent;
    }

    if (configuration.signal.aborted) {
      yield { type: 'aborted' };
    } else if (reachedDone) {
      yield { type: 'complete' };
    } else {
      yield { type: 'error', code: 'invalid-response', message: SAFE_INTERRUPTED_ERROR };
    }
  } finally {
    configuration.signal.removeEventListener('abort', cancelReader);
    await cancelReaderSafely(reader);
    reader.releaseLock();
  }
}

function extractFrames(buffer: string): { readonly frames: readonly string[]; remaining: string } {
  const frames: string[] = [];
  let remaining = buffer;
  while (true) {
    const boundary = /\r?\n\r?\n/.exec(remaining);
    if (boundary?.index === undefined) {
      break;
    }
    frames.push(remaining.slice(0, boundary.index));
    remaining = remaining.slice(boundary.index + boundary[0].length);
  }
  return { frames, remaining };
}

function parseFrame(frame: string): ParsedFrame {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');

  if (data.length === 0) {
    return { type: 'ignore' };
  }
  if (data.trim() === '[DONE]') {
    return { type: 'done' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return {
      type: 'event',
      event: { type: 'error', code: 'invalid-response', message: SAFE_MALFORMED_ERROR },
    };
  }

  if (isRecord(payload) && 'error' in payload) {
    return {
      type: 'event',
      event: { type: 'error', code: 'provider', message: SAFE_PROVIDER_ERROR },
    };
  }

  const content = readDeltaContent(payload);
  return content === undefined || content.length === 0
    ? { type: 'ignore' }
    : { type: 'event', event: { type: 'delta', text: content } };
}

function readDeltaContent(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return undefined;
  }
  const firstChoice: unknown = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.delta)) {
    return undefined;
  }
  return typeof firstChoice.delta.content === 'string' ? firstChoice.delta.content : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname.endsWith('.localhost') ||
    normalizedHostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalizedHostname)
  );
}

function isEventStreamContentType(contentType: string | null): boolean {
  return contentType !== null && /^text\/event-stream(?:\s*;|\s*$)/i.test(contentType.trim());
}

function canonicalOrigin(url: URL): string {
  return `${url.protocol}//${normalizeHostname(url.hostname)}:${effectivePort(url)}`;
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith('[') ? normalized : normalized.replace(/\.+$/, '');
}

function effectivePort(url: URL): string {
  if (url.port.length > 0) {
    return url.port;
  }
  if (url.protocol === 'https:') {
    return '443';
  }
  if (url.protocol === 'http:') {
    return '80';
  }
  return '';
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sizeLimitError(): AiStreamEvent {
  return { type: 'error', code: 'invalid-response', message: SAFE_SIZE_LIMIT_ERROR };
}

async function cancelBodySafely(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) {
    return;
  }
  try {
    await body.cancel();
  } catch {
    // Cancellation is cleanup only; provider details must never escape through this path.
  }
}

async function cancelReaderSafely(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is cleanup only; provider details must never escape through this path.
  }
}

type ReadDeadlineOutcome =
  | { readonly type: 'read'; readonly result: ReadableStreamReadResult<Uint8Array> }
  | { readonly type: 'flush' };

function readUntilFlushDeadline(
  read: Promise<ReadableStreamReadResult<Uint8Array>>,
  delayMilliseconds: number,
): Promise<ReadDeadlineOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ type: 'flush' });
    }, delayMilliseconds);
    void read.then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ type: 'read', result });
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}

function runtimeApplicationOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin;
}
