import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface LockPackage {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  integrity?: string;
  link?: boolean;
  resolved?: string;
}

interface PackageLock {
  lockfileVersion: number;
  packages: Record<string, LockPackage>;
}

const approvedDependencies = {
  '@vercel/blob': '2.6.1',
  react: '19.2.7',
  'react-dom': '19.2.7',
  zod: '4.4.3',
};

const approvedDevDependencies = {
  '@commitlint/cli': '20.5.3',
  '@commitlint/config-conventional': '20.5.3',
  '@playwright/test': '1.61.1',
  '@testing-library/dom': '10.4.1',
  '@testing-library/react': '16.3.2',
  '@testing-library/user-event': '14.6.1',
  '@types/node': '24.13.3',
  '@types/react': '19.2.17',
  '@types/react-dom': '19.2.3',
  '@vercel/node': '5.8.26',
  '@vitejs/plugin-react': '6.0.3',
  '@vitest/coverage-v8': '4.1.10',
  husky: '9.1.7',
  jsdom: '29.1.1',
  oxfmt: '0.59.0',
  oxlint: '1.74.0',
  typescript: '6.0.3',
  vite: '8.1.4',
  vitest: '4.1.10',
};

function isLocalPackage(packageMetadata: LockPackage): boolean {
  return (
    packageMetadata.link === true ||
    /^(?:file|link|workspace):/.test(packageMetadata.resolved ?? '')
  );
}

describe('package lock provenance', () => {
  it('pins every registry package to an official npm artifact with SHA-512 integrity', () => {
    const lockPath = resolve(import.meta.dirname, '../../package-lock.json');
    const rawLock = readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(rawLock) as PackageLock;
    const rootPackage = lock.packages[''];

    expect(lock.lockfileVersion).toBe(3);
    expect(rootPackage?.dependencies).toEqual(approvedDependencies);
    expect(rootPackage?.devDependencies).toEqual(approvedDevDependencies);
    expect(rawLock).not.toContain('registry.npmmirror.com');

    const invalidRegistryPackages = Object.entries(lock.packages).flatMap(
      ([packagePath, packageMetadata]) => {
        if (!packagePath.startsWith('node_modules/') || isLocalPackage(packageMetadata)) {
          return [];
        }

        const hasOfficialResolution =
          typeof packageMetadata.resolved === 'string' &&
          packageMetadata.resolved.startsWith('https://registry.npmjs.org/');
        const hasSha512Integrity =
          typeof packageMetadata.integrity === 'string' &&
          packageMetadata.integrity.startsWith('sha512-');

        return hasOfficialResolution && hasSha512Integrity ? [] : [packagePath];
      },
    );

    expect(invalidRegistryPackages).toEqual([]);
  });
});
