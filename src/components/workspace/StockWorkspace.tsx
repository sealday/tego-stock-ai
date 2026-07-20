import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { WORKSPACE_TABS, type WorkspaceTabId } from '../../app/routes';
import { formatShanghaiTimestamp, type StockWorkspaceState } from '../../hooks/use-stock-workspace';
import { DataStatus } from './DataStatus';
import { FinancialTrendsPanel } from './FinancialTrendsPanel';
import { FundamentalsPanel } from './FundamentalsPanel';
import { OverviewPanel } from './OverviewPanel';
import { TechnicalPanel } from './TechnicalPanel';
import type { AiReportWorkspaceFocusRequest } from './AiReportWorkspace';

const AI_DESTINATION_IDS = ['saved-reports', 'ai-settings', 'local-privacy'] as const;
type AiDestinationId = (typeof AI_DESTINATION_IDS)[number];

const AiReportWorkspace = lazy(async () => {
  const module = await import('./AiReportWorkspace');
  return { default: module.default };
});

export function StockWorkspace({ state }: { readonly state: StockWorkspaceState }) {
  const initialDestination = destinationFromHash(
    typeof window === 'undefined' ? '' : window.location.hash,
  );
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>(
    initialDestination === null ? 'overview' : 'ai-report',
  );
  const [aiWorkspaceActivated, setAiWorkspaceActivated] = useState(initialDestination !== null);
  const [focusRequest, setFocusRequest] = useState<AiReportWorkspaceFocusRequest | null>(
    initialDestination === null ? null : { id: initialDestination, sequence: 0 },
  );
  const tabReferences = useRef<Array<HTMLButtonElement | null>>([]);
  const name = state.overview.status === 'success' ? state.overview.envelope.data.name : state.code;
  const marketSnapshotStale =
    state.marketStatus.status === 'success' &&
    (state.marketStatus.envelope.freshness === 'stale' ||
      state.marketStatus.envelope.data.freshness === 'stale');
  const activateTab = (tab: WorkspaceTabId) => {
    setActiveTab(tab);
    if (tab === 'ai-report') {
      setAiWorkspaceActivated(true);
    }
  };

  useEffect(() => {
    const reveal = (destination: AiDestinationId) => {
      setActiveTab('ai-report');
      setAiWorkspaceActivated(true);
      setFocusRequest((current) => ({
        id: destination,
        sequence: (current?.sequence ?? 0) + 1,
      }));
    };
    const revealCurrentHash = () => {
      const destination = destinationFromHash(window.location.hash);
      if (destination !== null) {
        reveal(destination);
      }
    };
    const revealClickedAnchor = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const anchor = event.target.closest('a');
      const destination = destinationFromHash(anchor?.getAttribute('href') ?? '');
      if (destination !== null) {
        reveal(destination);
      }
    };

    window.addEventListener('hashchange', revealCurrentHash);
    document.addEventListener('click', revealClickedAnchor);
    return () => {
      window.removeEventListener('hashchange', revealCurrentHash);
      document.removeEventListener('click', revealClickedAnchor);
    };
  }, []);

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

      {state.freshness === 'stale' ? (
        <p className="stale-banner">
          {marketSnapshotStale && state.lastSuccessfulAt !== undefined ? (
            <>
              数据延迟 · 市场快照最后成功更新{' '}
              <time dateTime={state.lastSuccessfulAt}>
                {formatShanghaiTimestamp(state.lastSuccessfulAt)}
              </time>
            </>
          ) : (
            '数据含延迟项'
          )}
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
            onClick={() => activateTab(tab.id)}
            onKeyDown={(event) =>
              handleTabKeyDown(event, index, activateTab, tabReferences.current)
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {WORKSPACE_TABS.map((tab) => (
        <div
          key={tab.id}
          id={`panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab.id}`}
          hidden={activeTab !== tab.id}
        >
          {tab.id === 'ai-report' ? (
            aiWorkspaceActivated ? (
              <Suspense fallback={<p>正在加载 AI 工作区…</p>}>
                <AiReportWorkspace
                  state={state}
                  active={activeTab === tab.id}
                  focusRequest={focusRequest}
                />
              </Suspense>
            ) : null
          ) : activeTab === tab.id ? (
            renderActivePanel(tab.id, state)
          ) : null}
        </div>
      ))}

      <p className="price-chart__attribution">
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™ Copyright (с) 2025 TradingView, Inc.
          https://www.tradingview.com/
        </a>
      </p>

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

function destinationFromHash(hash: string): AiDestinationId | null {
  const candidate = hash.startsWith('#') ? hash.slice(1) : hash;
  return AI_DESTINATION_IDS.find((destination) => destination === candidate) ?? null;
}

function renderActivePanel(tab: WorkspaceTabId, state: StockWorkspaceState) {
  if (tab === 'overview') {
    return <OverviewPanel state={state} />;
  }
  if (tab === 'technical') {
    return <TechnicalPanel state={state} />;
  }
  if (tab === 'fundamentals') {
    return <FundamentalsPanel state={state} />;
  }
  if (tab === 'financial-trends') {
    return <FinancialTrendsPanel state={state} />;
  }
  return null;
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
