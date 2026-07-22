import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ZERO_SHA = /^0{40}$/;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function isCommit(value) {
  if (!value || ZERO_SHA.test(value)) {
    return false;
  }

  try {
    execFileSync('git', ['cat-file', '-e', `${value}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!eventPath) {
    return {};
  }

  return JSON.parse(readFileSync(eventPath, 'utf8'));
}

function firstRoot(commit) {
  const roots = git('rev-list', '--max-parents=0', '--reverse', commit).split('\n');
  const root = roots[0];

  if (!root) {
    throw new Error(`Could not find a root commit reachable from ${commit}.`);
  }

  return root;
}

function createGitRevisionReader() {
  return {
    firstRoot,
    head: () => git('rev-parse', 'HEAD'),
    isCommit,
    mergeBase: (left, right) => git('merge-base', left, right),
    parent: (commit) => {
      const parent = `${commit}^`;

      return isCommit(parent) ? git('rev-parse', parent) : undefined;
    },
  };
}

function resolvePushBase(event, to, revisionReader) {
  const before = typeof event.before === 'string' ? event.before : undefined;

  if (revisionReader.isCommit(before)) {
    return { from: before, includeFrom: false };
  }

  const defaultBranch = event.repository?.default_branch;
  const pushedRef = typeof event.ref === 'string' ? event.ref.replace(/^refs\/heads\//, '') : '';
  const defaultRef = defaultBranch ? `refs/remotes/origin/${defaultBranch}` : '';

  if (defaultBranch && pushedRef !== defaultBranch && revisionReader.isCommit(defaultRef)) {
    return { from: revisionReader.mergeBase(defaultRef, to), includeFrom: false };
  }

  return { from: revisionReader.firstRoot(to), includeFrom: true };
}

export function resolveCommitRange({ eventName, event, git: revisionReader }) {
  const requestedTo = eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after;
  const to =
    typeof requestedTo === 'string' && revisionReader.isCommit(requestedTo)
      ? requestedTo
      : revisionReader.head();

  if (eventName === 'pull_request') {
    const base = event.pull_request?.base?.sha;

    if (typeof base !== 'string' || !revisionReader.isCommit(base)) {
      throw new Error(
        'The pull request base commit is unavailable. Checkout must fetch full history.',
      );
    }

    return { from: revisionReader.mergeBase(base, to), to, includeFrom: false };
  }

  if (eventName === 'push') {
    return { ...resolvePushBase(event, to, revisionReader), to };
  }

  const parent = revisionReader.parent(to);

  if (parent) {
    return { from: parent, to, includeFrom: false };
  }

  return { from: revisionReader.firstRoot(to), to, includeFrom: true };
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }
}

function main() {
  const range = resolveCommitRange({
    eventName: process.env.GITHUB_EVENT_NAME,
    event: readEvent(),
    git: createGitRevisionReader(),
  });

  writeOutput('from', range.from);
  writeOutput('to', range.to);
  writeOutput('include-from', String(range.includeFrom));

  console.log(JSON.stringify(range));
}

const entrypoint = process.argv[1];

if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  main();
}
