import { useEffect, useRef, useState } from 'react';

import {
  createAiClient,
  type AiChatMessage,
  type AiClientConfiguration,
  type AiStreamEvent,
} from '../../ai/client';
import {
  REPORT_SECTION_HEADINGS,
  createIncrementalReportParser,
  createReportMessages,
  type FinalReportParseResult,
  validateReportContext,
  type ReportContext,
  type ReportSection,
} from '../../ai/report-contract';
import {
  createDraftReport,
  type CompleteAiReport,
  type DraftAiReport,
} from '../../ai/report-model';
import {
  sanitizeAiProviderSettings,
  validateAiProviderSettings,
  type AiProviderSettings,
} from '../../ai/provider-settings';
import { DeterministicContext } from './DeterministicContext';

export type {
  CompleteAiReport,
  DraftAiReport,
  DraftReportReason,
  GeneratedAiReport,
} from '../../ai/report-model';

export type AiReportStreamer = (
  configuration: AiClientConfiguration,
  messages: readonly AiChatMessage[],
) => AsyncIterable<AiStreamEvent>;

export interface AiReportPanelProps {
  readonly context: ReportContext;
  readonly settings: AiProviderSettings;
  readonly active?: boolean;
  readonly stream?: AiReportStreamer;
  readonly onSaveReport?: (report: CompleteAiReport) => void;
  readonly onDraftReport?: (report: DraftAiReport) => void;
  readonly now?: () => Date;
}

type ReportPhase = 'idle' | 'streaming' | 'complete' | 'draft' | 'error';

const browserReportStreamer: AiReportStreamer = (configuration, messages) =>
  createAiClient(configuration).stream(messages);

const currentTime = () => new Date();
const CONTRACT_INVALID_MESSAGE = 'AI 返回内容无效：必须且只能包含按顺序排列的七个批准章节。';

export function AiReportPanel({
  context,
  settings,
  active = true,
  stream = browserReportStreamer,
  onSaveReport,
  onDraftReport,
  now = currentTime,
}: AiReportPanelProps) {
  const [phase, setPhase] = useState<ReportPhase>('idle');
  const [visibleSections, setVisibleSections] = useState<readonly ReportSection[]>(emptySections);
  const [capturedContext, setCapturedContext] = useState<ReportContext | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [draftReason, setDraftReason] = useState<string | null>(null);
  const [completeReport, setCompleteReport] = useState<CompleteAiReport | null>(null);
  const [saved, setSaved] = useState(false);
  const activeController = useRef<AbortController | null>(null);
  const activeGeneration = useRef<ActiveGeneration | null>(null);
  const generationId = useRef(0);
  const configurationErrors = validateAiProviderSettings(settings);
  const canGenerate = Object.keys(configurationErrors).length === 0;
  const showReportSections = phase === 'streaming' || phase === 'draft' || phase === 'complete';
  const displayedContext =
    showReportSections && capturedContext !== null ? capturedContext : context;

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

    let generationContext: ReportContext;
    try {
      generationContext = validateReportContext(context);
    } catch {
      setErrorMessage('确定性上下文未通过报告契约校验，无法生成。');
      setPhase('error');
      return;
    }

    activeController.current?.abort();
    const controller = new AbortController();
    const requestId = generationId.current + 1;
    generationId.current = requestId;
    activeController.current = controller;
    activeGeneration.current = {
      requestId,
      controller,
      context: generationContext,
      settings,
      rawText: '',
      draftDelivered: false,
    };
    setPhase('streaming');
    setVisibleSections(emptySections());
    setCapturedContext(generationContext);
    setErrorMessage(null);
    setDraftReason(null);
    setCompleteReport(null);
    setSaved(false);

    void runGeneration({
      requestId,
      controller,
      context: generationContext,
      settings,
      stream,
      now,
      isActive: () => generationId.current === requestId,
      onDelta: (text, sections) => {
        const currentGeneration = activeGeneration.current;
        if (currentGeneration?.requestId === requestId) {
          currentGeneration.rawText = text;
        }
        setVisibleSections(sections);
      },
      onComplete: (report) => {
        setCompleteReport(report);
        setVisibleSections(report.sections);
        setPhase('complete');
      },
      onDraft: (report, reasonLabel) => {
        const currentGeneration = activeGeneration.current;
        if (currentGeneration?.requestId === requestId && !currentGeneration.draftDelivered) {
          currentGeneration.draftDelivered = true;
          onDraftReport?.(report);
        }
        setVisibleSections(report.sections);
        setDraftReason(reasonLabel);
        setErrorMessage(report.errorMessage ?? null);
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
        if (activeGeneration.current?.requestId === requestId) {
          activeGeneration.current = null;
        }
      },
    });
  };

  const cancel = () => {
    const currentGeneration = activeGeneration.current;
    if (currentGeneration === null) {
      return;
    }
    generationId.current += 1;
    currentGeneration.controller.abort();
    activeController.current = null;
    const parsed = finalizeAggregate(currentGeneration.rawText);
    const contractViolation = isInterruptedContractViolation(parsed);
    const draft = createDraftReport({
      context: currentGeneration.context,
      settings: currentGeneration.settings,
      rawText: currentGeneration.rawText,
      sections: parsed.sections,
      reason: contractViolation ? 'contract-invalid' : 'cancelled',
      ...(contractViolation
        ? { contractFailure: parsed.reason, errorMessage: CONTRACT_INVALID_MESSAGE }
        : {}),
      now,
    });
    if (!currentGeneration.draftDelivered) {
      currentGeneration.draftDelivered = true;
      onDraftReport?.(draft);
    }
    activeGeneration.current = null;
    setVisibleSections(draft.sections);
    setDraftReason(contractViolation ? '响应未通过七章节契约校验' : '生成已取消');
    setErrorMessage(draft.errorMessage ?? null);
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
    <section
      className="workspace-panel ai-report"
      aria-labelledby="ai-report-heading"
      aria-busy={phase === 'streaming'}
    >
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">用户主动生成 · 浏览器直连</p>
          <h2 id="ai-report-heading">AI 报告</h2>
        </div>
        <ReportStatus phase={phase} draftReason={draftReason} saved={saved} />
      </div>

      <DeterministicContext context={displayedContext} />

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
  readonly onDelta: (text: string, sections: readonly ReportSection[]) => void;
  readonly onComplete: (report: CompleteAiReport) => void;
  readonly onDraft: (report: DraftAiReport, reasonLabel: string) => void;
  readonly onError: (message: string) => void;
  readonly onFinished: () => void;
}

