import { validateReportContext } from './report-context';

export const REPORT_SECTION_HEADINGS = [
  '数据摘要与截止日期',
  '技术结构与支持观察',
  '基本面、估值与财务质量',
  '多空情景',
  '关键风险与失效条件',
  '缺失信息与待研究问题',
  '数据来源与限制',
] as const;

export type ReportSectionHeading = (typeof REPORT_SECTION_HEADINGS)[number];

export const REPORT_SYSTEM_INSTRUCTION = `你是一个谨慎的 A 股研究助手。只可引用用户提供的结构化上下文，必须明确数据截止日期、来源、缺失信息和限制。
不得编造（must not invent）任何指标或事实，不得把缺失值推断为权威数据。
不得提供投资建议（investment advice）、买入（buy）或卖出（sell）指令、目标价（target price）、保证收益（guaranteed return）或类似承诺。
材料仅供研究与教育使用。严格使用用户指定的七个章节标题和顺序，不得添加其他章节。`;

export interface ReportMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface ReportSection {
  readonly heading: ReportSectionHeading;
  readonly content: string;
}

export type ReportStructureFailureReason =
  | 'nonempty-preamble'
  | 'unknown-heading'
  | 'duplicate-heading'
  | 'out-of-order-heading'
  | 'incomplete-report'
  | 'empty-section';

export type IncrementalReportParseResult =
  | { readonly status: 'valid'; readonly sections: readonly ReportSection[] }
  | {
      readonly status: 'invalid';
      readonly reason: ReportStructureFailureReason;
      readonly sections: readonly ReportSection[];
    };

export type FinalReportParseResult =
  | { readonly status: 'complete'; readonly sections: readonly ReportSection[] }
  | {
      readonly status: 'invalid';
      readonly reason: ReportStructureFailureReason;
      readonly sections: readonly ReportSection[];
    };

export interface IncrementalReportParser {
  push(chunk: string): IncrementalReportParseResult;
  finish(): FinalReportParseResult;
  snapshot(): readonly ReportSection[];
}

export function createReportMessages(value: unknown): readonly ReportMessage[] {
  const context = validateReportContext(value);
  const requiredHeadings = REPORT_SECTION_HEADINGS.map((heading) => `## ${heading}`).join('\n');

  return [
    { role: 'system', content: REPORT_SYSTEM_INSTRUCTION },
    {
      role: 'user',
      content: `请根据下列结构化上下文生成研究报告。严格按以下标题和顺序输出，每节必须有内容：\n${requiredHeadings}\n\n结构化上下文：\n${JSON.stringify(context)}`,
    },
  ];
}

export function parseCompleteReport(text: string): readonly ReportSection[] {
  const parser = createIncrementalReportParser();
  const streamed = parser.push(text);
  if (streamed.status === 'invalid') {
    throw reportStructureError(streamed.reason);
  }
  const final = parser.finish();
  if (final.status === 'invalid') {
    throw reportStructureError(final.reason);
  }
  return final.sections;
}

export function createIncrementalReportParser(): IncrementalReportParser {
  const sectionLines = REPORT_SECTION_HEADINGS.map(() => [] as string[]);
  const seenHeadings = new Set<number>();
  let buffer = '';
  let currentHeadingIndex = -1;
  let nextHeadingIndex = 0;
  let failure: ReportStructureFailureReason | null = null;
  let finalResult: FinalReportParseResult | null = null;

  const snapshot = (): readonly ReportSection[] =>
    REPORT_SECTION_HEADINGS.map((heading, index) => {
      const lines = [...(sectionLines[index] ?? [])];
      if (
        index === currentHeadingIndex &&
        buffer.length > 0 &&
        !buffer.trimStart().startsWith('#')
      ) {
        lines.push(buffer);
      }
      return { heading, content: lines.join('\n').trim() };
    });

  const processLine = (rawLine: string): void => {
    if (failure !== null) {
      return;
    }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      const headingIndex = REPORT_SECTION_HEADINGS.findIndex((approved) => approved === heading);
      if (headingIndex === -1) {
        failure = 'unknown-heading';
        return;
      }
      if (seenHeadings.has(headingIndex)) {
        failure = 'duplicate-heading';
        return;
      }
      if (headingIndex !== nextHeadingIndex) {
        failure = 'out-of-order-heading';
        return;
      }
      seenHeadings.add(headingIndex);
      currentHeadingIndex = headingIndex;
      nextHeadingIndex += 1;
      return;
    }

    if (currentHeadingIndex === -1) {
      if (line.trim().length > 0) {
        failure = 'nonempty-preamble';
      }
      return;
    }
    sectionLines[currentHeadingIndex]?.push(line);
  };

  const push = (chunk: string): IncrementalReportParseResult => {
    if (finalResult !== null) {
      return finalResult.status === 'invalid'
        ? finalResult
        : { status: 'valid', sections: finalResult.sections };
    }
    if (failure !== null) {
      return { status: 'invalid', reason: failure, sections: snapshot() };
    }

    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
      if (failure !== null) {
        return { status: 'invalid', reason: failure, sections: snapshot() };
      }
      newlineIndex = buffer.indexOf('\n');
    }

    return { status: 'valid', sections: snapshot() };
  };

  const finish = (): FinalReportParseResult => {
    if (finalResult !== null) {
      return finalResult;
    }
    if (failure === null && buffer.length > 0) {
      const finalLine = buffer;
      buffer = '';
      processLine(finalLine);
    }
    const sections = snapshot();
    if (failure !== null) {
      finalResult = { status: 'invalid', reason: failure, sections };
    } else if (seenHeadings.size !== REPORT_SECTION_HEADINGS.length) {
      finalResult = { status: 'invalid', reason: 'incomplete-report', sections };
    } else if (sections.some((section) => section.content.length === 0)) {
      finalResult = { status: 'invalid', reason: 'empty-section', sections };
    } else {
      finalResult = { status: 'complete', sections };
    }
    return finalResult;
  };

  return { push, finish, snapshot };
}

function reportStructureError(reason: ReportStructureFailureReason): TypeError {
  const messages: Record<ReportStructureFailureReason, string> = {
    'nonempty-preamble': 'Report must not contain content before the first approved heading',
    'unknown-heading': 'Report contains an unknown section heading',
    'duplicate-heading': 'Report contains a duplicate section heading',
    'out-of-order-heading': 'Report contains an out-of-order section heading',
    'incomplete-report': 'Report must contain exactly the seven approved section headings',
    'empty-section': 'Every report section must contain content',
  };
  return new TypeError(messages[reason]);
}
