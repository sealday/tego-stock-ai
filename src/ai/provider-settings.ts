import { buildChatCompletionsUrl } from './client';

export interface AiProviderSettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly rememberApiKey: boolean;
}

export type SanitizedAiProviderSettings = Omit<AiProviderSettings, 'apiKey'>;

export interface AiProviderSettingsErrors {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;
}

export const DEFAULT_AI_PROVIDER_SETTINGS: AiProviderSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  apiKey: '',
  rememberApiKey: false,
};

export function sanitizeAiProviderSettings(
  settings: AiProviderSettings,
): SanitizedAiProviderSettings {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    rememberApiKey: settings.rememberApiKey,
  };
}

export function validateAiProviderSettings(settings: AiProviderSettings): AiProviderSettingsErrors {
  let baseUrl: string | undefined;
  try {
    buildChatCompletionsUrl(settings.baseUrl);
  } catch {
    baseUrl = 'Base URL 必须使用 HTTPS；仅 localhost 或 loopback 本地测试可使用 HTTP。';
  }

  const model = settings.model.trim().length === 0 ? '请输入非空模型标识符。' : undefined;
  const apiKey = settings.apiKey.trim().length === 0 ? '请输入 API key。' : undefined;
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}
