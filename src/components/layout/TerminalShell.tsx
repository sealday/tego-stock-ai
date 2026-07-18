import type { ReactNode } from 'react';

import { PRIMARY_NAVIGATION } from '../../app/routes';
import type { StockSearchResult } from '../../domain/stock';
import { formatShanghaiTimestamp, type WorkspaceDataStatus } from '../../hooks/use-stock-workspace';
import { StockSearch, type StockSearchFunction } from '../search/StockSearch';

export interface TerminalShellProps {
  readonly selectedStock: StockSearchResult | null;
  readonly marketState: string;
  readonly source: string;
  readonly cutoff: string;
  readonly dataStatus: WorkspaceDataStatus;
  readonly lastSuccessfulAt?: string | undefined;
  readonly onStockSelect: (stock: StockSearchResult) => void;
  readonly search?: StockSearchFunction | undefined;
  readonly watchlist?: readonly StockSearchResult[] | undefined;
  readonly children: ReactNode;
}

export function TerminalShell({
  selectedStock,
  marketState,
  source,
  cutoff,
  dataStatus,
  lastSuccessfulAt,
  onStockSelect,
  search,
  watchlist = [],
  children,
}: TerminalShellProps) {
  return (
    <div className="terminal-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <aside className="terminal-rail" aria-label="研究终端侧边栏">
        <TerminalIdentity />
        <Navigation />
        <Watchlist stocks={watchlist} />
      </aside>

      <div className="terminal-shell__body">
        <details className="compact-navigation">
          <summary>展开导航</summary>
          <div className="compact-navigation__content">
            <Navigation />
            <Watchlist stocks={watchlist} />
          </div>
        </details>

        <header className="terminal-topbar">
          <div className="terminal-topbar__search">
            <StockSearch onSelect={onStockSelect} {...(search === undefined ? {} : { search })} />
          </div>
          <div className="terminal-topbar__stock" aria-label="当前股票">
            <span className="terminal-label">当前标的</span>
            {selectedStock === null ? (
              <strong>未选择</strong>
            ) : (
              <>
                <strong>{selectedStock.name}</strong>
                <span className="mono">{selectedStock.code}</span>
              </>
            )}
          </div>
          <dl className="terminal-topbar__status" aria-label="市场与数据状态">
            <div>
              <dt>市场</dt>
              <dd>{marketState}</dd>
            </div>
            <div>
              <dt>数据</dt>
              <dd className={`freshness freshness--${dataStatus}`}>
                {dataStatusLabel(dataStatus)}
              </dd>
            </div>
            <div>
              <dt>截止</dt>
              <dd>
                <time dateTime={cutoff}>{cutoff}</time>
              </dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{source}</dd>
            </div>
          </dl>
          {dataStatus === 'stale' && lastSuccessfulAt !== undefined ? (
            <p className="terminal-topbar__stale-note">
              最后成功更新：
              <time dateTime={lastSuccessfulAt}>{formatShanghaiTimestamp(lastSuccessfulAt)}</time>
            </p>
          ) : null}
        </header>

        <main id="main-content" className="terminal-main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function TerminalIdentity() {
  return (
    <div className="terminal-identity">
      <span className="terminal-identity__mark" aria-hidden="true">
        T
      </span>
      <div>
        <strong>TEGO</strong>
        <span>A 股研究终端</span>
      </div>
    </div>
  );
}

function Navigation() {
  return (
    <nav aria-label="主导航">
      <ul className="terminal-navigation">
        {PRIMARY_NAVIGATION.map((item) => (
          <li key={item.id}>
            <a href={item.href} aria-current={item.id === 'market-analysis' ? 'page' : undefined}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Watchlist({ stocks }: { readonly stocks: readonly StockSearchResult[] }) {
  return (
    <section className="terminal-watchlist" aria-label="本地自选股">
      <h2>本地自选股</h2>
      {stocks.length === 0 ? (
        <p>Task 7 将提供本地保存的自选列表。</p>
      ) : (
        <ul>
          {stocks.map((stock) => (
            <li key={stock.code}>
              <span>{stock.name}</span>
              <span className="mono">{stock.code}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function dataStatusLabel(status: WorkspaceDataStatus): string {
  return {
    loading: '加载中',
    fresh: '数据就绪',
    stale: '数据延迟',
    partial: '部分异常',
    error: '不可用',
  }[status];
}
