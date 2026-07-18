import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface TypeScriptConfig {
  compilerOptions?: {
    lib?: string[];
    types?: string[];
  };
  exclude?: string[];
  include?: string[];
  references?: Array<{ path: string }>;
}

const projectRoot = resolve(import.meta.dirname, '../..');

function readConfig(fileName: string): TypeScriptConfig {
  return JSON.parse(readFileSync(join(projectRoot, fileName), 'utf8')) as TypeScriptConfig;
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === 'server' ? [] : listTypeScriptFiles(path);
    }

    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

function importedModules(source: string): string[] {
  return Array.from(
    source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)(['"])([^'"]+)\1/g),
  ).flatMap((match) => (match[2] ? [match[2]] : []));
}

describe('TypeScript project boundaries', () => {
  it('typechecks browser, tooling, and server code in distinct ambient environments', () => {
    const rootConfig = readConfig('tsconfig.json');
    const appConfig = readConfig('tsconfig.app.json');
    const serverConfigPath = join(projectRoot, 'tsconfig.server.json');

    expect(rootConfig.references?.map(({ path }) => path)).toContain('./tsconfig.server.json');
    expect(appConfig.exclude).toContain('src/server/**');
    expect(existsSync(serverConfigPath)).toBe(true);

    if (!existsSync(serverConfigPath)) {
      return;
    }

    const serverConfig = readConfig('tsconfig.server.json');

    expect(serverConfig.include).toEqual(
      expect.arrayContaining([
        'api/**/*.ts',
        'src/server/**/*.ts',
        'src/domain/**/*.ts',
        'tests/types/server-project.ts',
      ]),
    );
    expect(serverConfig.compilerOptions?.types).toContain('node');
    expect(serverConfig.compilerOptions?.lib).not.toContain('DOM');
    expect(serverConfig.compilerOptions?.lib).not.toContain('DOM.Iterable');
  });

  it('keeps browser and shared source imports out of the server implementation', () => {
    const violations = listTypeScriptFiles(join(projectRoot, 'src')).flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const serverImport = importedModules(source).find((moduleName) =>
        /(?:^|\/)server(?:\/|$)/.test(moduleName),
      );

      return serverImport ? [`${relative(projectRoot, filePath)} -> ${serverImport}`] : [];
    });

    expect(violations).toEqual([]);
  });
});
