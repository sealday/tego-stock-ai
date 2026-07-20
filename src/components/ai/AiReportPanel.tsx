import { useEffect, useRef, useState } from 'react';

import {
  createAiClient,
  type AiChatMessage,
  type AiClientConfiguration,
  type AiStreamEvent,
} from '../../ai/client';
import {
  REPORT_SECTION_HEADINGS,
  createReportMessages,
  parseCompleteReport,
  type ReportContext,
  type ReportSection,
  type ReportSectionHeading,
} from '../../ai/report-contract';
import {
  sanitizeAiProviderSettings,
  validateAiProviderSettings,
  type AiProviderSettings,
  type SanitizedAiProviderSettings,
} from './AiSettings';

export type AiReportStreamer = (
  configuration: AiClientConfiguration,
  messages: readonly AiChatMessage[],
) => AsyncIterable<AiStreamEvent>;

export interface GeneratedAiReport {
  readonly status: 'complete';
  readonly completedAt: string;
  readonly provider: SanitizedAiProviderSettings;
  readonly context: ReportContext;
  readonly rawText: string;
  readonly sections: readonly ReportSection[];
}

export interface AiReportPanelProps {
  readonly context: ReportContext;
  readonly settings: AiProviderSettings;
  readonly active?: boolean;
  readonly stream?: AiReportStreamer;
  readonly onSaveReport?: (report: GeneratedAiReport) => void;
  readonly now?: () => Date;
}

type ReportPhase = 'idle' | 'streaming' | 'complete' | 'draft' | 'error';

const browserReportStreamer: AiReportStreamer = (configuration, messages) =>
  createAiClient(configuration).stream(messages);

const currentTime = () => new Date();