async function runGeneration(callbacks: GenerationCallbacks): Promise<void> {
  let aggregate = '';
  let terminalEvent = false;
  const parser = createIncrementalReportParser();

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
        const parsed = parser.push(event.text);
        callbacks.onDelta(aggregate, parsed.sections);
        if (parsed.status === 'invalid') {
          callbacks.controller.abort();
          callbacks.onDraft(
            createDraftReport({
              context: callbacks.context,
              settings: callbacks.settings,
              rawText: aggregate,
              sections: parsed.sections,
              reason: 'contract-invalid',
              contractFailure: parsed.reason,
              errorMessage: CONTRACT_INVALID_MESSAGE,
              now: callbacks.now,
            }),
            '响应未通过七章节契约校验',
          );
          return;
        }
        continue;
      }

      terminalEvent = true;
      if (event.type === 'complete') {
        const parsed = parser.finish();
        if (parsed.status === 'complete') {
          callbacks.onComplete({
            status: 'complete',
            completedAt: callbacks.now().toISOString(),
            provider: sanitizeAiProviderSettings(callbacks.settings),
            context: callbacks.context,
            rawText: aggregate,
            sections: parsed.sections,
          });
        } else {
          callbacks.controller.abort();
          callbacks.onDraft(
            createDraftReport({
              context: callbacks.context,
              settings: callbacks.settings,
              rawText: aggregate,
              sections: parsed.sections,
              reason: 'contract-invalid',
              contractFailure: parsed.reason,
              errorMessage: CONTRACT_INVALID_MESSAGE,
              now: callbacks.now,
            }),
            '响应未通过七章节契约校验',
          );
        }
      } else if (event.type === 'aborted') {
        const parsed = parser.finish();
        if (isInterruptedContractViolation(parsed)) {
          callbacks.controller.abort();
          deliverContractInvalidDraft(callbacks, aggregate, parsed);
          return;
        }
        callbacks.onDraft(
          createDraftReport({
            context: callbacks.context,
            settings: callbacks.settings,
            rawText: aggregate,
            sections: parsed.sections,
            reason: 'cancelled',
            now: callbacks.now,
          }),
          '生成已取消',
        );
      } else if (aggregate.length > 0) {
        const parsed = parser.finish();
        if (isInterruptedContractViolation(parsed)) {
          callbacks.controller.abort();
          deliverContractInvalidDraft(callbacks, aggregate, parsed);
          return;
        }
        callbacks.onDraft(
          createDraftReport({
            context: callbacks.context,
            settings: callbacks.settings,
            rawText: aggregate,
            sections: parsed.sections,
            reason: 'stream-interrupted',
            errorMessage: event.message,
            now: callbacks.now,
          }),
          '流式响应中断',
        );
      } else {
        parser.finish();
        callbacks.onError(event.message);
      }
      return;
    }

    if (!terminalEvent && callbacks.isActive()) {
      if (aggregate.length > 0) {
        const parsed = parser.finish();
        if (isInterruptedContractViolation(parsed)) {
          callbacks.controller.abort();
          deliverContractInvalidDraft(callbacks, aggregate, parsed);
          return;
        }
        callbacks.onDraft(
          createDraftReport({
            context: callbacks.context,
            settings: callbacks.settings,
            rawText: aggregate,
            sections: parsed.sections,
            reason: 'stream-interrupted',
            errorMessage: 'AI 响应流意外中断。',
            now: callbacks.now,
          }),
          '流式响应中断',
        );
      } else {
        parser.finish();
        callbacks.onError('AI 响应流意外中断。');
      }
    }
  } catch {
    if (!callbacks.isActive()) {
      return;
    }
    if (aggregate.length > 0) {
      const parsed = parser.finish();
      if (isInterruptedContractViolation(parsed)) {
        callbacks.controller.abort();
        deliverContractInvalidDraft(callbacks, aggregate, parsed);
        return;
      }
      callbacks.onDraft(
        createDraftReport({
          context: callbacks.context,
          settings: callbacks.settings,
          rawText: aggregate,
          sections: parsed.sections,
          reason: 'stream-interrupted',
          errorMessage: '无法连接 AI 提供商，请稍后重试。',
          now: callbacks.now,
        }),
        '流式响应中断',
      );
    } else {
      parser.finish();
      callbacks.onError('无法连接 AI 提供商，请稍后重试。');
    }
  } finally {
    callbacks.onFinished();
  }
}

