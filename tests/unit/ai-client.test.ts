import { describe, expect, it, vi } from 'vitest';

import {
  MAX_AI_REPORT_TEXT_BYTES,
  MAX_AI_SSE_BYTES,
  MAX_AI_SSE_FRAME_BYTES,
  buildChatCompletionsUrl,
  createAiClient,
  type AiFetchClient,
  type AiStreamEvent,
} from '../../src/ai/client';

const MESSAGES = [
  { role: 'system' as const, content: 'Use only supplied data.' },
  { role: 'user' as const, content: 'Generate the report.' },
];

function streamResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );
}

async function collect(client: ReturnType<typeof createAiClient>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of client.stream(MESSAGES)) {
    events.push(event);
  }
  return events;
}

describe('OpenAI-compatible browser client', () => {
  it('posts directly to the configured provider without logging headers', async () => {
    const fetchClient = vi.fn<AiFetchClient>(async () =>
      streamResponse(['data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n']),
    );
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const controller = new AbortController();
    const events = await collect(
      createAiClient(
        {
          baseUrl: 'https://provider.example/v1/',
          model: 'research-model',
          apiKey: 'sk-browser-secret',
          signal: controller.signal,
        },
        fetchClient,
      ),
    );

    expect(events).toEqual([{ type: 'delta', text: '完成' }, { type: 'complete' }]);
    expect(fetchClient).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchClient.mock.calls[0] ?? [];
    expect(requestUrl).toBe('https://provider.example/v1/chat/completions');
    expect(new URL(String(requestUrl)).pathname).not.toMatch(/^\/api(?:\/|$)/);
    expect(requestInit?.signal).toBe(controller.signal);
    expect(requestInit?.redirect).toBe('error');
    expect(requestInit?.headers).toEqual({
      accept: 'text/event-stream',
      authorization: 'Bearer sk-browser-secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: 'research-model',
      messages: MESSAGES,
      stream: true,
    });
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('parses data frames split across chunks and stops at [DONE]', async () => {
    const fetchClient: AiFetchClient = async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"con',
        'tent":"第一"}}]}\r\n\r\ndata: {"choices":[{"delta":',
        '{"content":"节"}}]}\n\ndata: [DO',
        'NE]\n\ndata: {"choices":[{"delta":{"content":"不应读取"}}]}\n\n',
      ]);

    await expect(
      collect(
        createAiClient(
          {
            baseUrl: 'https://provider.example/v1',
            model: 'research-model',
            apiKey: 'secret',
            signal: new AbortController().signal,
          },
          fetchClient,
        ),
      ),
    ).resolves.toEqual([
      { type: 'delta', text: '第一' },
      { type: 'delta', text: '节' },
      { type: 'complete' },
    ]);
  });

  it('maps a 401 response to a safe authentication error without reading its body', async () => {
    const response = new Response('upstream body with sk-browser-secret', { status: 401 });
    const textSpy = vi.spyOn(response, 'text');
    const events = await collect(
      createAiClient(
        {
          baseUrl: 'https://provider.example/v1',
          model: 'research-model',
          apiKey: 'sk-browser-secret',
          signal: new AbortController().signal,
        },
        async () => response,
      ),
    );

    expect(events).toEqual([
      {
        type: 'error',
        code: 'authentication',
        message: 'AI 提供商拒绝了凭据，请检查 API key。',
      },
    ]);
    expect(textSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('sk-browser-secret');
    expect(JSON.stringify(events)).not.toContain('upstream body');
  });

  it.each([
    [
      'malformed JSON',
      ['data: {not-json}\n\n'],
      'invalid-response',
      'AI 服务返回了无法解析的流数据。',
    ],
    [
      'a provider error frame',
      ['data: {"error":{"message":"leaked sk-browser-secret"}}\n\n'],
      'provider',
      'AI 服务返回错误，请检查提供商设置。',
    ],
    [
      'an unterminated stream',
      ['data: {"choices":[{"delta":{"content":"draft"}}]}\n\n'],
      'invalid-response',
      'AI 响应流意外中断。',
    ],
  ])('returns a typed safe error for %s', async (_name, chunks, code, message) => {
    const events = await collect(
      createAiClient(
        {
          baseUrl: 'https://provider.example/v1',
          model: 'research-model',
          apiKey: 'sk-browser-secret',
          signal: new AbortController().signal,
        },
        async () => streamResponse(chunks),
      ),
    );

    expect(events.at(-1)).toEqual({ type: 'error', code, message });
    expect(JSON.stringify(events)).not.toContain('sk-browser-secret');
    expect(JSON.stringify(events)).not.toContain('leaked');
  });

  it('maps network failures to a safe error without exposing exception details', async () => {
    const events = await collect(
      createAiClient(
        {
          baseUrl: 'https://provider.example/v1',
          model: 'research-model',
          apiKey: 'sk-browser-secret',
          signal: new AbortController().signal,
        },
        async () => {
          throw new Error('network leaked sk-browser-secret');
        },
      ),
    );

    expect(events).toEqual([
      { type: 'error', code: 'network', message: '无法连接 AI 提供商，请稍后重试。' },
    ]);
    expect(JSON.stringify(events)).not.toContain('sk-browser-secret');
    expect(JSON.stringify(events)).not.toContain('network leaked');
  });

  it('returns aborted without fetching when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchClient = vi.fn<AiFetchClient>();

    const events = await collect(
      createAiClient(
        {
          baseUrl: 'https://provider.example/v1',
          model: 'research-model',
          apiKey: 'secret',
          signal: controller.signal,
        },
        fetchClient,
      ),
    );

    expect(events).toEqual([{ type: 'aborted' }]);
    expect(fetchClient).not.toHaveBeenCalled();
  });

  it('returns aborted when cancellation happens during streaming', async () => {
    const controller = new AbortController();
    const client = createAiClient(
      {
        baseUrl: 'https://provider.example/v1',
        model: 'research-model',
        apiKey: 'secret',
        signal: controller.signal,
      },
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"草稿"}}]}\n\n'),
              );
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        ),
    );
    const iterator = client.stream(MESSAGES);

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'delta', text: '草稿' },
    });
    controller.abort();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'aborted' },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('normalizes only the trailing slash and rejects unsafe remote HTTP endpoints', () => {
    expect(buildChatCompletionsUrl('https://provider.example/custom/path/')).toBe(
      'https://provider.example/custom/path/chat/completions',
    );
    expect(buildChatCompletionsUrl('http://localhost:11434/v1/')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
    expect(buildChatCompletionsUrl('http://127.0.0.1:8080/v1')).toBe(
      'http://127.0.0.1:8080/v1/chat/completions',
    );
    expect(() => buildChatCompletionsUrl('http://provider.example/v1')).toThrow(/HTTPS/i);
  });

  it.each([
    'https://stocks.example/v1',
    'https://stocks.example/%61pi/provider',
    'https://stocks.example//double/slash',
  ])('rejects every same-origin provider path before fetch: %s', async (baseUrl) => {
    const fetchClient = vi.fn<AiFetchClient>(async () => streamResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('window', { location: { origin: 'https://stocks.example' } });
    const events = await collect(
      createAiClient(
        {
          baseUrl,
          model: 'research-model',
          apiKey: 'sk-same-origin-secret',
          signal: new AbortController().signal,
        },
        fetchClient,
      ),
    );
    vi.unstubAllGlobals();

    expect(fetchClient).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: 'error',
        code: 'configuration',
        message: 'AI 提供商地址、模型或 API key 配置无效。',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('sk-same-origin-secret');
    expect(JSON.stringify(events)).not.toContain('Generate the report');
  });

  it('does not let an extra configuration origin bypass the real application origin', async () => {
    const fetchClient = vi.fn<AiFetchClient>(async () => streamResponse(['data: [DONE]\n\n']));
    const configuration = {
      baseUrl: 'https://stocks.example/v1',
      applicationOrigin: 'https://attacker.example',
      model: 'research-model',
      apiKey: 'sk-same-origin-secret',
      signal: new AbortController().signal,
    };

    vi.stubGlobal('window', { location: { origin: 'https://stocks.example' } });
    const events = await collect(createAiClient(configuration, fetchClient));
    vi.unstubAllGlobals();

    expect(fetchClient).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: 'error',
        code: 'configuration',
        message: 'AI 提供商地址、模型或 API key 配置无效。',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('sk-same-origin-secret');
  });

  it('allows an external absolute provider whose base path contains /api', () => {
    expect(
      buildChatCompletionsUrl(
        'https://external-provider.example/api/openai/v1',
        'https://stocks.example',
      ),
    ).toBe('https://external-provider.example/api/openai/v1/chat/completions');
  });

  it.each([
    'https://stocks.example/v1',
    'https://stocks.example/%61pi/provider',
    'https://stocks.example//double/slash',
  ])('rejects a same-origin URL independent of its path spelling: %s', (baseUrl) => {
    expect(() => buildChatCompletionsUrl(baseUrl, 'https://stocks.example')).toThrow(
      /application|origin|same-origin/i,
    );
  });

  it.each([
    ['https://stocks.example./v1', 'https://stocks.example'],
    ['https://stocks.example:443/v1', 'https://stocks.example'],
    ['http://localhost:80/v1', 'http://localhost'],
  ])(
    'normalizes DNS trailing dots and effective default ports for same-origin checks',
    (baseUrl, origin) => {
      expect(() => buildChatCompletionsUrl(baseUrl, origin)).toThrow(/origin/i);
    },
  );

  it('treats protocol and non-default port as part of the origin boundary', () => {
    expect(buildChatCompletionsUrl('https://stocks.example:444/v1', 'https://stocks.example')).toBe(
      'https://stocks.example:444/v1/chat/completions',
    );
    expect(buildChatCompletionsUrl('https://localhost/v1', 'http://localhost')).toBe(
      'https://localhost/v1/chat/completions',
    );
  });

  it('rejects redirects at fetch and never issues a second or application-origin request', async () => {
    const fetchClient = vi.fn<AiFetchClient>(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError(
        'redirect from https://provider.example/v1 to https://stocks.example/api leaked secret',
      );
    });
    vi.stubGlobal('window', { location: { origin: 'https://stocks.example' } });

    const events = await collect(
      createAiClient(
        {
          baseUrl: 'https://provider.example/v1',
          model: 'research-model',
          apiKey: 'sk-browser-secret',
          signal: new AbortController().signal,
        },
        fetchClient,
      ),
    );
    vi.unstubAllGlobals();

    expect(fetchClient).toHaveBeenCalledOnce();
    expect(fetchClient.mock.calls[0]?.[0]).toBe('https://provider.example/v1/chat/completions');
    expect(events).toEqual([
      { type: 'error', code: 'network', message: '无法连接 AI 提供商，请稍后重试。' },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/stocks\.example|sk-browser-secret|leaked/);
  });

  it.each(['application/json', 'text/plain', '', 'text/event-streaming'])(
    'rejects a successful non-SSE response and cancels its body: %s',
    async (contentType) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('secret provider body'));
          },
          cancel,
        }),
        { status: 200, headers: contentType === '' ? {} : { 'content-type': contentType } },
      );

      const events = await collect(
        createAiClient(
          {
            baseUrl: 'https://provider.example/v1',
            model: 'research-model',
            apiKey: 'sk-browser-secret',
            signal: new AbortController().signal,
          },
          async () => response,
        ),
      );

      expect(events).toEqual([
        {
          type: 'error',
          code: 'invalid-response',
          message: 'AI 服务返回了无效的流式响应。',
        },
      ]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(events)).not.toMatch(/secret|provider body/);
    },
  );

  it('exports explicit UTF-8 byte limits for the raw stream, pending frame, and report', () => {
    expect(MAX_AI_SSE_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_AI_SSE_FRAME_BYTES).toBe(256 * 1024);
    expect(MAX_AI_REPORT_TEXT_BYTES).toBe(512 * 1024);
  });

  it.each([
    ['raw SSE stream', () => ['限'.repeat(Math.floor(MAX_AI_SSE_BYTES / 3) + 1)]],
    [
      'pending SSE frame',
      () => [`data: ${'限'.repeat(Math.floor(MAX_AI_SSE_FRAME_BYTES / 3) + 1)}`],
    ],
    [
      'report text',
      () => {
        const content = '限'.repeat(80_000);
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
        return [frame, frame, frame];
      },
    ],
  ])('rejects an oversized %s without leaking buffered content', async (_name, chunks) => {
    const events = await collect(
      createAiClient(
        {
          baseUrl: 'https://provider.example/v1',
          model: 'research-model',
          apiKey: 'secret',
          signal: new AbortController().signal,
        },
        async () => streamResponse(chunks()),
      ),
    );

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'invalid-response',
      message: 'AI 响应超过安全大小限制。',
    });
    if (_name === 'report text') {
      const retainedText = events
        .filter(
          (event): event is Extract<AiStreamEvent, { readonly type: 'delta' }> =>
            event.type === 'delta',
        )
        .map((event) => event.text)
        .join('');
      expect(new TextEncoder().encode(retainedText).byteLength).toBeLessThanOrEqual(
        MAX_AI_REPORT_TEXT_BYTES,
      );
    } else {
      expect(JSON.stringify(events)).not.toContain('限'.repeat(100));
    }
  });

  it('merges all deltas parsed from one reader batch into one UI update', async () => {
    const frames = Array.from(
      { length: 1_000 },
      () => 'data: {"choices":[{"delta":{"content":"字"}}]}\n\n',
    ).join('');
    const events = await collect(
      createAiClient(
        {
          baseUrl: 'https://provider.example/v1',
          model: 'research-model',
          apiKey: 'secret',
          signal: new AbortController().signal,
        },
        async () => streamResponse([`${frames}data: [DONE]\n\n`]),
      ),
    );

    expect(events).toEqual([{ type: 'delta', text: '字'.repeat(1_000) }, { type: 'complete' }]);
  });

  it('cancels an open reader after [DONE] and does not wait for another chunk', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        },
        cancel,
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

    await expect(
      collect(
        createAiClient(
          {
            baseUrl: 'https://provider.example/v1',
            model: 'research-model',
            apiKey: 'secret',
            signal: new AbortController().signal,
          },
          async () => response,
        ),
      ),
    ).resolves.toEqual([{ type: 'complete' }]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels the reader when a consumer returns early', async () => {
    const cancel = vi.fn();
    const client = createAiClient(
      {
        baseUrl: 'https://provider.example/v1',
        model: 'research-model',
        apiKey: 'secret',
        signal: new AbortController().signal,
      },
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'),
              );
            },
            cancel,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    for await (const event of client.stream(MESSAGES)) {
      expect(event).toEqual({ type: 'delta', text: 'first' });
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('swallows reader cancellation rejection after [DONE]', async () => {
    const cancel = vi.fn(async () => Promise.reject(new Error('cancel leaked secret')));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        },
        cancel,
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

    await expect(
      collect(
        createAiClient(
          {
            baseUrl: 'https://provider.example/v1',
            model: 'research-model',
            apiKey: 'secret',
            signal: new AbortController().signal,
          },
          async () => response,
        ),
      ),
    ).resolves.toEqual([{ type: 'complete' }]);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
