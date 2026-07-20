import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const projectRoot = new URL('../../', import.meta.url);

async function readProjectFile(path: string): Promise<string> {
  return readFile(new URL(path, projectRoot), 'utf8');
}

describe('operator documentation', () => {
  it('documents the verified local workflow, product boundary, and navigation', async () => {
    const readme = await readProjectFile('README.md');

    expect(readme).toMatch(/Node\.js.*20\.19\.0/i);
    expect(readme).toContain('npm ci');
    expect(readme).toContain('npm run dev');
    expect(readme).toContain('npm run ci:portable');
    expect(readme).toContain('npm run ci');
    expect(readme).toContain('Tushare Pro');
    expect(readme).toMatch(/日线收盘|daily-close/i);
    expect(readme).toMatch(/非实时|not real-time/i);
    expect(readme).toMatch(/BYOK|自带.*API/i);
    expect(readme).toMatch(/不构成投资建议|does not constitute investment advice/i);
    expect(readme).toMatch(/IndexedDB/);
    expect(readme).toContain('docs/architecture.md');
    expect(readme).toContain('docs/deployment.md');
    expect(readme).toContain('docs/privacy.md');
  });

  it('documents the implemented trust boundaries and public data contract', async () => {
    const architecture = await readProjectFile('docs/architecture.md');

    for (const route of [
      '/api/health',
      '/api/market/status',
      '/api/stocks/search',
      '/api/stocks/[code]/overview',
      '/api/stocks/[code]/history',
      '/api/stocks/[code]/fundamentals',
      '/api/cron/daily-close',
    ]) {
      expect(architecture).toContain(route);
    }
    expect(architecture).toMatch(/Vercel Functions/);
    expect(architecture).toMatch(/Tushare Pro/);
    expect(architecture).toMatch(/浏览器.*OpenAI-compatible|OpenAI-compatible.*浏览器/s);
    expect(architecture).toMatch(/不(?:会|经过).*Vercel Functions/s);
    for (const envelopeField of ['asOf', 'source', 'freshness', 'availability', 'limitations']) {
      expect(architecture).toContain(envelopeField);
    }
    expect(architecture).toMatch(/上一(?:次|个).*成功.*快照|last-good snapshot/i);
  });

  it('documents Vercel configuration, protected Cron, smoke, and rollback', async () => {
    const [deployment, environmentExample, vercelSource] = await Promise.all([
      readProjectFile('docs/deployment.md'),
      readProjectFile('.env.example'),
      readProjectFile('vercel.json'),
    ]);
    const vercel: unknown = JSON.parse(vercelSource);

    for (const variable of [
      'TUSHARE_TOKEN',
      'CRON_SECRET',
      'BLOB_STORE_ID',
      'BLOB_READ_WRITE_TOKEN',
      'PUBLIC_APP_ORIGIN',
    ]) {
      expect(deployment).toContain(variable);
      expect(environmentExample).toContain(`${variable}=`);
    }
    expect(deployment).toMatch(/GitHub.*Vercel|Vercel.*GitHub/s);
    for (const environment of ['Production', 'Preview', 'Development']) {
      expect(deployment).toContain(environment);
    }
    expect(deployment).toMatch(/UTC/);
    expect(deployment).toMatch(/16:30.*Asia\/Shanghai|Asia\/Shanghai.*16:30/s);
    expect(deployment).toMatch(/Cron.*(?:方案|套餐|plan)|(?:方案|套餐|plan).*Cron/is);
    expect(deployment).toMatch(/Authorization/);
    expect(deployment).toContain('/api/health');
    expect(deployment).toContain('npm run smoke:deployment -- https://');
    expect(deployment).toMatch(/回滚|rollback/i);
    expect(deployment).toMatch(/last-good|上一个.*成功/i);
    expect(deployment).toMatch(/connect-src/);

    expect(vercel).toMatchObject({
      crons: [{ path: '/api/cron/daily-close', schedule: '30 8 * * 1-5' }],
      rewrites: [{ source: '/(.*)', destination: '/index.html' }],
    });
  });

  it('documents local-only privacy controls and the custom-provider tradeoff', async () => {
    const privacy = await readProjectFile('docs/privacy.md');

    expect(privacy).toMatch(/IndexedDB/);
    expect(privacy).toMatch(/会话|session/i);
    expect(privacy).toMatch(/明确.*(?:同意|选择)|explicit.*(?:consent|opt-in)/is);
    expect(privacy).toMatch(/扩展|extension/i);
    expect(privacy).toMatch(/受损|compromised/i);
    expect(privacy).toMatch(/不会.*(?:项目|本项目).*服务器|never.*project.*server/is);
    expect(privacy).toMatch(/不.*日志|never.*log/is);
    expect(privacy).toMatch(/导出.*不.*API|API.*不.*导出/is);
    expect(privacy).toMatch(/清除.*凭据|clear.*credential/is);
    expect(privacy).toMatch(/清除.*全部|clear all/is);
    expect(privacy).toMatch(/自定义.*端点.*(?:接收|看到)|custom endpoint.*receive/is);
    expect(privacy).toMatch(/connect-src/);
    expect(privacy).toMatch(/无.*(?:账户|账号)|no account/i);
    expect(privacy).toMatch(/无.*(?:遥测|分析)|no (?:telemetry|analytics)/i);
  });

  it('keeps tracked examples and documentation free of secret-like values', async () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: new URL('.', projectRoot),
      encoding: 'utf8',
    })
      .split('\0')
      .filter((path) => path.length > 0 && path !== 'package-lock.json' && !path.endsWith('.png'));
    const requiredOperatorFiles = [
      'README.md',
      'docs/architecture.md',
      'docs/deployment.md',
      'docs/privacy.md',
      '.env.example',
      'vercel.json',
    ];
    const scanned = [...new Set([...tracked, ...requiredOperatorFiles])];
    const forbidden = [
      new RegExp(`s${'k'}-[A-Za-z0-9_-]{24,}`),
      new RegExp(`Bearer ${'[A-Za-z0-9._~-]{24,}'}`),
      new RegExp(`^TUSHARE_TOKEN=${'\\S+'}`, 'm'),
      new RegExp(`^CRON_SECRET=${'\\S+'}`, 'm'),
      new RegExp(`^BLOB_READ_WRITE_TOKEN=${'\\S+'}`, 'm'),
    ];

    for (const path of scanned) {
      const source = await readProjectFile(path);
      for (const pattern of forbidden) {
        expect(source, `${path} contains ${pattern.source}`).not.toMatch(pattern);
      }
    }

    const environmentExample = await readProjectFile('.env.example');
    const assignments = environmentExample
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((line) => /^[A-Z][A-Z0-9_]*=$/.test(line))).toBe(true);
    expect(tracked.filter(isEnvironmentFile)).toEqual(['.env.example']);
  });

  it('recognizes nested environment files before checking the tracked allowlist', () => {
    expect(isEnvironmentFile('.env')).toBe(true);
    expect(isEnvironmentFile('.env.example')).toBe(true);
    expect(isEnvironmentFile('config/.env.production')).toBe(true);
    expect(isEnvironmentFile('docs/environment.md')).toBe(false);
  });
});

function isEnvironmentFile(path: string): boolean {
  return /(?:^|\/)\.env(?:\.|$)/.test(path);
}
