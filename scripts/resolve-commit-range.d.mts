export interface CommitRange {
  from: string;
  includeFrom: boolean;
  to: string;
}

export interface CommitRangeEvent {
  after?: string | undefined;
  before?: string | undefined;
  pull_request?: {
    base?: { sha?: string | undefined } | undefined;
    head?: { sha?: string | undefined } | undefined;
  };
  ref?: string | undefined;
  repository?: { default_branch?: string | undefined } | undefined;
}

export interface GitRevisionReader {
  firstRoot(commit: string): string;
  head(): string;
  isCommit(revision: string | undefined): boolean;
  mergeBase(left: string, right: string): string;
  parent(commit: string): string | undefined;
}

export function resolveCommitRange(options: {
  event: CommitRangeEvent;
  eventName: string | undefined;
  git: GitRevisionReader;
}): CommitRange;
