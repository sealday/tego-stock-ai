import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import {
  isoDate,
  stockCode,
  type AvailabilityMap,
  type MarketEnvelope,
  type StockSearchResult,
} from '../../domain/stock';

export type StockSearchFunction = (
  query: string,
  signal: AbortSignal,
) => Promise<readonly StockSearchResult[]>;

export interface StockSearchProps {
  readonly onSelect: (stock: StockSearchResult) => void;
  readonly search?: StockSearchFunction;
}

type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

const MINIMUM_QUERY_LENGTH = 2;
const SEARCH_DELAY_MS = 300;
const SAFE_SEARCH_ERROR = '暂时无法搜索，请稍后重试。';

export function StockSearch({ onSelect, search = searchStocks }: StockSearchProps) {
  const listboxId = useId();
  const committedQueryReference = useRef<string | null>(null);
  const generationReference = useRef(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly StockSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [activeIndex, setActiveIndex] = useState(-1);
  const normalizedQuery = query.trim();

  useEffect(() => {
    setActiveIndex(-1);
    const committedQuery = committedQueryReference.current;
    if (committedQuery !== null) {
      committedQueryReference.current = null;
      if (committedQuery === normalizedQuery) {
        return undefined;
      }
    }
    if (normalizedQuery.length < MINIMUM_QUERY_LENGTH) {
      setResults([]);
      setStatus('idle');
      return undefined;
    }

    const generation = generationReference.current;
    setResults([]);
    setStatus('loading');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void search(normalizedQuery, controller.signal)
        .then((matches) => {
          if (controller.signal.aborted || generation !== generationReference.current) {
            return;
          }
          setResults(matches);
          setStatus('success');
        })
        .catch(() => {
          if (controller.signal.aborted || generation !== generationReference.current) {
            return;
          }
          setResults([]);
          setStatus('error');
        });
    }, SEARCH_DELAY_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [normalizedQuery, search]);

  function choose(stock: StockSearchResult) {
    generationReference.current += 1;
    committedQueryReference.current = stock.name;
    setQuery(stock.name);
    setResults([]);
    setStatus('idle');
    setActiveIndex(-1);
    onSelect(stock);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected !== undefined) {
        choose(selected);
      }
    } else if (event.key === 'Escape') {
      generationReference.current += 1;
      setResults([]);
      setStatus('idle');
      setActiveIndex(-1);
    }
  }

  const hasPopup = status === 'loading' || status === 'error' || status === 'success';

  return (
    <div className="stock-search">
      <label className="visually-hidden" htmlFor={`${listboxId}-input`}>
        搜索 A 股
      </label>
      <input
        id={`${listboxId}-input`}
        className="stock-search__input"
        type="search"
        role="combobox"
        value={query}
        autoComplete="off"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={hasPopup}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        placeholder="代码 / 名称 / 拼音"
        onChange={(event) => {
          const nextQuery = event.currentTarget.value;
          generationReference.current += 1;
          setQuery(nextQuery);
          setResults([]);
          setActiveIndex(-1);
          setStatus(nextQuery.trim().length >= MINIMUM_QUERY_LENGTH ? 'loading' : 'idle');
        }}
        onKeyDown={handleKeyDown}
      />
      {hasPopup ? (
        <div className="stock-search__popover" id={listboxId}>
          {status === 'loading' ? (
            <p className="stock-search__message" role="status" aria-live="polite">
              正在搜索…
            </p>
          ) : null}
          {status === 'error' ? (
            <p
              className="stock-search__message stock-search__message--error"
              role="alert"
              aria-live="assertive"
            >
              {SAFE_SEARCH_ERROR}
            </p>
          ) : null}
          {status === 'success' && results.length === 0 ? (
            <p className="stock-search__message" role="status" aria-live="polite">
              未找到匹配的 A 股
            </p>
          ) : null}
          {status === 'success' && results.length > 0 ? (
            <ul className="stock-search__results" role="listbox">
              {results.map((stock, index) => (
                <li
                  id={`${listboxId}-${index}`}
                  key={stock.code}
                  className="stock-search__result"
                  role="option"
                  aria-selected={activeIndex === index}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(stock);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="stock-search__name">{stock.name}</span>
                  <span>{stock.code}</span>
                  <span>{stock.pinyinAbbreviation}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const searchStocks: StockSearchFunction = async (query, signal) => {
  const response = await fetch(`/api/stocks/search?q=${encodeURIComponent(query)}`, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error('Stock search request failed');
  }

  const body: unknown = await response.json();
  return parseSearchEnvelope(body).data;
};

function parseSearchEnvelope(value: unknown): MarketEnvelope<readonly StockSearchResult[]> {
  if (!isRecord(value)) {
    throw new TypeError('Invalid stock search envelope');
  }
  const data = value.data;
  if (!Array.isArray(data)) {
    throw new TypeError('Invalid stock search results');
  }
  const results = data.map(parseSearchResult);
  const asOf = isoDate(readString(value, 'asOf'));
  if (value.source !== 'Tushare Pro' || !isFreshness(value.freshness)) {
    throw new TypeError('Invalid stock search metadata');
  }
  if (!isStringArray(value.limitations)) {
    throw new TypeError('Invalid stock search availability');
  }

  return {
    data: results,
    asOf,
    source: 'Tushare Pro',
    freshness: value.freshness,
    availability: parseAvailability(value.availability),
    limitations: value.limitations,
  };
}

function parseSearchResult(value: unknown): StockSearchResult {
  if (!isRecord(value)) {
    throw new TypeError('Invalid stock search result');
  }
  return {
    code: stockCode(readString(value, 'code')),
    name: readString(value, 'name'),
    pinyinAbbreviation: readString(value, 'pinyinAbbreviation'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new TypeError(`Invalid ${key}`);
  }
  return field;
}

function isFreshness(value: unknown): value is MarketEnvelope<unknown>['freshness'] {
  return value === 'fresh' || value === 'stale';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseAvailability(value: unknown): AvailabilityMap {
  if (!isRecord(value)) {
    throw new TypeError('Invalid stock search availability');
  }
  const availability: Record<string, AvailabilityMap[string]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      throw new TypeError('Invalid stock search availability entry');
    }
    if (entry.status === 'available' && 'value' in entry) {
      availability[key] = { status: 'available', value: entry.value };
    } else if (entry.status === 'missing' && typeof entry.reason === 'string') {
      availability[key] = { status: 'missing', reason: entry.reason };
    } else {
      throw new TypeError('Invalid stock search availability entry');
    }
  }
  return availability;
}
