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

export function buildChatCompletionsUrl(baseUrl: string): string {
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
    stream: (messages) => streamChatCompletion(configuration, messages, fetchClient),
  };
}

async function* streamChatCompletion(
  configuration: AiClientConfiguration,
  messages: readonly AiChatMessage[],
  fetchClient: AiFetchClient,
): AsyncGenerator<AiStreamEvent, void> {
  if (configuration.signal.aborted) {
    yield { type: 'aborted' };
    return;
  }

  let requestUrl: string;
  try {
    requestUrl = buildChatCompletionsUrl(configuration.baseUrl);
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
    });
  } catch {
    yield configuration.signal.aborted
      ? { type: 'aborted' }
      : { type: 'error', code: 'network', message: SAFE_NETWORK_ERROR };
    return;
  }

  if (!response.ok) {
    yield response.status === 401 || response.status === 403
      ? { type: 'error', code: 'authentication', message: SAFE_AUTHENTICATION_ERROR }
      : { type: 'error', code: 'provider', message: SAFE_PROVIDER_ERROR };
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
  const cancelReader = () => {
    void reader.cancel();
  };
  configuration.signal.addEventListener('abort', cancelReader, { once: true });

  try {
    while (!reachedDone) {
      if (configuration.signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        yield configuration.signal.aborted
          ? { type: 'aborted' }
          : { type: 'error', code: 'network', message: SAFE_NETWORK_ERROR };
        return;
      }

      if (result.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });

      const extracted = extractFrames(buffer);
      buffer = extracted.remaining;
      for (const frame of extracted.frames) {
        const parsed = parseFrame(frame);
        if (parsed.type === 'ignore') {
          continue;
        }
        if (parsed.type === 'done') {
          reachedDone = true;
          break;
        }
        yield parsed.event;
        if (parsed.event.type === 'error') {
          return;
        }
      }
    }

    if (!reachedDone && buffer.trim().length > 0) {
      const parsed = parseFrame(buffer);
      if (parsed.type === 'done') {
        reachedDone = true;
      } else if (parsed.type === 'event') {
        yield parsed.event;
        if (parsed.event.type === 'error') {
          return;
        }
      }
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
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}
