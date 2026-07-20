import { useRef, useState } from 'react';

import { createWorkspaceReportContext } from '../../ai/report-contract';
import type { CompleteAiReport, DraftAiReport, GeneratedAiReport } from '../../ai/report-model';
import { DEFAULT_AI_PROVIDER_SETTINGS, type AiProviderSettings } from '../../ai/provider-settings';
import type { StockWorkspaceState } from '../../hooks/use-stock-workspace';
import { AiReportPanel } from '../ai/AiReportPanel';
import { AiSettings } from '../ai/AiSettings';

export interface AiReportWorkspaceProps {
  readonly state: StockWorkspaceState;
  readonly active: boolean;
}

export default function AiReportWorkspace({ state, active }: AiReportWorkspaceProps) {
  const [settings, setSettings] = useState<AiProviderSettings>(DEFAULT_AI_PROVIDER_SETTINGS);
  const [reports, setReports] = useState<readonly GeneratedAiReport[]>([]);
  const context = createWorkspaceReportContext(state);
  const retainedContext = useRef(context);
  if (context !== null) {
    retainedContext.current = context;
  }
  const reportContext = context ?? retainedContext.current;
  const retainReport = (report: CompleteAiReport | DraftAiReport) => {
    setReports((currentReports) => [report, ...currentReports]);
  };

  return (
    <div className="ai-report-workspace">
      {active ? <AiSettings value={settings} onChange={setSettings} /> : null}
      {context === null && active ? (
        <section className="workspace-panel" aria-labelledby="ai-report-heading">
          <p className="panel-kicker">等待确定性上下文</p>
          <h2 id="ai-report-heading">AI 报告</h2>
          <p>数据截止日期尚不可用。确定性面板仍可使用，报告生成将在上下文完整后启用。</p>
        </section>
      ) : null}
      {reportContext === null ? null : (
        <AiReportPanel
          active={active && context !== null}
          context={reportContext}
          settings={settings}
          onSaveReport={retainReport}
          onDraftReport={retainReport}
        />
      )}
      {active && reports.length > 0 ? (
        <p className="ai-report-workspace__saved-count">
          当前页面会话已保留 {reports.length} 份完整报告或未完成草稿。
        </p>
      ) : null}
    </div>
  );
}
