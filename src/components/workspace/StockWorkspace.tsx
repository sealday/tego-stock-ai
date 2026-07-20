import { useRef, useState, type KeyboardEvent } from 'react';

import { WORKSPACE_TABS, type WorkspaceTabId } from '../../app/routes';
import { formatShanghaiTimestamp, type StockWorkspaceState } from '../../hooks/use-stock-workspace';
import { DataStatus } from './DataStatus';
import { FinancialTrendsPanel } from './FinancialTrendsPanel';
import { FundamentalsPanel } from './FundamentalsPanel';
import { OverviewPanel } from './OverviewPanel';
import { TechnicalPanel } from './TechnicalPanel';

export function StockWorkspace({ state }: { readonly state: StockWorkspaceState }) {
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>('overview');
  const tabReferences = useRef<Array<HTMLButtonElement | null>>([]);
  const name = state.overview.status === 'success' ? state.overview.envelope.data.name : state.code;

  return (
    <article
      id="market-analysis"
      className="stock-workspace"
      aria-labelledby="stock-workspace-heading"
    >
      <header className="workspace-header">
        <div>
          <p className="workspace-header__eyebrow">{state.code} · 日线收盘研究</p>
          <h2 id="stock-workspace-heading">{name}量化研究</h2>
        </div>
        <dl className="workspace-provenance">
          <div>
            <dt>数据来源</dt>
            <dd>{state.source}</dd>
          </div>
          <div>
            <dt>数据截止</dt>
            <dd>
              {state.cutoff === null ? (
                '不可用'
              ) : (
                <time dateTime={state.cutoff}>{state.cutoff}</time>
              )}
            </dd>
          </div>
        </dl>
      </header>

      {state.freshness === 'stale' && state.lastSuccessfulAt !== undefined ? (
        <p className="stale-banner">
          数据延迟 · 最后成功更新{' '}
          <time dateTime={state.lastSuccessfulAt}>
            {formatShanghaiTimestamp(state.lastSuccessfulAt)}
          </time>
        </p>
      ) : null}

      <div className="data-status-row" aria-label="数据项可用性">
        <DataStatus label="行情" resource={state.overview} />
        <DataStatus label="历史" resource={state.history} />
        <DataStatus label="基本面" resource={state.fundamentals} />
        <DataStatus label="市场快照" resource={state.marketStatus} />
      </div>

      <div
        className="workspace-tabs"
        role="tablist"
        aria-label="股票研究视图"
        aria-orientation="horizontal"
      >
        {WORKSPACE_TABS.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-controls={`panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            ref={(element) => {
              tabReferences.current[index] = element;
            }}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) =>
              handleTabKeyDown(event, index, setActiveTab, tabReferences.current)
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id={`panel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'overview' ? <OverviewPanel state={state} /> : null}
        {activeTab === 'technical' ? <TechnicalPanel state={state} /> : null}
        {activeTab === 'fundamentals' ? <FundamentalsPanel state={state} /> : null}
        {activeTab === 'financial-trends' ? <FinancialTrendsPanel state={state} /> : null}
        {activeTab === 'ai-report' ? <AiReportPlaceholder /> : null}
      </div>

      <WorkspaceLimitations state={state} />

      <footer className="research-disclaimer">
        <strong>研究边界</strong>
        <p>
          所有内容仅供研究与教育使用，不构成投资建议、交易指令或收益保证。数据为历史日线收盘口径，不是实时行情。
        </p>
      </footer>
    </article>
  );
}

function handleTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  activate: (tab: WorkspaceTabId) => void,
  tabElements: readonly (HTMLButtonElement | null)[],
): void {
  let nextIndex: number | undefined;
  if (event.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % WORKSPACE_TABS.length;
  } else if (event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = WORKSPACE_TABS.length - 1;
  }

  if (nextIndex === undefined) {
    return;
  }
  event.preventDefault();
  const nextTab = WORKSPACE_TABS[nextIndex];
  if (nextTab !== undefined) {
    activate(nextTab.id);
    tabElements[nextIndex]?.focus();
  }
}

function WorkspaceLimitations({ state }: { readonly state: StockWorkspaceState }) {
  const limitations = [state.overview, state.history, state.fundamentals, state.marketStatus]
    .flatMap((resource) =>
      resource.status === 'success' ? [...resource.envelope.limitations] : [],
    )
    .filter((limitation, index, all) => all.indexOf(limitation) === index);

  return (
    <aside className="workspace-limitations" aria-labelledby="workspace-limitations-heading">
      <h2 id="workspace-limitations-heading">数据限制</h2>
      {limitations.length === 0 ? (
        <p>当前成功数据未声明额外限制。</p>
      ) : (
        <ul>
          {limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function AiReportPlaceholder() {
  return (
    <section className="workspace-panel" aria-labelledby="ai-report-heading">
      <p className="panel-kicker">浏览器内 BYOK</p>
      <h2 id="ai-report-heading">AI 报告</h2>
      <p>
        Task 6 将提供用户主动触发的 AI 研究报告。当前页面不会发起 AI
        请求，确定性指标与数据缺口始终先于 AI 叙事展示。
      </p>
    </section>
  );
}
