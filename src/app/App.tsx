import { useCallback, useEffect, useRef, useState } from 'react';

import { TerminalShell } from '../components/layout/TerminalShell';
import { StockWorkspace } from '../components/workspace/StockWorkspace';
import type { AiReportWorkspaceRepository } from '../components/workspace/AiReportWorkspace';
import { stockCode, type StockSearchResult } from '../domain/stock';
import { toShanghaiIsoDate, useStockWorkspace } from '../hooks/use-stock-workspace';

const DEFAULT_STOCK: StockSearchResult = {
  code: stockCode('600519.SH'),
  name: '贵州茅台',
  pinyinAbbreviation: 'GZMT',
};

export interface AppRepository extends AiReportWorkspaceRepository {
  putWatchlistEntry(entry: StockSearchResult): Promise<void>;
  removeWatchlistEntry(code: string): Promise<void>;
}

export interface AppProps {
  readonly watchlistRepository?: AppRepository | undefined;
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
  const [storageEpoch, setStorageEpoch] = useState(0);
  const [storageClearing, setStorageClearing] = useState(false);
  const [failedWatchlistAction, setFailedWatchlistAction] = useState<FailedWatchlistAction | null>(
    null,
  );
  const [repository] = useState<AppRepository>(
    () =>
      watchlistRepository ??
      deferredRepository(
        import('../storage/repository').then(({ LocalRepository }) => new LocalRepository()),
      ),
  );
  const mounted = useRef(true);
  const hydrationRequest = useRef(0);
  const mutationRevision = useRef(0);
  const storageEpochReference = useRef(0);
  const watchlistWriteBlocked = useRef(true);
  const asOf = toShanghaiIsoDate(new Date());
  const workspace = useStockWorkspace({ code: selectedStock.code, asOf });

  const loadWatchlist = useCallback(
    async (releaseWriteGate = true): Promise<boolean> => {
      const request = hydrationRequest.current + 1;
      hydrationRequest.current = request;
      const revision = mutationRevision.current;
      const epoch = storageEpochReference.current;
      watchlistWriteBlocked.current = true;
      setWatchlistLoading(true);
      setFailedWatchlistAction(null);
      try {
        const storedWatchlist = await repository.listWatchlist();
        if (
          mounted.current &&
          hydrationRequest.current === request &&
          mutationRevision.current === revision &&
          storageEpochReference.current === epoch
        ) {
          if (releaseWriteGate) {
            watchlistWriteBlocked.current = false;
          }
          setWatchlist(storedWatchlist);
          setWatchlistNotice(null);
          return true;
        }
      } catch {
        if (
          mounted.current &&
          hydrationRequest.current === request &&
          mutationRevision.current === revision &&
          storageEpochReference.current === epoch
        ) {
          setFailedWatchlistAction({ type: 'load' });
        }
      } finally {
        if (
          mounted.current &&
          hydrationRequest.current === request &&
          mutationRevision.current === revision &&
          storageEpochReference.current === epoch
        ) {
          setWatchlistLoading(false);
        }
      }
      return false;
    },
    [repository],
  );

  useEffect(() => {
    mounted.current = true;
    void loadWatchlist();
    return () => {
      mounted.current = false;
    };
  }, [loadWatchlist]);

  const addToWatchlist = async (stock: StockSearchResult) => {
    if (watchlistWriteBlocked.current || storageClearing) {
      return;
    }
    mutationRevision.current += 1;
    const epoch = storageEpochReference.current;
    setWatchlistBusy(true);
    setFailedWatchlistAction(null);
    try {
      await repository.putWatchlistEntry(stock);
      if (mounted.current && storageEpochReference.current === epoch) {
        setWatchlist((current) => sortWatchlist([...withoutStock(current, stock.code), stock]));
        setWatchlistNotice(`${stock.name}已保存到当前浏览器的本地自选股。`);
      }
    } catch {
      if (mounted.current && storageEpochReference.current === epoch) {
        setFailedWatchlistAction({ type: 'add', stock });
      }
    } finally {
      if (mounted.current && storageEpochReference.current === epoch) {
        setWatchlistBusy(false);
      }
    }
  };

