import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

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

function resolvePushBase(event, to) {
  const before = typeof event.before === 'string' ? event.before : undefined;

  if (isCommit(before)) {
    return { from: before, includeFrom: false };
  }

  const defaultBranch = event.repository?.default_branch;
  const pushedRef = typeof event.ref === 'string' ? event.ref.replace(/^refs\/heads\//, '') : '';
  const defaultRef = defaultBranch ? `refs/remotes/origin/${defaultBranch}` : '';

  if (defaultBranch && pushedRef !== defaultBranch && isCommit(defaultRef)) {
    return { from: git('merge-base', defaultRef, to), includeFrom: false };
  }

  return { from: firstRoot(to), includeFrom: true };
}

function resolveRange() {
  const event = readEvent();
  const eventName = process.env.GITHUB_EVENT_NAME;
  const requestedTo = eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after;
  const to =
    typeof requestedTo === 'string' && isCommit(requestedTo)
      ? requestedTo
      : git('rev-parse', 'HEAD');

  if (eventName === 'pull_request') {
    const base = event.pull_request?.base?.sha;

    if (typeof base !== 'string' || !isCommit(base)) {
      throw new Error(
        'The pull request base commit is unavailable. Checkout must fetch full history.',
      );
    }

    return { from: git('merge-base', base, to), to, includeFrom: false };
  }

  if (eventName === 'push') {
    return { ...resolvePushBase(event, to), to };
  }

  const parent = `${to}^`;

  if (isCommit(parent)) {
    return { from: git('rev-parse', parent), to, includeFrom: false };
  }

  return { from: firstRoot(to), to, includeFrom: true };
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }
}

const range = resolveRange();

writeOutput('from', range.from);
writeOutput('to', range.to);
writeOutput('include-from', String(range.includeFrom));

console.log(JSON.stringify(range));
