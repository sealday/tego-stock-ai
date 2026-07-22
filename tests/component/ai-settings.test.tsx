import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  AiSettings,
  DEFAULT_AI_PROVIDER_SETTINGS,
  sanitizeAiProviderSettings,
  type AiProviderSettings,
} from '../../src/components/ai/AiSettings';

describe('AiSettings', () => {
  it('starts with a session-only key and requires explicit remember consent', () => {
    render(<AiSettings />);

    expect(screen.getByLabelText('OpenAI-compatible Base URL')).toHaveProperty(
      'value',
      'https://api.openai.com/v1',
    );
    expect(screen.getByLabelText('模型标识符')).toHaveProperty('value', '');
    expect(screen.getByLabelText('API key')).toHaveProperty('type', 'password');
    expect(screen.getByRole('checkbox', { name: '在此设备上记住 API key' })).toHaveProperty(
      'checked',
      false,
    );
    expect(screen.getByText(/默认仅保留在当前页面会话内/)).toBeVisible();
  });

  it('updates in memory without writing localStorage and emits an explicitly consented value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(settings: AiProviderSettings) => void>();
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    render(<AiSettings onChange={onChange} />);

    await user.type(screen.getByLabelText('模型标识符'), 'research-model');
    await user.type(screen.getByLabelText('API key'), 'sk-session-only');
    await user.click(screen.getByRole('checkbox', { name: '在此设备上记住 API key' }));

    expect(storageSpy).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith({
      baseUrl: 'https://api.openai.com/v1',
      model: 'research-model',
      apiKey: 'sk-session-only',
      rememberApiKey: true,
    });
    storageSpy.mockRestore();
  });

  it('shows a visible credential warning for custom endpoints', async () => {
    const user = userEvent.setup();
    render(<AiSettings />);

    const baseUrl = screen.getByLabelText('OpenAI-compatible Base URL');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://provider.example/v1');

    expect(screen.getByRole('alert').textContent).toMatch(/自定义端点/);
    expect(screen.getByRole('alert').textContent).toMatch(/浏览器扩展/);
    expect(screen.getByRole('alert').textContent).toMatch(/受损页面或端点/);
  });

  it('exposes accessible field descriptions and rejects unsafe remote HTTP', async () => {
    const user = userEvent.setup();
    render(<AiSettings />);

    const baseUrl = screen.getByLabelText('OpenAI-compatible Base URL');
    expect(baseUrl.getAttribute('aria-describedby')).toContain('ai-base-url-description');
    expect(screen.getByText(/系统会在该地址后追加/)).toBeVisible();
    await user.clear(baseUrl);
    await user.type(baseUrl, 'http://provider.example/v1');
    await user.tab();

    expect(baseUrl.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/必须使用 HTTPS/)).toBeVisible();
    expect(screen.getByLabelText('模型标识符').getAttribute('aria-required')).toBe('true');
    expect(screen.getByLabelText('API key').getAttribute('aria-required')).toBe('true');
  });

  it('clears credentials immediately and revokes remember consent', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(settings: AiProviderSettings) => void>();
    render(
      <AiSettings
        initialValue={{
          ...DEFAULT_AI_PROVIDER_SETTINGS,
          model: 'research-model',
          apiKey: 'sk-sensitive',
          rememberApiKey: true,
        }}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: '清除凭据' }));

    expect(screen.getByLabelText('API key')).toHaveProperty('value', '');
    expect(screen.getByRole('checkbox', { name: '在此设备上记住 API key' })).toHaveProperty(
      'checked',
      false,
    );
    expect(onChange).toHaveBeenLastCalledWith({
      baseUrl: 'https://api.openai.com/v1',
      model: 'research-model',
      apiKey: '',
      rememberApiKey: false,
    });
  });

  it('produces exportable settings that cannot contain the API key', () => {
    const sanitized = sanitizeAiProviderSettings({
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      apiKey: 'sk-must-not-export',
      rememberApiKey: true,
    });

    expect(sanitized).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      rememberApiKey: true,
    });
    expect(sanitized).not.toHaveProperty('apiKey');
    expect(JSON.stringify(sanitized)).not.toContain('sk-must-not-export');
  });
});