  const removeFromWatchlist = async (stock: StockSearchResult) => {
    if (watchlistWriteBlocked.current || storageClearing) {
      return;
    }
    mutationRevision.current += 1;
    const epoch = storageEpochReference.current;
    setWatchlistBusy(true);
    setFailedWatchlistAction(null);
    try {
      await repository.removeWatchlistEntry(stock.code);
      if (mounted.current && storageEpochReference.current === epoch) {
        setWatchlist((current) => withoutStock(current, stock.code));
        setWatchlistNotice(`${stock.name}已从当前浏览器的本地自选股删除。`);
      }
    } catch {
      if (mounted.current && storageEpochReference.current === epoch) {
        setFailedWatchlistAction({ type: 'remove', stock });
      }
    } finally {
      if (mounted.current && storageEpochReference.current === epoch) {
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
      void loadWatchlist();
    }
  };

  const allLocalClearStarted = () => {
    storageEpochReference.current += 1;
    mutationRevision.current += 1;
    hydrationRequest.current += 1;
    watchlistWriteBlocked.current = true;
    setStorageEpoch(storageEpochReference.current);
    setStorageClearing(true);
    setWatchlistBusy(false);
    setFailedWatchlistAction(null);
    setWatchlistNotice(null);
  };

  const allLocalClearSucceeded = () => {
    watchlistWriteBlocked.current = false;
    setWatchlist([]);
    setWatchlistLoading(false);
    setStorageClearing(false);
    setWatchlistNotice('当前浏览器的本地自选股已清空。');
  };

  const allLocalClearFailed = async () => {
    const recovered = await loadWatchlist(false);
    if (!recovered) {
      throw new Error('Authoritative watchlist recovery failed');
    }
  };

  const allLocalClearRecoverySucceeded = () => {
    watchlistWriteBlocked.current = false;
    setStorageClearing(false);
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
      watchlistDisabled={watchlistLoading || storageClearing || watchlistWriteBlocked.current}
      watchlistNotice={watchlistNotice}
      watchlistError={failedWatchlistAction !== null}
      onWatchlistAdd={(stock) => void addToWatchlist(stock)}
      onWatchlistSelect={setSelectedStock}
      onWatchlistRemove={(stock) => void removeFromWatchlist(stock)}
      onWatchlistRetry={retryWatchlist}
    >
      <h1 className="visually-hidden">A 股研究终端</h1>
      <StockWorkspace
        state={workspace}
        repository={repository}
        storageEpoch={storageEpoch}
        storageClearing={storageClearing}
        onAllLocalClearStart={allLocalClearStarted}
        onAllLocalClearSuccess={allLocalClearSucceeded}
        onAllLocalClearFailure={allLocalClearFailed}
        onAllLocalClearRecoverySuccess={allLocalClearRecoverySucceeded}
      />
    </TerminalShell>
  );
}

function deferredRepository(repository: Promise<AppRepository>): AppRepository {
  return {
    clearAll: () => repository.then((value) => value.clearAll()),
    clearCredentials: () => repository.then((value) => value.clearCredentials()),
    deleteReport: (id) => repository.then((value) => value.deleteReport(id)),
    getExportSnapshot: () => repository.then((value) => value.getExportSnapshot()),
    getSettings: () => repository.then((value) => value.getSettings()),
    listReports: () => repository.then((value) => value.listReports()),
    listWatchlist: () => repository.then((value) => value.listWatchlist()),
    putWatchlistEntry: (entry) => repository.then((value) => value.putWatchlistEntry(entry)),
    removeWatchlistEntry: (code) => repository.then((value) => value.removeWatchlistEntry(code)),
    saveReport: (report) => repository.then((value) => value.saveReport(report)),
    saveSettings: (settings) => repository.then((value) => value.saveSettings(settings)),
  };
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