export function AiReportPanel({
  context,
  settings,
  active = true,
  stream = browserReportStreamer,
  onSaveReport,
  now = currentTime,
}: AiReportPanelProps) {
  const [phase, setPhase] = useState<ReportPhase>('idle');
  const [rawText, setRawText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [draftReason, setDraftReason] = useState<string | null>(null);
  const [completeReport, setCompleteReport] = useState<GeneratedAiReport | null>(null);
  const [saved, setSaved] = useState(false);
  const activeController = useRef<AbortController | null>(null);
  const generationId = useRef(0);
  const configurationErrors = validateAiProviderSettings(settings);
  const canGenerate = Object.keys(configurationErrors).length === 0;
  const visibleSections = parseDraftSections(rawText);
  const showReportSections = phase === 'streaming' || phase === 'draft' || phase === 'complete';

  useEffect(
    () => () => {
      generationId.current += 1;
      activeController.current?.abort();
    },
    [],
  );

  const generate = () => {
    if (!canGenerate) {
      return;
    }

    activeController.current?.abort();
    const controller = new AbortController();
    const requestId = generationId.current + 1;
    generationId.current = requestId;
    activeController.current = controller;
    setPhase('streaming');
    setRawText('');
    setErrorMessage(null);
    setDraftReason(null);
    setCompleteReport(null);
    setSaved(false);

    void runGeneration({
      requestId,
      controller,
      context,
      settings,
      stream,
      now,
      isActive: () => generationId.current === requestId,
      onDelta: (text) => setRawText(text),
      onComplete: (report) => {
        setCompleteReport(report);
        setPhase('complete');
      },
      onDraft: (text, reason, message) => {
        setRawText(text);
        setDraftReason(reason);
        setErrorMessage(message);
        setPhase('draft');
      },
      onError: (message) => {
        setErrorMessage(message);
        setPhase('error');
      },
      onFinished: () => {
        if (activeController.current === controller) {
          activeController.current = null;
        }
      },
    });
  };

  const cancel = () => {
    generationId.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    setDraftReason('生成已取消');
    setErrorMessage(null);
    setPhase('draft');
  };

  const saveReport = () => {
    if (completeReport === null || onSaveReport === undefined) {
      return;
    }
    onSaveReport(completeReport);
    setSaved(true);
  };

  if (!active) {
    return null;
  }

  return (
    <section className="workspace-panel ai-report" aria-labelledby="ai-report-heading">
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">用户主动生成 · 浏览器直连</p>
          <h2 id="ai-report-heading">AI 报告</h2>
        </div>
        <ReportStatus phase={phase} draftReason={draftReason} />
      </div>

      <DeterministicContext context={context} />

      <div className="ai-report__actions">
        {phase === 'streaming' ? (
          <button type="button" onClick={cancel}>
            取消生成
          </button>
        ) : (
          <button type="button" disabled={!canGenerate} onClick={generate}>
            {phase === 'draft' || phase === 'error' ? '仅重试 AI 生成' : '生成 AI 报告'}
          </button>
        )}
        {phase === 'complete' && onSaveReport !== undefined ? (
          <button type="button" disabled={saved} onClick={saveReport}>
            保存完整报告
          </button>
        ) : null}
      </div>

      {!canGenerate ? (
        <p className="ai-report__configuration-note">
          请先填写有效的 Base URL、模型和 API key，再主动生成报告。
        </p>
      ) : null}
      {errorMessage === null ? null : (
        <p className="ai-report__error" role="alert">
          {errorMessage}
        </p>
      )}
      {saved ? <p className="ai-report__saved">完整报告已交给本地保存回调</p> : null}

      {showReportSections ? (
        <div className="ai-report__sections" aria-label="AI 研究报告七章节">
          {visibleSections.map((section) => (
            <section className="ai-report__section" key={section.heading}>
              <h4>{section.heading}</h4>
              <ReportSectionContent content={section.content} phase={phase} />
            </section>
          ))}
        </div>
      ) : (
        <p className="ai-report__idle">
          不会自动请求 AI。生成前可继续查看全部确定性指标、数据缺口、截止日期和限制。
        </p>
      )}
    </section>
  );
}

interface GenerationCallbacks {
  readonly requestId: number;
  readonly controller: AbortController;
  readonly context: ReportContext;
  readonly settings: AiProviderSettings;
  readonly stream: AiReportStreamer;
  readonly now: () => Date;
  readonly isActive: () => boolean;
  readonly onDelta: (text: string) => void;
  readonly onComplete: (report: GeneratedAiReport) => void;
  readonly onDraft: (text: string, reason: string, message: string | null) => void;
  readonly onError: (message: string) => void;
  readonly onFinished: () => void;
}

async function runGeneration(callbacks: GenerationCallbacks): Promise<void> {
  let aggregate = '';
  let terminalEvent = false;

  try {
    const messages = createReportMessages(callbacks.context);
    const events = callbacks.stream(
      {
        baseUrl: callbacks.settings.baseUrl,
        model: callbacks.settings.model,
        apiKey: callbacks.settings.apiKey,
        signal: callbacks.controller.signal,
      },
      messages,
    );

    for await (const event of events) {
      if (!callbacks.isActive()) {
        return;
      }
      if (event.type === 'delta') {
        aggregate += event.text;
        callbacks.onDelta(aggregate);
        continue;
      }

      terminalEvent = true;
      if (event.type === 'complete') {
        try {
          const sections = parseCompleteReport(aggregate);
          callbacks.onComplete({
            status: 'complete',
            completedAt: callbacks.now().toISOString(),
            provider: sanitizeAiProviderSettings(callbacks.settings),
            context: callbacks.context,
            rawText: aggregate,
            sections,
          });
        } catch {
          callbacks.onDraft(
            aggregate,
            '响应未通过七章节契约校验',
            'AI 返回内容无效：必须且只能包含按顺序排列的七个批准章节。',
          );
        }
      } else if (event.type === 'aborted') {
        callbacks.onDraft(aggregate, '生成已取消', null);
      } else if (aggregate.length > 0) {
        callbacks.onDraft(aggregate, '流式响应中断', event.message);
      } else {
        callbacks.onError(event.message);
      }
      return;
    }

    if (!terminalEvent && callbacks.isActive()) {
      if (aggregate.length > 0) {
        callbacks.onDraft(aggregate, '流式响应中断', 'AI 响应流意外中断。');
      } else {
        callbacks.onError('AI 响应流意外中断。');
      }
    }
  } catch {
    if (!callbacks.isActive()) {
      return;
    }
    if (aggregate.length > 0) {
      callbacks.onDraft(aggregate, '流式响应中断', '无法连接 AI 提供商，请稍后重试。');
    } else {
      callbacks.onError('无法连接 AI 提供商，请稍后重试。');
    }
  } finally {
    callbacks.onFinished();
  }
}

function ReportStatus({
  phase,
  draftReason,
}: {
  readonly phase: ReportPhase;
  readonly draftReason: string | null;
}) {
  if (phase === 'streaming') {
    return <span className="ai-report__status">正在流式生成</span>;
  }
  if (phase === 'complete') {
    return <span className="ai-report__status ai-report__status--complete">报告已完成</span>;
  }
  if (phase === 'draft') {
    return <span className="ai-report__status">未完成草稿 · {draftReason}</span>;
  }
  if (phase === 'error') {
    return <span className="ai-report__status">AI 生成失败</span>;
  }
  return <span className="ai-report__status">尚未生成</span>;
}

function DeterministicContext({ context }: { readonly context: ReportContext }) {
  const missing = context.availability.filter((item) => item.status === 'missing');
  return (
    <section className="ai-report__context" aria-labelledby="ai-report-context-heading">
      <h3 id="ai-report-context-heading">确定性分析摘要</h3>
      <dl>
        <div>
          <dt>数据截止</dt>
          <dd>
            <time dateTime={context.cutoff}>{context.cutoff}</time>
          </dd>
        </div>
        <div>
          <dt>数据来源</dt>
          <dd>{context.source}</dd>
        </div>
        <div>
          <dt>收盘价</dt>
          <dd>{formatMetric(context.price.close)}</dd>
        </div>
      </dl>
      <div className="ai-report__signal-row">
        <p>趋势评分 {formatScore(context.signals.trend.score)}</p>
        <p>估值评分 {formatScore(context.signals.valuation.score)}</p>
        <p>质量评分 {formatScore(context.signals.quality.score)}</p>
      </div>
      <div className="ai-report__disclosures">
        <div>
          <h4>缺失指标</h4>
          {missing.length === 0 ? (
            <p>当前上下文未声明缺失指标。</p>
          ) : (
            <ul>
              {missing.map((item) => (
                <li key={item.metric}>{item.reason}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>来源限制</h4>
          <ul>
            {context.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ReportSectionContent({
  content,
  phase,
}: {
  readonly content: string;
  readonly phase: ReportPhase;
}) {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return (
      <p className="missing-value">{phase === 'streaming' ? '等待流式内容…' : '本节未完成'}</p>
    );
  }
  return lines.map((line, index) => <p key={`${index}:${line}`}>{line}</p>);
}

function parseDraftSections(
  rawText: string,
): readonly { readonly heading: ReportSectionHeading; readonly content: string }[] {
  const linesByHeading = new Map<ReportSectionHeading, string[]>();
  let currentHeading: ReportSectionHeading | undefined;

  for (const line of rawText.replaceAll('\r\n', '\n').split('\n')) {
    const headingText = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (headingText !== undefined) {
      currentHeading = REPORT_SECTION_HEADINGS.find((heading) => heading === headingText);
      continue;
    }
    if (currentHeading !== undefined) {
      const lines = linesByHeading.get(currentHeading) ?? [];
      lines.push(line);
      linesByHeading.set(currentHeading, lines);
    }
  }

  return REPORT_SECTION_HEADINGS.map((heading) => ({
    heading,
    content: (linesByHeading.get(heading) ?? []).join('\n').trim(),
  }));
}

function formatMetric(value: number | null): string {
  return value === null ? '缺失' : new Intl.NumberFormat('zh-CN').format(value);
}

function formatScore(value: number | null): string {
  return value === null ? '不可计算' : `${value.toFixed(1)} / 100`;
}
