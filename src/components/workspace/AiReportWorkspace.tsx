import { useEffect, useRef, useState } from 'react';

import { createWorkspaceReportContext } from '../../ai/report-contract';
import type { CompleteAiReport, DraftAiReport, GeneratedAiReport } from '../../ai/report-model';
import { DEFAULT_AI_PROVIDER_SETTINGS, type AiProviderSettings } from '../../ai/provider-settings';
import type { StockWorkspaceState } from '../../hooks/use-stock-workspace';
import { LocalRepository } from '../../storage/repository';
import { AiReportPanel } from '../ai/AiReportPanel';
import { AiSettings } from '../ai/AiSettings';
import { PrivacyControls } from '../privacy/PrivacyControls';
import { SavedReports } from '../reports/SavedReports';

export type AiReportWorkspaceRepository = Pick<
  LocalRepository,
  | 'clearAll'
  | 'clearCredentials'
  | 'deleteReport'
  | 'getSettings'
  | 'listReports'
  | 'listWatchlist'
  | 'saveReport'
  | 'saveSettings'
>;

export interface AiReportWorkspaceProps {
  readonly state: StockWorkspaceState;
  readonly active: boolean;
  readonly repository?: AiReportWorkspaceRepository | undefined;
  readonly focusRequest?: AiReportWorkspaceFocusRequest | null | undefined;
}

export interface AiReportWorkspaceFocusRequest {
  readonly id: 'saved-reports' | 'ai-settings' | 'local-privacy';
  readonly sequence: number;
}

export default function AiReportWorkspace({
  state,
  active,
  repository,
  focusRequest,
}: AiReportWorkspaceProps) {
  const [defaultRepository] = useState(() => new LocalRepository());
  const localRepository = repository ?? defaultRepository;
  const [settings, setSettings] = useState<AiProviderSettings>(DEFAULT_AI_PROVIDER_SETTINGS);
  const [reports, setReports] = useState<readonly GeneratedAiReport[]>([]);
  const [reportsRefreshKey, setReportsRefreshKey] = useState(0);
  const [storageError, setStorageError] = useState<string | null>(null);
  const settingsRevision = useRef(0);
  const settingsWriteRevision = useRef(0);
  const context = createWorkspaceReportContext(state);
  const retainedContext = useRef(context);
  if (context !== null) {
    retainedContext.current = context;
  }
  const reportContext = context ?? retainedContext.current;

  useEffect(() => {
    if (!active || focusRequest === null || focusRequest === undefined) {
      return;
    }
    const destination = document.getElementById(focusRequest.id);
    destination?.focus({ preventScroll: true });
    destination?.scrollIntoView?.({ block: 'start' });
  }, [active, focusRequest]);

  useEffect(() => {
    let current = true;
    const hydrationRevision = settingsRevision.current;
    void localRepository
      .getSettings()
      .then((storedSettings) => {
        if (current && storedSettings !== null && settingsRevision.current === hydrationRevision) {
          setSettings(storedSettings);
        }
      })
      .catch(() => {
        if (current) {
          setStorageError('无法读取本地 AI 设置；本次会话仍可继续使用。');
        }
      });
    return () => {
      current = false;
    };
  }, [localRepository]);

  const updateSettings = (next: AiProviderSettings) => {
    settingsRevision.current += 1;
    settingsWriteRevision.current += 1;
    const writeRevision = settingsWriteRevision.current;
    setSettings(next);
    void localRepository
      .saveSettings(next)
      .then(() => {
        if (settingsWriteRevision.current === writeRevision) {
          setStorageError(null);
        }
      })
      .catch(() => {
        if (settingsWriteRevision.current === writeRevision) {
          setStorageError('无法保存本地 AI 设置；未勾选时的 key 仍只在本次会话中使用。');
        }
      });
  };

  const retainReport = (report: CompleteAiReport | DraftAiReport) => {
    setReports((currentReports) => [report, ...currentReports]);
    void localRepository
      .saveReport(report)
      .then(() => {
        setReportsRefreshKey((current) => current + 1);
        setStorageError(null);
      })
      .catch(() => {
        setStorageError('报告未能保存到当前浏览器；当前页面会话仍保留该内容。');
      });
  };

  const credentialsCleared = () => {
    settingsRevision.current += 1;
    setSettings((current) => ({ ...current, apiKey: '', rememberApiKey: false }));
  };

  const allLocalDataCleared = () => {
    settingsRevision.current += 1;
    setSettings(DEFAULT_AI_PROVIDER_SETTINGS);
    setReports([]);
    setReportsRefreshKey((current) => current + 1);
  };

  return (
    <div className="ai-report-workspace">
      {active ? <AiSettings value={settings} onChange={updateSettings} /> : null}
      {active && storageError !== null ? (
        <p className="local-storage-error" role="alert">
          {storageError}
        </p>
      ) : null}
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
      {active ? <SavedReports repository={localRepository} refreshKey={reportsRefreshKey} /> : null}
      {active ? (
        <PrivacyControls
          repository={localRepository}
          onCredentialsCleared={credentialsCleared}
          onAllCleared={allLocalDataCleared}
        />
      ) : null}
    </div>
  );
}
