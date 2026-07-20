import type { AiProviderSettings, SanitizedAiProviderSettings } from './provider-settings';
import { sanitizeAiProviderSettings } from './provider-settings';
import type { ReportContext } from './report-context';
import type { ReportSection, ReportStructureFailureReason } from './report-parser';

export interface CompleteAiReport {
  readonly status: 'complete';
  readonly completedAt: string;
  readonly provider: SanitizedAiProviderSettings;
  readonly context: ReportContext;
  readonly rawText: string;
  readonly sections: readonly ReportSection[];
}

export type DraftReportReason = 'cancelled' | 'stream-interrupted' | 'contract-invalid';

export interface DraftAiReport {
  readonly status: 'draft';
  readonly interruptedAt: string;
  readonly provider: SanitizedAiProviderSettings;
  readonly context: ReportContext;
  readonly rawText: string;
  readonly sections: readonly ReportSection[];
  readonly reason: DraftReportReason;
  readonly contractFailure?: ReportStructureFailureReason;
  readonly errorMessage?: string;
}

export type GeneratedAiReport = CompleteAiReport | DraftAiReport;

export interface DraftReportInput {
  readonly context: ReportContext;
  readonly settings: AiProviderSettings;
  readonly rawText: string;
  readonly sections: readonly ReportSection[];
  readonly reason: DraftReportReason;
  readonly contractFailure?: ReportStructureFailureReason;
  readonly errorMessage?: string;
  readonly now: () => Date;
}

export function createDraftReport(input: DraftReportInput): DraftAiReport {
  return {
    status: 'draft',
    interruptedAt: input.now().toISOString(),
    provider: sanitizeAiProviderSettings(input.settings),
    context: input.context,
    rawText: input.rawText,
    sections: input.sections,
    reason: input.reason,
    ...(input.contractFailure === undefined ? {} : { contractFailure: input.contractFailure }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
  };
}
