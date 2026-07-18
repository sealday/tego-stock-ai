import { describe, expect, it } from 'vitest';

import { resolveCommitRange } from '../../scripts/resolve-commit-range.mjs';

interface GitFixtureOptions {
  commits: string[];
  head: string;
  mergeBases?: Record<string, string>;
  parents?: Record<string, string | undefined>;
  roots?: Record<string, string>;
}

function createGitFixture({
  commits,
  head,
  mergeBases = {},
  parents = {},
  roots = {},
}: GitFixtureOptions) {
  const knownCommits = new Set(commits);

  return {
    firstRoot: (commit: string) => roots[commit] ?? commit,
    head: () => head,
    isCommit: (revision: string | undefined) => Boolean(revision && knownCommits.has(revision)),
    mergeBase: (left: string, right: string) => {
      const mergeBase = mergeBases[`${left}:${right}`];

      if (!mergeBase) {
        throw new Error(`Missing merge-base fixture for ${left} and ${right}.`);
      }

      return mergeBase;
    },
    parent: (commit: string) => parents[commit],
  };
}

describe('introduced commit range resolution', () => {
  it('uses the pull request merge base and head', () => {
    const git = createGitFixture({
      commits: ['base', 'head'],
      head: 'checkout-merge',
      mergeBases: { 'base:head': 'common' },
    });

    expect(
      resolveCommitRange({
        eventName: 'pull_request',
        event: { pull_request: { base: { sha: 'base' }, head: { sha: 'head' } } },
        git,
      }),
    ).toEqual({ from: 'common', to: 'head', includeFrom: false });
  });

  it('uses before and after for normal and rewritten pushes', () => {
    for (const name of ['normal', 'rewritten'] as const) {
      const before = `${name}-before`;
      const after = `${name}-after`;
      const git = createGitFixture({ commits: [before, after], head: after });

      expect(
        resolveCommitRange({
          eventName: 'push',
          event: { before, after, ref: 'refs/heads/main' },
          git,
        }),
      ).toEqual({ from: before, to: after, includeFrom: false });
    }
  });

  it.each([
    ['zero', '0000000000000000000000000000000000000000'],
    ['missing', undefined],
  ])('uses the default-branch merge base when push before is %s', (_name, before) => {
    const git = createGitFixture({
      commits: ['head', 'refs/remotes/origin/main'],
      head: 'head',
      mergeBases: { 'refs/remotes/origin/main:head': 'branch-point' },
    });

    expect(
      resolveCommitRange({
        eventName: 'push',
        event: {
          after: 'head',
          before,
          ref: 'refs/heads/feature',
          repository: { default_branch: 'main' },
        },
        git,
      }),
    ).toEqual({ from: 'branch-point', to: 'head', includeFrom: false });
  });

  it('includes the root commit for the initial default-branch push', () => {
    const git = createGitFixture({
      commits: ['root'],
      head: 'root',
      roots: { root: 'root' },
    });

    expect(
      resolveCommitRange({
        eventName: 'push',
        event: {
          after: 'root',
          before: '0000000000000000000000000000000000000000',
          ref: 'refs/heads/main',
          repository: { default_branch: 'main' },
        },
        git,
      }),
    ).toEqual({ from: 'root', to: 'root', includeFrom: true });
  });

  it('falls back to the checked-out commit for workflow dispatch', () => {
    const git = createGitFixture({
      commits: ['parent', 'head'],
      head: 'head',
      parents: { head: 'parent' },
    });

    expect(resolveCommitRange({ eventName: 'workflow_dispatch', event: {}, git })).toEqual({
      from: 'parent',
      to: 'head',
      includeFrom: false,
    });
  });
});
