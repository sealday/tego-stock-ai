import { useCallback, useEffect, useRef, useState } from 'react';

import { TerminalShell } from '../components/layout/TerminalShell';
import { StockWorkspace } from '../components/workspace/StockWorkspace';
import { stockCode, type StockSearchResult } from '../domain/stock';
import { toShanghaiIsoDate, useStockWorkspace } from '../hooks/use-stock-workspace';

const DEFAULT_STOCK: StockSearchResult = {
  code: stockCode('600519.SH'),
  name: '贵州茅台',
  pinyinAbbreviation: 'GZMT',
};

export interface WatchlistRepository {
  listWatchlist(): Promise<readonly StockSearchResult[]>;
  putWatchlistEntry(entry: StockSearchResult): Promise<void>;
  removeWatchlistEntry(code: string): Promise<void>;
}

export interface AppProps {
  readonly watchlistRepository?: WatchlistRepository | undefined;
}

type FailedWatchlistAction =
  | { readonly type: 'load' }
  | { readonly type: 'add'; readonly stock: StockSearchResult }
  | { readonly type: 'remove'; readonly stock: StockSearchResult };

export function App({ watchlistRepository }: AppProps = {}) {
  const [selectedStock, setSelectedStock] = useState<StockSearchResult>(DEFAULT_STOCK);
  const [watchlist, setWatchlist] = useState<readonly StockSearchResult[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState(true);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchlistNotice, setWatchlistNotice] = useState<string | null>(null);
  const [failedWatchlistAction, setFailedWatchlistAction] = useState<FailedWatchlistAction | null>(
    null,
  );
  const [repositoryPromise] = useState<Promise<WatchlistRepository>>(() =>
    watchlistRepository === undefined
      ? import('../storage/repository').then(({ LocalRepository }) => new LocalRepository())
      : Promise.resolve(watchlistRepository),
  );
  const mounted = useRef(true);
  const hydrationRequest = useRef(0);
  const mutationRevision = useRef(0);
  const asOf = toShanghaiIsoDate(new Date());
  const workspace = useStockWorkspace({ code: selectedStock.code, asOf });

  const loadWatchlist = useCallback(() => {
    const request = hydrationRequest.current + 1;
    hydrationRequest.current = request;
    const revision = mutationRevision.current;
    setWatchlistLoading(true);
    setFailedWatchlistAction(null);
    void repositoryPromise
      .then((repository) => repository.listWatchlist())
      .then((storedWatchlist) => {
        if (
          mounted.current &&
          hydrationRequest.current === request &&
          mutationRevision.current === revision
        ) {
          setWatchlist(storedWatchlist);
          setWatchlistNotice(null);
        }
      })
      .catch(() => {
        if (mounted.current && hydrationRequest.current === request) {
          setFailedWatchlistAction({ type: 'load' });
        }
      })
      .finally(() => {
        if (mounted.current && hydrationRequest.current === request) {
          setWatchlistLoading(false);
        }
      });
  }, [repositoryPromise]);

  useEffect(() => {
    mounted.current = true;
    loadWatchlist();
    return () => {
      mounted.current = false;
    };
  }, [loadWatchlist]);

  const addToWatchlist = async (stock: StockSearchResult) => {
    mutationRevision.current += 1;
    setWatchlistBusy(true);
    setFailedWatchlistAction(null);
    try {
      const repository = await repositoryPromise;
      await repository.putWatchlistEntry(stock);
      if (mounted.current) {
        setWatchlist((current) => sortWatchlist([...withoutStock(current, stock.code), stock]));
        setWatchlistNotice(`${stock.name}已保存到当前浏览器的本地自选股。`);
      }
    } catch {
      if (mounted.current) {
        setFailedWatchlistAction({ type: 'add', stock });
      }
    } finally {
      if (mounted.current) {
        setWatchlistBusy(false);
      }
    }
  };

  const removeFromWatchlist = async (stock: StockSearchResult) => {
    mutationRevision.current += 1;
    setWatchlistBusy(true);
    setFailedWatchlistAction(null);
    try {
      const repository = await repositoryPromise;
      await repository.removeWatchlistEntry(stock.code);
      if (mounted.current) {
        setWatchlist((current) => withoutStock(current, stock.code));
        setWatchlistNotice(`${stock.name}已从当前浏览器的本地自选股删除。`);
      }
    } catch {
      if (mounted.current) {
        setFailedWatchlistAction({ type: 'remove', stock });
      }
    } finally {
      if (mounted.current) {
        setWatchlistBusy(false);
      }
    }
  };

  const retryWatchlist = () => {
    if (failedWatchlistAction?.type === 'add') {
      void addToWatchlist(failedWatchlistAction.stock);
    } else if (failedWatchlistAction?.type === 'remove') {
      void removeFromWatchlist(failedWatchlistAction.stock);
    } else {
      loadWatchlist();
    }
  };

  return (
    <TerminalShell
      selectedStock={selectedStock}
      marketState={workspace.marketState}
      source={workspace.source}
      cutoff={workspace.cutoff}
      dataStatus={workspace.dataStatus}
      lastSuccessfulAt={
        workspace.marketStatus.status === 'success' &&
        (workspace.marketStatus.envelope.freshness === 'stale' ||
          workspace.marketStatus.envelope.data.freshness === 'stale')
          ? workspace.lastSuccessfulAt
          : undefined
      }
      onStockSelect={setSelectedStock}
      watchlist={watchlist}
      watchlistLoading={watchlistLoading}
      watchlistBusy={watchlistBusy}
      watchlistNotice={watchlistNotice}
      watchlistError={failedWatchlistAction !== null}
      onWatchlistAdd={(stock) => void addToWatchlist(stock)}
      onWatchlistSelect={setSelectedStock}
      onWatchlistRemove={(stock) => void removeFromWatchlist(stock)}
      onWatchlistRetry={retryWatchlist}
    >
      <h1 className="visually-hidden">A 股研究终端</h1>
      <StockWorkspace state={workspace} />
    </TerminalShell>
  );
}

function withoutStock(
  watchlist: readonly StockSearchResult[],
  code: string,
): readonly StockSearchResult[] {
  return watchlist.filter((stock) => stock.code !== code);
}

function sortWatchlist(watchlist: readonly StockSearchResult[]): readonly StockSearchResult[] {
  return [...watchlist].sort((left, right) => left.code.localeCompare(right.code));
}
