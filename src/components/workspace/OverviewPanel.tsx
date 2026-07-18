import type { AvailabilityMap } from '../../domain/stock';
import type { StockWorkspaceState } from '../../hooks/use-stock-workspace';
import { DataStatus } from './DataStatus';

export function OverviewPanel({ state }: { readonly state: StockWorkspaceState }) {
  if (state.overview.status !== 'success') {
    return (
      <ResourceFallback
        label="行情概览"
        status={state.overview.status}
        message={state.overview.status === 'error' ? state.overview.message : undefined}
      />
    );
  }
  const { data, availability } = state.overview.envelope;

  return (
    <section className="workspace-panel" aria-labelledby="overview-heading">
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">日线收盘</p>
          <h2 id="overview-heading">市场结构概览</h2>
        </div>
        <DataStatus label="行情概览" resource={state.overview} />
      </div>

      <div className="quote-strip">
        <div>
          <span className="terminal-label">收盘价</span>
          <strong className="quote-strip__price">{formatNumber(data.close)}</strong>
          <span className="quote-strip__unit">CNY</span>
        </div>
        <ChangeLabel change={data.changePercent} availability={availability} />
      </div>

      <div className="score-grid" aria-label="确定性量化评分">
        <ScoreCard
          label="趋势评分"
          score={state.analysis.trend.score}
          band={state.analysis.trend.band}
        />
        <ScoreCard
          label="财务质量"
          score={state.analysis.quality.score}
          band={state.analysis.quality.band}
        />
        <ScoreCard
          label="估值位置"
          score={state.analysis.valuation.score}
          band={state.analysis.valuation.band}
        />
      </div>

      <dl className="metric-grid">
        <Metric
          label="市盈率 TTM"
          value={data.peTtm}
          unit="倍"
          reason={missingReason(availability, 'peTtm')}
        />
        <Metric
          label="市净率"
          value={data.pb}
          unit="倍"
          reason={missingReason(availability, 'pb')}
        />
        <Metric
          label="总市值"
          value={data.totalMarketValueCny === null ? null : data.totalMarketValueCny / 100_000_000}
          unit="亿元"
          reason={missingReason(availability, 'totalMarketValueCny')}
        />
        <Metric
          label="前收盘"
          value={data.previousClose}
          unit="元"
          reason={missingReason(availability, 'previousClose')}
        />
      </dl>
    </section>
  );
}

function ChangeLabel({
  change,
  availability,
}: {
  readonly change: number | null;
  readonly availability: AvailabilityMap;
}) {
  if (change === null) {
    return (
      <p className="missing-value">
        {missingReason(availability, 'changePercent') ?? '涨跌幅不可用'}
      </p>
    );
  }
  const isUp = change >= 0;
  return (
    <p className={`market-change market-change--${isUp ? 'up' : 'down'}`}>
      <span>{isUp ? '上涨' : '下跌'}</span>{' '}
      <strong>{`${isUp ? '+' : ''}${change.toFixed(2)}%`}</strong>
    </p>
  );
}

function ScoreCard({
  label,
  score,
  band,
}: {
  readonly label: string;
  readonly score: number | null;
  readonly band: string | null;
}) {
  return (
    <article className="score-card">
      <h3>{label}</h3>
      {score === null ? (
        <p className="missing-value">参考数据不足</p>
      ) : (
        <>
          <strong>{score.toFixed(1)} / 100</strong>
          <span>{bandLabel(band)}</span>
        </>
      )}
    </article>
  );
}

function Metric({
  label,
  value,
  unit,
  reason,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  readonly reason?: string | undefined;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value === null ? (
          <span className="missing-value">缺失：{reason ?? '未提供'}</span>
        ) : (
          `${formatNumber(value)} ${unit}`
        )}
      </dd>
    </div>
  );
}

function ResourceFallback({
  label,
  status,
  message,
}: {
  readonly label: string;
  readonly status: 'loading' | 'error';
  readonly message?: string | undefined;
}) {
  return (
    <section className="workspace-panel">
      <h2>{label}</h2>
      {status === 'loading' ? <p role="status">加载中…</p> : <p role="alert">{message}</p>}
    </section>
  );
}

function missingReason(availability: AvailabilityMap, key: string): string | undefined {
  const entry = availability[key];
  return entry?.status === 'missing' ? entry.reason : undefined;
}

function bandLabel(band: string | null): string {
  return (
    (
      { weak: '偏弱', mixed: '混合', constructive: '建设性', strong: '强势' } as Record<
        string,
        string
      >
    )[band ?? ''] ?? '未分级'
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}
