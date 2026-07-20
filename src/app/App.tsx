import { useState } from 'react';

import { TerminalShell } from '../components/layout/TerminalShell';
import { StockWorkspace } from '../components/workspace/StockWorkspace';
import { stockCode, type StockSearchResult } from '../domain/stock';
import { toShanghaiIsoDate, useStockWorkspace } from '../hooks/use-stock-workspace';

const DEFAULT_STOCK: StockSearchResult = {
  code: stockCode('600519.SH'),
  name: '贵州茅台',
  pinyinAbbreviation: 'GZMT',
};

export function App() {
  const [selectedStock, setSelectedStock] = useState<StockSearchResult>(DEFAULT_STOCK);
  const asOf = toShanghaiIsoDate(new Date());
  const workspace = useStockWorkspace({ code: selectedStock.code, asOf });

  return (
    <TerminalShell
      selectedStock={selectedStock}
      marketState={workspace.marketState}
      source={workspace.source}
      cutoff={workspace.cutoff}
      dataStatus={workspace.dataStatus}
      lastSuccessfulAt={workspace.lastSuccessfulAt}
      onStockSelect={setSelectedStock}
    >
      <h1 className="visually-hidden">A 股研究终端</h1>
      <StockWorkspace state={workspace} />
    </TerminalShell>
  );
}
