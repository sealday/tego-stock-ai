import type { AvailabilityMap } from '../../domain/stock';
import type { StockWorkspaceState } from '../../hooks/use-stock-workspace';

export function FinancialTrendsPanel({ state }: { readonly state: StockWorkspaceState }) {
  if (state.fundamentals.status !== 'success') {
    return (
      <section className="workspace-panel">
        <h2>财务趋势</h2>
        {state.fundamentals.status === 'loading' ? (
          <p role="status">加载中…</p>
        ) : (
          <p role="alert">{state.fundamentals.message}</p>
        )}
      </section>
    );
  }
  const { data, availability } = state.fundamentals.envelope;
  return (
    <section className="workspace-panel" aria-labelledby="trends-heading">
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">可比性说明</p>
          <h2 id="trends-heading">财务趋势</h2>
        </div>
      </div>
      <p className="availability-callout">当前可用报告期：{data.date}</p>
      <p className="missing-value">暂无可比历史，不生成推测序列。</p>
      <div className="table-scroll">
        <table>
          <caption>当前可用财务数据</caption>
          <thead>
            <tr>
              <th scope="col">指标</th>
              <th scope="col">报告期</th>
              <th scope="col">数值</th>
              <th scope="col">单位</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">ROE</th>
              <td>{data.date}</td>
              <td>{data.roe === null ? '—' : (data.roe * 100).toFixed(2)}</td>
              <td>%</td>
              <td>{availabilityLabel(availability, 'roe', data.roe)}</td>
            </tr>
            <tr>
              <th scope="row">毛利率</th>
              <td>{data.date}</td>
              <td>{data.grossMargin === null ? '—' : (data.grossMargin * 100).toFixed(2)}</td>
              <td>%</td>
              <td>{availabilityLabel(availability, 'grossMargin', data.grossMargin)}</td>
            </tr>
            <tr>
              <th scope="row">营收增长</th>
              <td>{data.date}</td>
              <td>{data.revenueGrowth === null ? '—' : (data.revenueGrowth * 100).toFixed(2)}</td>
              <td>%</td>
              <td>{availabilityLabel(availability, 'revenueGrowth', data.revenueGrowth)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function availabilityLabel(
  availability: AvailabilityMap,
  key: string,
  value: number | null,
): string {
  if (value !== null) {
    return '可用';
  }
  const entry = availability[key];
  return `缺失：${entry?.status === 'missing' ? entry.reason : '未提供'}`;
}
