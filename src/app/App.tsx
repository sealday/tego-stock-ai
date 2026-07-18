import { useState } from 'react';

import { TerminalShell } from '../components/layout/TerminalShell';
import { StockWorkspace } from '../components/workspace/StockWorkspace';
import { isoDate, stockCode, type StockSearchResult } from '../domain/stock';
import { useStockWorkspace } from '../hooks/use-stock-workspace';

const DEFAULT_STOCK: StockSearchResult = {
  code: stockCode('600519.SH'),
  name: '贵州茅台',
  pinyinAbbreviation: 'GZMT',
};

export function App() {
  const [selectedStock, setSelectedStock] = useState<StockSearchResult>(DEFAULT_STOCK);
  const asOf = isoDate(new Date().toISOString().slice(0, 10));
  const workspace = useStockWorkspace({ code: selectedStock.code, asOf });

  return (
    <TerminalShell
      selectedStock={selectedStock}
      marketState="日线收盘数据"
      source={workspace.source}
      cutoff={workspace.cutoff}
      freshness={workspace.freshness}
      lastSuccessfulAt={workspace.lastSuccessfulAt}
      onStockSelect={setSelectedStock}
    >
      <h1 className="visually-hidden">A 股研究终端</h1>
      <StockWorkspace state={workspace} />
    </TerminalShell>
  );
}
