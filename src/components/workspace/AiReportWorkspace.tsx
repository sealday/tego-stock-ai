import { useCallback, useEffect, useRef, useState } from 'react';

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
  | 'getExportSnapshot'
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
  readonly storageEpoch?: number | undefined;
  readonly storageClearing?: boolean | undefined;
  readonly onAllLocalClearStart?: (() => void) | undefined;
  readonly onAllLocalClearSuccess?: (() => void) | undefined;
  readonly onAllLocalClearFailure?: (() => void) | undefined;
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
  storageEpoch = 0,
  storageClearing = false,
  onAllLocalClearStart,
  onAllLocalClearSuccess,
  onAllLocalClearFailure,
}: AiReportWorkspaceProps) {
  const [defaultRepository] = useState(() => repository ?? new LocalRepository());
  const localRepository = repository ?? defaultRepository;
  const [settings, setSettings] = useState<AiProviderSettings>(DEFAULT_AI_PROVIDER_SETTINGS);
  const [reports, setReports] = useState<readonly GeneratedAiReport[]>([]);
  const [reportsRefreshKey, setReportsRefreshKey] = useState(0);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<PendingDraftSave | null>(null);
  const [localClearBusy, setLocalClearBusy] = useState(false);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(storageEpoch);
  const settingsRevision = useRef(0);
  const settingsWriteRevision = useRef(0);
  const operationEpoch = useRef(storageEpoch);
  const draftSaveAttempt = useRef(0);
  const clearing = storageClearing || localClearBusy;
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
    if (storageEpoch > operationEpoch.current) {
      operationEpoch.current = storageEpoch;
      setWorkspaceEpoch(storageEpoch);
    }
  }, [storageEpoch]);

  const hydrateSettings = useCallback(
    (replaceMissing: boolean) => {
      let current = true;
      const epoch = operationEpoch.current;
      const hydrationRevision = settingsRevision.current;
      void localRepository
        .getSettings()
        .then((storedSettings) => {
          if (
            current &&
            operationEpoch.current === epoch &&
            settingsRevision.current === hydrationRevision
          ) {
            if (storedSettings !== null) {
              setSettings(storedSettings);
            } else if (replaceMissing) {
              setSettings(DEFAULT_AI_PROVIDER_SETTINGS);
            }
            setStorageError(null);
          }
        })
        .catch(() => {
          if (current && operationEpoch.current === epoch) {
            setStorageError('无法读取本地 AI 设置；本次会话仍可继续使用。');
          }
        });
      return () => {
        current = false;
      };
    },
    [localRepository],
  );

  useEffect(() => hydrateSettings(false), [hydrateSettings]);

  const hydrateReports = useCallback(() => {
    const epoch = operationEpoch.current;
    void localRepository
      .listReports()
      .then((storedReports) => {
        if (operationEpoch.current === epoch) {
          setReports(storedReports.map((saved) => saved.report));
          setPendingDraft(null);
          setReportsRefreshKey((current) => current + 1);
        }
      })
      .catch(() => {
        if (operationEpoch.current === epoch) {
          setStorageError('无法重新读取本地报告；请重试本地数据操作。');
        }
      });
  }, [localRepository]);

  const updateSettings = (next: AiProviderSettings) => {
    if (clearing) {
      return;
    }
    settingsRevision.current += 1;
    settingsWriteRevision.current += 1;
    const writeRevision = settingsWriteRevision.current;
    const epoch = operationEpoch.current;
    setSettings(next);
    void localRepository
      .saveSettings(next)
      .then(() => {
        if (operationEpoch.current === epoch && settingsWriteRevision.current === writeRevision) {
          setStorageError(null);
        }
      })
      .catch(() => {
        if (operationEpoch.current === epoch && settingsWriteRevision.current === writeRevision) {
          setStorageError('无法保存本地 AI 设置；未勾选时的 key 仍只在本次会话中使用。');
        }
      });
  };

  const persistCompleteReport = async (report: CompleteAiReport): Promise<void> => {
    if (clearing) {
      throw new Error('Local storage is being cleared');
    }
    const epoch = operationEpoch.current;
    try {
      await localRepository.saveReport(report);
    } catch (error) {
      if (operationEpoch.current === epoch) {
        setStorageError('完整报告未能保存到当前浏览器；当前页面会话仍保留该内容。');
      }
      throw error;
    }
    if (operationEpoch.current === epoch) {
      setReports((currentReports) => retainOnce(currentReports, report));
      setReportsRefreshKey((current) => current + 1);
      setStorageError(null);
    }
  };

  const persistDraft = async (report: DraftAiReport): Promise<void> => {
    if (clearing) {
      return;
    }
    const epoch = operationEpoch.current;
    const attempt = draftSaveAttempt.current + 1;
    draftSaveAttempt.current = attempt;
    setPendingDraft({ report, saving: true });
    try {
      await localRepository.saveReport(report);
      if (operationEpoch.current === epoch && draftSaveAttempt.current === attempt) {
        setPendingDraft(null);
        setReportsRefreshKey((current) => current + 1);
        setStorageError(null);
      }
    } catch {
      if (operationEpoch.current === epoch && draftSaveAttempt.current === attempt) {
        setPendingDraft({ report, saving: false });
        setStorageError(null);
      }
    }
  };

  const retainDraft = (report: DraftAiReport) => {
    setReports((currentReports) => retainOnce(currentReports, report));
    void persistDraft(report);
  };

  const credentialsCleared = () => {
    settingsRevision.current += 1;
    setSettings((current) => ({ ...current, apiKey: '', rememberApiKey: false }));
  };

  const allLocalDataClearStarted = () => {
    operationEpoch.current += 1;
    setWorkspaceEpoch(operationEpoch.current);
    settingsRevision.current += 1;
    settingsWriteRevision.current += 1;
    draftSaveAttempt.current += 1;
    setLocalClearBusy(true);
    setStorageError(null);
    onAllLocalClearStart?.();
  };

  const allLocalDataCleared = () => {
    settingsRevision.current += 1;
    settingsWriteRevision.current += 1;
    draftSaveAttempt.current += 1;
    setSettings(DEFAULT_AI_PROVIDER_SETTINGS);
    setReports([]);
    setPendingDraft(null);
    setStorageError(null);
    setLocalClearBusy(false);
    setReportsRefreshKey((current) => current + 1);
    onAllLocalClearSuccess?.();
  };

  const allLocalDataClearFailed = () => {
    setLocalClearBusy(false);
    hydrateSettings(true);
    hydrateReports();
    onAllLocalClearFailure?.();
  };

  return (
    <div className="ai-report-workspace">
      {active ? (
        <AiSettings value={settings} onChange={updateSettings} disabled={clearing} />
      ) : null}
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
          storageEpoch={workspaceEpoch}
          storageDisabled={clearing}
          onSaveReport={persistCompleteReport}
          onDraftReport={retainDraft}
        />
      )}
      {active && reports.length > 0 ? (
        <p className="ai-report-workspace__saved-count">
          当前页面会话已保留 {reports.length} 份完整报告或未完成草稿。
        </p>
      ) : null}
      {active && pendingDraft !== null ? (
        <div className="local-storage-error" role="alert">
          <p>
            {pendingDraft.saving ? '正在保存未完成草稿…' : '草稿尚未保存到当前浏览器，请重试。'}
          </p>
          {pendingDraft.saving ? null : (
            <button
              type="button"
              disabled={clearing}
              onClick={() => void persistDraft(pendingDraft.report)}
            >
              重试保存未完成草稿
            </button>
          )}
        </div>
      ) : null}
      {active ? <SavedReports repository={localRepository} refreshKey={reportsRefreshKey} /> : null}
      {active ? (
        <PrivacyControls
          repository={localRepository}
          onCredentialsCleared={credentialsCleared}
          onAllClearStart={allLocalDataClearStarted}
          onAllCleared={allLocalDataCleared}
          onAllClearFailure={allLocalDataClearFailed}
        />
      ) : null}
    </div>
  );
}

interface PendingDraftSave {
  readonly report: DraftAiReport;
  readonly saving: boolean;
}

function retainOnce(
  reports: readonly GeneratedAiReport[],
  report: GeneratedAiReport,
): readonly GeneratedAiReport[] {
  return reports.includes(report) ? reports : [report, ...reports];
}
