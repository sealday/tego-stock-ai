import type { ReportContext } from '../../ai/report-contract';

export function DeterministicContext({ context }: { readonly context: ReportContext }) {
  const missing = context.availability.filter((item) => item.status === 'missing');
  return (
    <section className="ai-report__context" aria-labelledby="ai-report-context-heading">
      <h3 id="ai-report-context-heading">确定性分析摘要</h3>
      <dl>
        <div>
          <dt>研究标的</dt>
          <dd>
            {context.stock.name} · {context.stock.code}
          </dd>
        </div>
        <div>
          <dt>数据截止</dt>
          <dd>
            <time dateTime={context.cutoff}>{context.cutoff}</time>
          </dd>
        </div>
        <div>
          <dt>数据来源</dt>
          <dd>{context.source}</dd>
        </div>
        <div>
          <dt>收盘价</dt>
          <dd>{formatMetric(context.price.close)}</dd>
        </div>
      </dl>
      <div className="ai-report__cutoffs" role="group" aria-label="数据截止明细">
        <p>行情数据 {formatCutoff(context.cutoffs.overview)}</p>
        <p>历史数据 {formatCutoff(context.cutoffs.history)}</p>
        <p>基本面数据 {formatCutoff(context.cutoffs.fundamentals)}</p>
        <p>趋势评分数据 {formatCutoff(context.cutoffs.trend)}</p>
        <p>估值评分数据 {formatCutoff(context.cutoffs.valuation)}</p>
        <p>质量评分数据 {formatCutoff(context.cutoffs.quality)}</p>
      </div>
      <div className="ai-report__signal-row">
        <p>趋势评分 {formatScore(context.signals.trend.score)}</p>
        <p>估值评分 {formatScore(context.signals.valuation.score)}</p>
        <p>质量评分 {formatScore(context.signals.quality.score)}</p>
      </div>
      <div className="ai-report__disclosures">
        <div>
          <h4>缺失指标</h4>
          {missing.length === 0 ? (
            <p>当前上下文未声明缺失指标。</p>
          ) : (
            <ul>
              {missing.map((item) => (
                <li key={item.metric}>
                  <code>{item.metric}</code> · <span>{item.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>评分缺失输入</h4>
          <ScoreMissingInputs label="趋势评分" inputs={context.signals.trend.missingInputs} />
          <ScoreMissingInputs label="估值评分" inputs={context.signals.valuation.missingInputs} />
          <ScoreMissingInputs label="质量评分" inputs={context.signals.quality.missingInputs} />
        </div>
        <div>
          <h4>来源限制</h4>
          <ul>
            {context.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ScoreMissingInputs({
  label,
  inputs,
}: {
  readonly label: string;
  readonly inputs: readonly string[];
}) {
  const uniqueInputs = [...new Set(inputs)];
  return (
    <div role="group" aria-label={`${label}缺失输入`}>
      <p>{label}</p>
      {uniqueInputs.length === 0 ? (
        <p>无</p>
      ) : (
        <ul>
          {uniqueInputs.map((input) => (
            <li key={input}>
              <code>{input}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatCutoff(cutoff: string | null): string {
  return cutoff ?? '不可用';
}

function formatMetric(value: number | null): string {
  return value === null ? '缺失' : new Intl.NumberFormat('zh-CN').format(value);
}

function formatScore(value: number | null): string {
  return value === null ? '不可计算' : `${value.toFixed(1)} / 100`;
}
