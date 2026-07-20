import type { ReactNode } from 'react';

import { PRIMARY_NAVIGATION } from '../../app/routes';
import type { StockSearchResult } from '../../domain/stock';
import { formatShanghaiTimestamp, type WorkspaceDataStatus } from '../../hooks/use-stock-workspace';
import { StockSearch, type StockSearchFunction } from '../search/StockSearch';

export interface TerminalShellProps {
  readonly selectedStock: StockSearchResult | null;
  readonly marketState: string;
  readonly source: string;
  readonly cutoff: string | null;
  readonly dataStatus: WorkspaceDataStatus;
  readonly lastSuccessfulAt?: string | undefined;
  readonly onStockSelect: (stock: StockSearchResult) => void;
  readonly search?: StockSearchFunction | undefined;
  readonly watchlist?: readonly StockSearchResult[] | undefined;
  readonly watchlistLoading?: boolean | undefined;
  readonly watchlistBusy?: boolean | undefined;
  readonly watchlistNotice?: string | null | undefined;
  readonly watchlistError?: boolean | undefined;
  readonly onWatchlistAdd?: ((stock: StockSearchResult) => void) | undefined;
  readonly onWatchlistSelect?: ((stock: StockSearchResult) => void) | undefined;
  readonly onWatchlistRemove?: ((stock: StockSearchResult) => void) | undefined;
  readonly onWatchlistRetry?: (() => void) | undefined;
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
  watchlistLoading = false,
  watchlistBusy = false,
  watchlistNotice = null,
  watchlistError = false,
  onWatchlistAdd,
  onWatchlistSelect,
  onWatchlistRemove,
  onWatchlistRetry,
  children,
}: TerminalShellProps) {
  const watchlistProps: WatchlistProps = {
    stocks: watchlist,
    selectedStock,
    loading: watchlistLoading,
    busy: watchlistBusy,
    notice: watchlistNotice,
    error: watchlistError,
    ...(onWatchlistAdd === undefined ? {} : { onAdd: onWatchlistAdd }),
    ...(onWatchlistSelect === undefined ? {} : { onSelect: onWatchlistSelect }),
    ...(onWatchlistRemove === undefined ? {} : { onRemove: onWatchlistRemove }),
    ...(onWatchlistRetry === undefined ? {} : { onRetry: onWatchlistRetry }),
  };
  return (
    <div className="terminal-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <aside className="terminal-rail" aria-label="研究终端侧边栏">
        <TerminalIdentity />
        <Navigation />
        <Watchlist {...watchlistProps} />
      </aside>

      <div className="terminal-shell__body">
        <details className="compact-navigation">
          <summary>展开导航</summary>
          <div className="compact-navigation__content">
            <Navigation />
            <Watchlist {...watchlistProps} />
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
              <dd>{cutoff === null ? '不可用' : <time dateTime={cutoff}>{cutoff}</time>}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{source}</dd>
            </div>
          </dl>
          {dataStatus === 'stale' && lastSuccessfulAt !== undefined ? (
            <p className="terminal-topbar__stale-note">
              市场快照最后成功更新：
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

interface WatchlistProps {
  readonly stocks: readonly StockSearchResult[];
  readonly selectedStock: StockSearchResult | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly error: boolean;
  readonly onAdd?: ((stock: StockSearchResult) => void) | undefined;
  readonly onSelect?: ((stock: StockSearchResult) => void) | undefined;
  readonly onRemove?: ((stock: StockSearchResult) => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
}

function Watchlist({
  stocks,
  selectedStock,
  loading,
  busy,
  notice,
  error,
  onAdd,
  onSelect,
  onRemove,
  onRetry,
}: WatchlistProps) {
  const selectedAlreadySaved =
    selectedStock !== null && stocks.some((stock) => stock.code === selectedStock.code);
  return (
    <section className="terminal-watchlist" aria-label="本地自选股">
      <div className="terminal-watchlist__heading">
        <h2>本地自选股</h2>
        {selectedStock === null || onAdd === undefined ? null : (
          <button
            type="button"
            disabled={busy || selectedAlreadySaved}
            aria-label={
              selectedAlreadySaved
                ? `${selectedStock.name}已在本地自选股`
                : `添加${selectedStock.name}到本地自选股`
            }
            onClick={() => onAdd(selectedStock)}
          >
            {selectedAlreadySaved ? '已添加' : '+ 当前'}
          </button>
        )}
      </div>
      <p className="terminal-watchlist__privacy">仅保存在当前浏览器，无账户与云同步。</p>
      {loading && stocks.length === 0 ? (
        <p>正在读取本地自选股…</p>
      ) : stocks.length === 0 ? (
        <p>尚未添加本地自选股。</p>
      ) : (
        <ul>
          {stocks.map((stock) => (
            <li key={stock.code}>
              <button
                type="button"
                className="terminal-watchlist__stock"
                aria-label={`选择${stock.name} ${stock.code}`}
                aria-current={selectedStock?.code === stock.code ? 'true' : undefined}
                onClick={() => onSelect?.(stock)}
              >
                <span>{stock.name}</span>
                <span className="mono">{stock.code}</span>
              </button>
              {onRemove === undefined ? null : (
                <button
                  type="button"
                  className="terminal-watchlist__remove"
                  disabled={busy}
                  aria-label={`删除${stock.name} ${stock.code}`}
                  onClick={() => onRemove(stock)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice === null ? null : <p role="status">{notice}</p>}
      {error ? (
        <div className="terminal-watchlist__error" role="alert">
          <p>本地自选股操作失败，已保存数据未宣称更改。</p>
          {onRetry === undefined ? null : (
            <button type="button" disabled={busy} onClick={onRetry}>
              重试本地自选股操作
            </button>
          )}
        </div>
      ) : null}
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
