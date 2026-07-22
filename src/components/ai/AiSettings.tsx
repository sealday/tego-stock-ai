import { useState, type ChangeEvent } from 'react';

import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  sanitizeAiProviderSettings,
  validateAiProviderSettings,
  type AiProviderSettings,
  type SanitizedAiProviderSettings,
} from '../../ai/provider-settings';

export { DEFAULT_AI_PROVIDER_SETTINGS, sanitizeAiProviderSettings, validateAiProviderSettings };
export type {
  AiProviderSettings,
  AiProviderSettingsErrors,
  SanitizedAiProviderSettings,
} from '../../ai/provider-settings';

export interface AiSettingsProps {
  readonly value?: AiProviderSettings;
  readonly initialValue?: AiProviderSettings;
  readonly onChange?: (settings: AiProviderSettings) => void;
  readonly onSanitizedChange?: (settings: SanitizedAiProviderSettings) => void;
  readonly disabled?: boolean;
}

export function AiSettings({
  value,
  initialValue = DEFAULT_AI_PROVIDER_SETTINGS,
  onChange,
  onSanitizedChange,
  disabled = false,
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
    <section
      id="ai-settings"
      className="ai-settings"
      aria-labelledby="ai-settings-heading"
      tabIndex={-1}
    >
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
            disabled={disabled}
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
            disabled={disabled}
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
            disabled={disabled}
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
          disabled={disabled}
          aria-describedby="ai-remember-key-description"
          onChange={(event) => update({ ...settings, rememberApiKey: event.currentTarget.checked })}
        />
        <span>在此设备上记住 API key</span>
      </label>
      <p id="ai-remember-key-description" className="ai-settings__privacy-note">
        未勾选时 key 仅保留在当前页面会话；只有勾选后才表示同意将 key
        保存在当前浏览器。浏览器扩展或受损页面可能读取浏览器中的凭据。
      </p>

      {customEndpoint ? (
        <p className="ai-settings__warning" role="alert">
          自定义端点安全提示：浏览器扩展、受损页面或端点都可能访问您发送的凭据。请仅使用可信地址。
        </p>
      ) : null}

      <button
        type="button"
        className="ai-settings__clear"
        disabled={disabled || (settings.apiKey.length === 0 && !settings.rememberApiKey)}
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
