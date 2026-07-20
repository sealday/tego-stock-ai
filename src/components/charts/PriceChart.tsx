import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
} from 'lightweight-charts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { TechnicalIndicators } from '../../analysis/indicators';
import type { DailyPrice } from '../../domain/stock';

export interface PriceChartProps {
  readonly history: readonly DailyPrice[];
  readonly indicators: TechnicalIndicators;
}

type OverlayIndicator = 'moving-averages' | 'bollinger';

export function PriceChart({ history, indicators }: PriceChartProps) {
  const overlayId = useId();
  const containerReference = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<OverlayIndicator>('moving-averages');
  const sortedHistory = useMemo(
    () => [...history].sort((left, right) => left.date.localeCompare(right.date)),
    [history],
  );

  useEffect(() => {
    const container = containerReference.current;
    if (container === null || sortedHistory.length === 0) {
      return undefined;
    }
    const canAutoSize = typeof ResizeObserver !== 'undefined';
    const chart = createChart(container, {
      autoSize: canAutoSize,
      width: canAutoSize ? 0 : Math.max(container.clientWidth, 320),
      height: 420,
      layout: {
        background: { color: '#081323' },
        textColor: '#a9bad2',
      },
      grid: {
        vertLines: { color: '#152944' },
        horzLines: { color: '#152944' },
      },
      rightPriceScale: { borderColor: '#29415f' },
      timeScale: { borderColor: '#29415f', timeVisible: false },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#df6474',
      downColor: '#45b987',
      borderUpColor: '#df6474',
      borderDownColor: '#45b987',
      wickUpColor: '#df6474',
      wickDownColor: '#45b987',
    });
    candles.setData(
      sortedHistory.map(
        (row): CandlestickData => ({
          time: row.date as Time,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
        }),
      ),
    );

    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceLineVisible: false },
      1,
    );
    volume.setData(
      sortedHistory.map(
        (row): HistogramData => ({
          time: row.date as Time,
          value: row.volumeShares,
          color: row.close >= row.open ? '#df647499' : '#45b98799',
        }),
      ),
    );

    addLine(chart, sortedHistory, indicators.sma5, '#68a8ff', 2);
    addLine(chart, sortedHistory, indicators.sma20, '#c39bff', 2);
    addLine(chart, sortedHistory, indicators.sma60, '#f2ba66', 2);
    if (overlay === 'bollinger') {
      addLine(chart, sortedHistory, indicators.bollinger20.upper, '#6dd4d8', 1);
      addLine(chart, sortedHistory, indicators.bollinger20.lower, '#6dd4d8', 1);
    }
    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [indicators, overlay, sortedHistory]);

  const latest = sortedHistory.at(-1);

  return (
    <div className="price-chart">
      <div className="price-chart__toolbar">
        <label htmlFor={overlayId}>叠加指标</label>
        <select
          id={overlayId}
          value={overlay}
          onChange={(event) => setOverlay(event.currentTarget.value as OverlayIndicator)}
        >
          <option value="moving-averages">MA5 / MA20 / MA60</option>
          <option value="bollinger">布林带 + MA5 / MA20 / MA60</option>
        </select>
      </div>
      <p className="visually-hidden">
        {latest === undefined
          ? '暂无可用价格数据。'
          : `最新日期 ${latest.date}，收盘价 ${formatNumber(latest.close)} 元，成交量 ${formatNumber(latest.volumeShares)} 股。图表包含日 K 线和成交量。当前叠加指标：${overlay === 'bollinger' ? '布林带、MA5、MA20、MA60' : 'MA5、MA20、MA60'}。`}
      </p>
      <div ref={containerReference} className="price-chart__canvas" aria-hidden="true" />
      <details className="price-chart__table">
        <summary>查看最近 20 日数值表</summary>
        <div className="table-scroll">
          <table>
            <caption>价格与成交量数值表</caption>
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col">开盘</th>
                <th scope="col">最高</th>
                <th scope="col">最低</th>
                <th scope="col">收盘</th>
                <th scope="col">成交量（股）</th>
              </tr>
            </thead>
            <tbody>
              {sortedHistory.slice(-20).map((row) => (
                <tr key={row.date}>
                  <th scope="row">{row.date}</th>
                  <td>{formatNumber(row.open)}</td>
                  <td>{formatNumber(row.high)}</td>
                  <td>{formatNumber(row.low)}</td>
                  <td>{formatNumber(row.close)}</td>
                  <td>{formatNumber(row.volumeShares, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function addLine(
  chart: ReturnType<typeof createChart>,
  history: readonly DailyPrice[],
  values: readonly (number | null)[],
  color: string,
  lineWidth: 1 | 2,
): void {
  const line = chart.addSeries(LineSeries, {
    color,
    lineWidth,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  const data: LineData[] = [];
  for (let index = 0; index < history.length; index += 1) {
    const value = values[index];
    const row = history[index];
    if (value !== null && value !== undefined && row !== undefined) {
      data.push({ time: row.date as Time, value });
    }
  }
  line.setData(data);
}

function formatNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(value);
}
