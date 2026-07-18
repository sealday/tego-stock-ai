import type { MarketEnvelope } from '../../domain/stock';
import type { WorkspaceResource } from '../../hooks/use-stock-workspace';

export interface DataStatusProps<T> {
  readonly label: string;
  readonly resource: WorkspaceResource<T>;
}

export function DataStatus<T>({ label, resource }: DataStatusProps<T>) {
  if (resource.status === 'loading') {
    return (
      <span className="data-status data-status--loading" role="status">
        {label}：加载中
      </span>
    );
  }
  if (resource.status === 'error') {
    return <span className="data-status data-status--error">{label}：错误</span>;
  }
  return (
    <span
      className={`data-status data-status--${resource.envelope.freshness}`}
      title={resource.envelope.freshness === 'stale' ? '数据已过期' : '数据可用'}
    >
      {label}：{freshnessLabel(resource.envelope.freshness)}
    </span>
  );
}

function freshnessLabel(freshness: MarketEnvelope<unknown>['freshness']): string {
  return freshness === 'fresh' ? '可用' : '数据延迟';
}
