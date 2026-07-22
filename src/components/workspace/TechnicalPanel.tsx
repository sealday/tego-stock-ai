import { PriceChart } from '../charts/PriceChart';
import type { StockWorkspaceState } from '../../hooks/use-stock-workspace';

export function TechnicalPanel({ state }: { readonly state: StockWorkspaceState }) {
  if (state.history.status === 'loading') {
    return (
      <section className="workspace-panel">
        <h2>价格与成交量</h2>
        <p role="status">历史数据加载中…</p>
      </section>
    );
  }
  if (state.history.status === 'error') {
    return (
      <section className="workspace-panel">
        <h2>价格与成交量</h2>
        <p role="alert">{state.history.message}</p>
      </section>
    );
  }
  if (state.analysis.technical === null || state.history.envelope.data.length === 0) {
    return (
      <section className="workspace-panel">
        <h2>价格与成交量</h2>
        <p className="missing-value">历史数据不足，无法计算技术指标。</p>
      </section>
    );
  }

  return (
    <section className="workspace-panel" aria-labelledby="technical-heading">
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">前复权日线</p>
          <h2 id="technical-heading">价格与成交量</h2>
        </div>
        <span className="data-status data-status--fresh">指标：确定性计算</span>
      </div>
      <PriceChart history={state.history.envelope.data} indicators={state.analysis.technical} />
      <div className="analysis-notes">
        <h3>计算说明</h3>
        <p>
          MA5 / MA20 / MA60、MACD、RSI14、布林带、波动率与回撤均由浏览器内纯函数计算，计算版本
          1.0.0。
        </p>
      </div>
    </section>
  );
}
