import { useCallback, useEffect, useRef, useState } from 'react';

import type { LocalRepository, SavedReport } from '../../storage/repository';

export type SavedReportsRepository = Pick<LocalRepository, 'deleteReport' | 'listReports'>;

export interface SavedReportsProps {
  readonly repository: SavedReportsRepository;
  readonly refreshKey?: number | undefined;
  readonly disabled?: boolean | undefined;
}

export function SavedReports({ repository, refreshKey = 0, disabled = false }: SavedReportsProps) {
  const [reports, setReports] = useState<readonly SavedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    const request = loadRequest.current + 1;
    loadRequest.current = request;
    setLoading(true);
    setError(false);
    try {
      const storedReports = await repository.listReports();
      if (mounted.current && loadRequest.current === request) {
        setReports(storedReports);
      }
    } catch {
      if (mounted.current && loadRequest.current === request) {
        setError(true);
      }
    } finally {
      if (mounted.current && loadRequest.current === request) {
        setLoading(false);
      }
    }
  }, [repository]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const remove = async (report: SavedReport) => {
    if (disabled) {
      return;
    }
    loadRequest.current += 1;
    setDeletingId(report.id);
    setError(false);
    try {
      await repository.deleteReport(report.id);
      setReports((current) => current.filter((candidate) => candidate.id !== report.id));
    } catch {
      setError(true);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section
      id="saved-reports"
      className="workspace-panel saved-reports"
      aria-labelledby="saved-reports-heading"
      tabIndex={-1}
    >
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">本地研究历史</p>
          <h2 id="saved-reports-heading">已保存 AI 报告</h2>
        </div>
        <span className="saved-reports__count">{reports.length} 份</span>
      </div>
      <p className="local-privacy-note">
        AI 报告只保存在当前浏览器，不会同步到账户、云端或项目服务器。
      </p>

      {error ? (
        <div className="local-storage-error" role="alert">
          <p>无法读取本地报告，未更改已保存数据。</p>
          <button type="button" onClick={() => void load()}>
            重试读取本地报告
          </button>
        </div>
      ) : loading ? (
        <p className="saved-reports__empty">正在读取本地报告…</p>
      ) : reports.length === 0 ? (
        <p className="saved-reports__empty">尚未保存本地 AI 报告。</p>
      ) : (
        <ol className="saved-reports__list">
          {reports.map((saved) => (
            <li key={saved.id}>
              <article className="saved-report">
                <header>
                  <div>
                    <span
                      className={`saved-report__status saved-report__status--${saved.report.status}`}
                    >
                      {saved.report.status === 'complete' ? '完整报告' : '未完成草稿'}
                    </span>
                    <h3>
                      {saved.report.context.stock.name}{' '}
                      <span className="mono">{saved.report.context.stock.code}</span>
                    </h3>
                  </div>
                  <button
                    type="button"
                    disabled={disabled || deletingId === saved.id}
                    aria-label={`删除${
                      saved.report.status === 'complete' ? '完整报告' : '未完成草稿'
                    } ${saved.report.context.stock.name} ${saved.report.context.stock.code}`}
                    onClick={() => void remove(saved)}
                  >
                    {deletingId === saved.id ? '删除中…' : '删除'}
                  </button>
                </header>
                <dl>
                  <div>
                    <dt>数据截止</dt>
                    <dd>
                      <time dateTime={saved.report.context.cutoff}>
                        {saved.report.context.cutoff}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>本地保存</dt>
                    <dd>
                      <time dateTime={saved.savedAt}>{saved.savedAt}</time>
                    </dd>
                  </div>
                  <div>
                    <dt>提供商 / 模型</dt>
                    <dd>
                      {saved.report.provider.baseUrl} · {saved.report.provider.model}
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>查看报告内容</summary>
                  <div className="saved-report__sections">
                    {saved.report.sections.map((section) => (
                      <section key={section.heading}>
                        <h4>{section.heading}</h4>
                        <p>{section.content.length === 0 ? '本节未完成' : section.content}</p>
                      </section>
                    ))}
                  </div>
                </details>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
