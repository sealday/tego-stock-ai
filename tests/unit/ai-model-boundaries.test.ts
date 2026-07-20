import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  sanitizeAiProviderSettings,
  validateAiProviderSettings,
} from '../../src/ai/provider-settings';
import { createDraftReport } from '../../src/ai/report-model';
import type { ReportContext } from '../../src/ai/report-contract';

describe('AI domain model boundaries', () => {
  it('owns provider defaults, sanitization, and validation outside React components', () => {
    expect(DEFAULT_AI_PROVIDER_SETTINGS.baseUrl).toBe('https://api.openai.com/v1');
    expect(
      sanitizeAiProviderSettings({
        baseUrl: 'https://provider.example/v1',
        model: 'research-model',
        apiKey: 'sk-secret',
        rememberApiKey: true,
      }),
    ).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      rememberApiKey: true,
    });
    expect(validateAiProviderSettings(DEFAULT_AI_PROVIDER_SETTINGS)).toMatchObject({
      model: expect.any(String),
      apiKey: expect.any(String),
    });
  });

  it('constructs draft report models without importing a React component', () => {
    const context = { version: 1 } as ReportContext;
    const report = createDraftReport({
      context,
      settings: {
        baseUrl: 'https://provider.example/v1',
        model: 'research-model',
        apiKey: 'sk-secret',
        rememberApiKey: false,
      },
      rawText: 'partial',
      sections: [],
      reason: 'stream-interrupted',
      errorMessage: 'safe message',
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    });

    expect(report).toMatchObject({
      status: 'draft',
      interruptedAt: '2026-07-20T00:00:00.000Z',
      provider: { model: 'research-model', rememberApiKey: false },
      context,
      rawText: 'partial',
      reason: 'stream-interrupted',
      errorMessage: 'safe message',
    });
    expect(JSON.stringify(report)).not.toContain('sk-secret');
  });
});
