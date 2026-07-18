import type { AvailabilityMap, StockFundamentals } from '../../domain/stock';
import type { StockWorkspaceState } from '../../hooks/use-stock-workspace';

const METRICS: readonly {
  readonly key: keyof Omit<StockFundamentals, 'code' | 'date'>;
  readonly label: string;
  readonly unit: string;
  readonly percent?: true;
}[] = [
  { key: 'roe', label: 'ROE', unit: '%', percent: true },
  { key: 'grossMargin', label: '毛利率', unit: '%', percent: true },
  { key: 'revenueGrowth', label: '营收增长', unit: '%', percent: true },
  { key: 'profitGrowth', label: '利润增长', unit: '%', percent: true },
  { key: 'operatingCashToNetProfit', label: '经营现金 / 净利润', unit: '倍' },
  { key: 'debtToAssets', label: '资产负债率', unit: '%', percent: true },
];

export function FundamentalsPanel({ state }: { readonly state: StockWorkspaceState }) {
  if (state.fundamentals.status === 'loading') {
    return (
      <section className="workspace-panel">
        <h2>基本面与财务质量</h2>
        <p role="status">基本面加载中…</p>
      </section>
    );
  }
  if (state.fundamentals.status === 'error') {
    return (
      <section className="workspace-panel">
        <h2>基本面与财务质量</h2>
        <p role="alert">{state.fundamentals.message}</p>
      </section>
    );
  }
  const { data, availability } = state.fundamentals.envelope;
  return (
    <section className="workspace-panel" aria-labelledby="fundamentals-heading">
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">报告期数据</p>
          <h2 id="fundamentals-heading">基本面与财务质量</h2>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <caption>当前报告期指标与可用性</caption>
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
            {METRICS.map((metric) => (
              <MetricRow key={metric.key} metric={metric} data={data} availability={availability} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricRow({
  metric,
  data,
  availability,
}: {
  readonly metric: (typeof METRICS)[number];
  readonly data: StockFundamentals;
  readonly availability: AvailabilityMap;
}) {
  const value = data[metric.key];
  const entry = availability[metric.key];
  const reason = entry?.status === 'missing' ? entry.reason : '供应商未返回该字段';
  return (
    <tr>
      <th scope="row">{metric.label}</th>
      <td>{data.date}</td>
      <td>{value === null ? '—' : (metric.percent ? value * 100 : value).toFixed(2)}</td>
      <td>{metric.unit}</td>
      <td>
        {value === null ? (
          <span className="missing-value">缺失：{reason}</span>
        ) : (
          <span className="available-value">可用</span>
        )}
      </td>
    </tr>
  );
}
