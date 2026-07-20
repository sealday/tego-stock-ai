import { useState, type ChangeEvent } from 'react';

import { buildChatCompletionsUrl } from '../../ai/client';

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

export interface AiSettingsProps {
  readonly value?: AiProviderSettings;
  readonly initialValue?: AiProviderSettings;
  readonly onChange?: (settings: AiProviderSettings) => void;
  readonly onSanitizedChange?: (settings: SanitizedAiProviderSettings) => void;
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

export function AiSettings({
  value,
  initialValue = DEFAULT_AI_PROVIDER_SETTINGS,
  onChange,
  onSanitizedChange,
}: AiSettingsProps) {
  const [internalValue, setInternalValue] = useState<AiProviderSettings>(initialValue);
  const [touched, setTouched] = useState<ReadonlySet<keyof AiProviderSettings>>(new Set());
  const settings = value ?? internalValue;
  const errors = validateAiProviderSettings(settings);
  const customEndpoint = isCustomEndpoint(settings.baseUrl);

  const update = (next: AiProviderSettings) => {
    if (value === undefined) {
      setInternalValue(next);
    }
    onChange?.(next);
    onSanitizedChange?.(sanitizeAiProviderSettings(next));
  };

  const markTouched = (field: keyof AiProviderSettings) => {
    setTouched((current) => new Set(current).add(field));
  };

  const updateText =
    (field: 'baseUrl' | 'model' | 'apiKey') => (event: ChangeEvent<HTMLInputElement>) => {
      update({ ...settings, [field]: event.currentTarget.value });
    };

  return (
    <section id="ai-settings" className="ai-settings" aria-labelledby="ai-settings-heading">
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">浏览器内 BYOK</p>
          <h3 id="ai-settings-heading">AI 提供商设置</h3>
        </div>
        <span className="ai-settings__session-label">默认仅保留在当前页面会话内</span>
      </div>

      <div className="ai-settings__fields">
        <div className="ai-field">
          <label htmlFor="ai-base-url">OpenAI-compatible Base URL</label>
          <input
            id="ai-base-url"
            type="url"
            value={settings.baseUrl}
            aria-describedby="ai-base-url-description ai-base-url-error"
            aria-invalid={touched.has('baseUrl') && errors.baseUrl !== undefined}
            onChange={updateText('baseUrl')}
            onBlur={() => markTouched('baseUrl')}
          />
          <p id="ai-base-url-description">
            系统会在该地址后追加 /chat/completions，不会把请求转发到本站服务器。
          </p>
          {touched.has('baseUrl') && errors.baseUrl !== undefined ? (
            <p id="ai-base-url-error" className="ai-field__error" role="alert">
              {errors.baseUrl}
            </p>
          ) : null}
        </div>

        <div className="ai-field">
          <label htmlFor="ai-model">模型标识符</label>
          <input
            id="ai-model"
            type="text"
            value={settings.model}
            aria-describedby="ai-model-description ai-model-error"
            aria-invalid={touched.has('model') && errors.model !== undefined}
            aria-required="true"
            onChange={updateText('model')}
            onBlur={() => markTouched('model')}
          />
          <p id="ai-model-description">使用提供商文档给出的准确模型标识符。</p>
          {touched.has('model') && errors.model !== undefined ? (
            <p id="ai-model-error" className="ai-field__error" role="alert">
              {errors.model}
            </p>
          ) : null}
        </div>

        <div className="ai-field">
          <label htmlFor="ai-api-key">API key</label>
          <input
            id="ai-api-key"
            type="password"
            autoComplete="off"
            value={settings.apiKey}
            aria-describedby="ai-api-key-description ai-api-key-error"
            aria-invalid={touched.has('apiKey') && errors.apiKey !== undefined}
            aria-required="true"
            onChange={updateText('apiKey')}
            onBlur={() => markTouched('apiKey')}
          />
          <p id="ai-api-key-description">
            key 直接从浏览器发送给所选提供商；不会进入本站 API、日志或导出设置。
          </p>
          {touched.has('apiKey') && errors.apiKey !== undefined ? (
            <p id="ai-api-key-error" className="ai-field__error" role="alert">
              {errors.apiKey}
            </p>
          ) : null}
        </div>
      </div>

      <label className="ai-settings__remember" htmlFor="ai-remember-key">
        <input
          id="ai-remember-key"
          type="checkbox"
          checked={settings.rememberApiKey}
          aria-describedby="ai-remember-key-description"
          onChange={(event) => update({ ...settings, rememberApiKey: event.currentTarget.checked })}
        />
        <span>在此设备上记住 API key</span>
      </label>
      <p id="ai-remember-key-description" className="ai-settings__privacy-note">
        只有勾选后才表示持久化同意；当前版本仍只保存在内存中。浏览器扩展或受损页面可能读取浏览器中的凭据。
      </p>

      {customEndpoint ? (
        <p className="ai-settings__warning" role="alert">
          自定义端点安全提示：浏览器扩展、受损页面或端点都可能访问您发送的凭据。请仅使用可信地址。
        </p>
      ) : null}

      <button
        type="button"
        className="ai-settings__clear"
        disabled={settings.apiKey.length === 0 && !settings.rememberApiKey}
        onClick={() => update({ ...settings, apiKey: '', rememberApiKey: false })}
      >
        清除凭据
      </button>
    </section>
  );
}

function isCustomEndpoint(baseUrl: string): boolean {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return normalized.length > 0 && normalized !== DEFAULT_AI_PROVIDER_SETTINGS.baseUrl;
}