function isInterruptedContractViolation(
  result: FinalReportParseResult,
): result is Extract<FinalReportParseResult, { readonly status: 'invalid' }> {
  if (result.status !== 'invalid' || result.reason === 'incomplete-report') {
    return false;
  }
  if (result.reason !== 'empty-section') {
    return true;
  }
  return result.sections.slice(0, -1).some((section) => section.content.length === 0);
}

function finalizeAggregate(rawText: string): FinalReportParseResult {
  const parser = createIncrementalReportParser();
  const streamed = parser.push(rawText);
  return streamed.status === 'invalid' ? streamed : parser.finish();
}

function deliverContractInvalidDraft(
  callbacks: GenerationCallbacks,
  rawText: string,
  result: Extract<FinalReportParseResult, { readonly status: 'invalid' }>,
): void {
  callbacks.onDraft(
    createDraftReport({
      context: callbacks.context,
      settings: callbacks.settings,
      rawText,
      sections: result.sections,
      reason: 'contract-invalid',
      contractFailure: result.reason,
      errorMessage: CONTRACT_INVALID_MESSAGE,
      now: callbacks.now,
    }),
    '响应未通过七章节契约校验',
  );
}

interface ActiveGeneration {
  readonly requestId: number;
  readonly controller: AbortController;
  readonly context: ReportContext;
  readonly settings: AiProviderSettings;
  rawText: string;
  draftDelivered: boolean;
}

function emptySections(): readonly ReportSection[] {
  return REPORT_SECTION_HEADINGS.map((heading) => ({ heading, content: '' }));
}

function ReportStatus({
  phase,
  draftReason,
  saved,
}: {
  readonly phase: ReportPhase;
  readonly draftReason: string | null;
  readonly saved: boolean;
}) {
  const status =
    phase === 'streaming'
      ? '正在流式生成'
      : phase === 'complete'
        ? '报告已完成'
        : phase === 'draft'
          ? `未完成草稿 · ${draftReason}`
          : phase === 'error'
            ? 'AI 生成失败'
            : '尚未生成';

  return (
    <span
      className={`ai-report__status${phase === 'complete' ? ' ai-report__status--complete' : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span>{status}</span>
      {phase === 'complete' && saved ? (
        <>
          {' · '}
          <span>完整报告已交给本地保存回调</span>
        </>
      ) : null}
    </span>
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
