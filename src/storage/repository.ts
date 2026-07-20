import { z } from 'zod';

import { MAX_AI_REPORT_TEXT_BYTES, buildChatCompletionsUrl } from '../ai/client';
import {
  REPORT_SECTION_HEADINGS,
  finalizeReportText,
  isInterruptedReportContractViolation,
  parseCompleteReport,
  validateReportContext,
  type ReportContext,
  type ReportSection,
} from '../ai/report-contract';
import type { GeneratedAiReport } from '../ai/report-model';
import type { AiProviderSettings } from '../ai/provider-settings';
import { stockCode, type StockSearchResult } from '../domain/stock';
import {
  LOCAL_STORE_NAMES,
  LocalStorageError,
  invalidStoredData,
  openLocalDatabase,
  runLocalTransaction,
  type OpenLocalDatabaseOptions,
} from './database';

export const LOCAL_RECORD_SCHEMA_VERSION = 1;
const CURRENT_SETTINGS_ID = 'current';

export interface SavedReport {
  readonly id: string;
  readonly savedAt: string;
  readonly report: GeneratedAiReport;
}

export interface LocalRepositoryOptions extends OpenLocalDatabaseOptions {
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
}

interface StoredWatchlistRecord {
  readonly schemaVersion: 1;
  readonly code: string;
  readonly name: string;
  readonly pinyinAbbreviation: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredProviderSettingsRecord {
  readonly id: typeof CURRENT_SETTINGS_ID;
  readonly schemaVersion: 1;
  readonly baseUrl: string;
  readonly model: string;
  readonly rememberApiKey: boolean;
  readonly apiKey?: string | undefined;
  readonly updatedAt: string;
}

interface StoredReportRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly savedAt: string;
  readonly report: GeneratedAiReport;
}

export interface StoredUiPreferencesRecord {
  readonly id: typeof CURRENT_SETTINGS_ID;
  readonly schemaVersion: 1;
  readonly compactNavigation: boolean;
  readonly updatedAt: string;
}

const nonemptyString = z.string().trim().min(1).max(512);
const timestampSchema = z.string().datetime({ offset: true });
const reportHeadingSchema = z.enum(REPORT_SECTION_HEADINGS);
const reportSectionSchema = z.strictObject({
  heading: reportHeadingSchema,
  content: z.string().max(MAX_AI_REPORT_TEXT_BYTES),
});
const sanitizedProviderSchema = z
  .strictObject({
    baseUrl: nonemptyString,
    model: nonemptyString,
    rememberApiKey: z.boolean(),
  })
  .superRefine((provider, context) => {
    try {
      buildChatCompletionsUrl(provider.baseUrl);
    } catch {
      context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Invalid provider Base URL' });
    }
  });
const completeReportSchema = z.strictObject({
  status: z.literal('complete'),
  completedAt: timestampSchema,
  provider: sanitizedProviderSchema,
  context: z.unknown(),
  rawText: z.string(),
  sections: z.array(reportSectionSchema).length(REPORT_SECTION_HEADINGS.length),
});
const draftReportSchema = z.strictObject({
  status: z.literal('draft'),
  interruptedAt: timestampSchema,
  provider: sanitizedProviderSchema,
  context: z.unknown(),
  rawText: z.string(),
  sections: z.array(reportSectionSchema).max(REPORT_SECTION_HEADINGS.length),
  reason: z.enum(['cancelled', 'stream-interrupted', 'contract-invalid']),
  contractFailure: z
    .enum([
      'nonempty-preamble',
      'unknown-heading',
      'duplicate-heading',
      'out-of-order-heading',
      'incomplete-report',
      'empty-section',
    ])
    .optional(),
  errorMessage: z.string().trim().min(1).max(2_000).optional(),
});
const generatedReportSchema = z.discriminatedUnion('status', [
  completeReportSchema,
  draftReportSchema,
]);

const storedWatchlistSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_RECORD_SCHEMA_VERSION),
  code: nonemptyString,
  name: nonemptyString,
  pinyinAbbreviation: z.string().trim().min(1).max(32),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const storedSettingsSchema = z
  .strictObject({
    id: z.literal(CURRENT_SETTINGS_ID),
    schemaVersion: z.literal(LOCAL_RECORD_SCHEMA_VERSION),
    baseUrl: nonemptyString,
    model: z.string().trim().max(256),
    rememberApiKey: z.boolean(),
    apiKey: z.string().min(1).max(16_384).optional(),
    updatedAt: timestampSchema,
  })
  .superRefine((settings, context) => {
    try {
      buildChatCompletionsUrl(settings.baseUrl);
    } catch {
      context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Invalid provider Base URL' });
    }
    if (!settings.rememberApiKey && settings.apiKey !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'An API key requires explicit remember consent',
      });
    }
  });

const providerSettingsInputSchema = z.strictObject({
  baseUrl: z.string(),
  model: z.string(),
  apiKey: z.string().max(16_384),
  rememberApiKey: z.boolean(),
});

const storedReportSchema = z.strictObject({
  id: nonemptyString,
  schemaVersion: z.literal(LOCAL_RECORD_SCHEMA_VERSION),
  savedAt: timestampSchema,
  report: z.unknown(),
});

export class LocalRepository {
  private databasePromise: Promise<IDBDatabase> | undefined;
  private readonly databaseOptions: OpenLocalDatabaseOptions;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: LocalRepositoryOptions = {}) {
    this.databaseOptions = {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
      ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
    };
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? defaultReportId;
  }

  async listWatchlist(): Promise<readonly StockSearchResult[]> {
    const records = await this.readAll<StoredWatchlistRecord>('watchlists');
    return records
      .map(validateWatchlistRecord)
      .sort((left, right) => left.code.localeCompare(right.code))
      .map(({ code, name, pinyinAbbreviation }) => ({
        code: stockCode(code),
        name,
        pinyinAbbreviation,
      }));
  }

  async putWatchlistEntry(entry: {
    readonly code: string;
    readonly name: string;
    readonly pinyinAbbreviation: string;
  }): Promise<void> {
    const normalized = validateWatchlistInput(entry);
    const database = await this.database();
    await runLocalTransaction(database, ['watchlists'], 'readwrite', async (transaction) => {
      const existing = await transaction.get<StoredWatchlistRecord>('watchlists', normalized.code);
      const timestamp = validTimestamp(this.now());
      const record: StoredWatchlistRecord = {
        schemaVersion: LOCAL_RECORD_SCHEMA_VERSION,
        code: normalized.code,
        name: normalized.name,
        pinyinAbbreviation: normalized.pinyinAbbreviation,
        createdAt: existing === undefined ? timestamp : validateWatchlistRecord(existing).createdAt,
        updatedAt: timestamp,
      };
      await transaction.put('watchlists', record);
    });
  }

  async removeWatchlistEntry(code: string): Promise<void> {
    const normalizedCode = validStockCode(code);
    const database = await this.database();
    await runLocalTransaction(database, ['watchlists'], 'readwrite', (transaction) =>
      transaction.delete('watchlists', normalizedCode),
    );
  }

  async getSettings(): Promise<AiProviderSettings | null> {
    const database = await this.database();
    const record = await runLocalTransaction<StoredProviderSettingsRecord | undefined>(
      database,
      ['providerSettings'],
      'readonly',
      (transaction) => transaction.get('providerSettings', CURRENT_SETTINGS_ID),
    );
    if (record === undefined) {
      return null;
    }
    const settings = parseStoredSettings(record);
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.rememberApiKey ? (settings.apiKey ?? '') : '',
      rememberApiKey: settings.rememberApiKey,
    };
  }

  async saveSettings(settings: AiProviderSettings): Promise<void> {
    const record = storedSettingsFromInput(settings, this.now());
    const database = await this.database();
    await runLocalTransaction(database, ['providerSettings'], 'readwrite', (transaction) =>
      transaction.put('providerSettings', record),
    );
  }

  async listReports(): Promise<readonly SavedReport[]> {
    const records = await this.readAll<StoredReportRecord>('reports');
    return records
      .map(parseStoredReport)
      .sort(
        (left, right) =>
          right.savedAt.localeCompare(left.savedAt) || left.id.localeCompare(right.id),
      )
      .map(({ id, savedAt, report }) => ({ id, savedAt, report }));
  }

  async saveReport(report: GeneratedAiReport): Promise<SavedReport> {
    const validatedReport = validateGeneratedReport(report);
    const record: StoredReportRecord = {
      id: validRecordId(this.createId()),
      schemaVersion: LOCAL_RECORD_SCHEMA_VERSION,
      savedAt: validTimestamp(this.now()),
      report: validatedReport,
    };
    const database = await this.database();
    await runLocalTransaction(database, ['reports'], 'readwrite', (transaction) =>
      transaction.put('reports', record),
    );
    return { id: record.id, savedAt: record.savedAt, report: record.report };
  }

  async deleteReport(id: string): Promise<void> {
    const database = await this.database();
    await runLocalTransaction(database, ['reports'], 'readwrite', (transaction) =>
      transaction.delete('reports', validRecordId(id)),
    );
  }

  async clearCredentials(): Promise<void> {
    const database = await this.database();
    await runLocalTransaction(database, ['providerSettings'], 'readwrite', async (transaction) => {
      const current = await transaction.get<StoredProviderSettingsRecord>(
        'providerSettings',
        CURRENT_SETTINGS_ID,
      );
      if (current === undefined) {
        return;
      }
      const settings = parseStoredSettings(current);
      const cleared: StoredProviderSettingsRecord = {
        id: CURRENT_SETTINGS_ID,
        schemaVersion: LOCAL_RECORD_SCHEMA_VERSION,
        baseUrl: settings.baseUrl,
        model: settings.model,
        rememberApiKey: false,
        updatedAt: validTimestamp(this.now()),
      };
      await transaction.put('providerSettings', cleared);
    });
  }

  async clearAll(): Promise<void> {
    const database = await this.database();
    await runLocalTransaction(database, LOCAL_STORE_NAMES, 'readwrite', async (transaction) => {
      for (const storeName of LOCAL_STORE_NAMES) {
        await transaction.clear(storeName);
      }
    });
  }

  async close(): Promise<void> {
    const promise = this.databasePromise;
    this.databasePromise = undefined;
    if (promise === undefined) {
      return;
    }
    try {
      const database = await promise;
      database.close();
    } catch {
      // A failed open has no database handle to close.
    }
  }

  private async readAll<T>(storeName: (typeof LOCAL_STORE_NAMES)[number]): Promise<readonly T[]> {
    const database = await this.database();
    return runLocalTransaction(database, [storeName], 'readonly', (transaction) =>
      transaction.getAll<T>(storeName),
    );
  }

  private async database(): Promise<IDBDatabase> {
    const attempt = this.databasePromise ?? openLocalDatabase(this.databaseOptions);
    this.databasePromise = attempt;
    try {
      return await attempt;
    } catch (cause) {
      if (this.databasePromise === attempt) {
        this.databasePromise = undefined;
      }
      throw cause;
    }
  }
}

function storedSettingsFromInput(
  settings: AiProviderSettings,
  now: Date,
): StoredProviderSettingsRecord {
  const validated = parseOrInvalid(providerSettingsInputSchema, settings);
  const candidate: StoredProviderSettingsRecord = {
    id: CURRENT_SETTINGS_ID,
    schemaVersion: LOCAL_RECORD_SCHEMA_VERSION,
    baseUrl: validated.baseUrl.trim(),
    model: validated.model.trim(),
    rememberApiKey: validated.rememberApiKey,
    ...(validated.rememberApiKey && validated.apiKey.length > 0
      ? { apiKey: validated.apiKey }
      : {}),
    updatedAt: validTimestamp(now),
  };
  return parseStoredSettings(candidate);
}

function parseStoredSettings(value: unknown): StoredProviderSettingsRecord {
  return parseOrInvalid(storedSettingsSchema, value);
}

function parseStoredReport(value: unknown): StoredReportRecord {
  const record = parseOrInvalid(storedReportSchema, value);
  return { ...record, report: validateGeneratedReport(record.report) };
}

function validateGeneratedReport(value: unknown): GeneratedAiReport {
  const report = parseOrInvalid(generatedReportSchema, value);
  const context = validateReportContextOrInvalid(report.context);
  const validatedReport = { ...report, context } as GeneratedAiReport;
  validateUtf8Size(report.rawText);
  validateSectionOrder(report.sections);

  if (report.status === 'complete') {
    let parsedSections: readonly ReportSection[];
    try {
      parsedSections = parseCompleteReport(report.rawText);
    } catch (cause) {
      throw invalidStoredData(cause);
    }
    if (JSON.stringify(parsedSections) !== JSON.stringify(report.sections)) {
      throw invalidStoredData();
    }
  } else {
    const parsed = finalizeReportText(report.rawText);
    if (JSON.stringify(parsed.sections) !== JSON.stringify(report.sections)) {
      throw invalidStoredData();
    }
    const contractViolation = isInterruptedReportContractViolation(parsed);
    if (report.reason === 'contract-invalid') {
      if (!contractViolation || report.contractFailure !== parsed.reason) {
        throw invalidStoredData();
      }
    } else if (contractViolation || report.contractFailure !== undefined) {
      throw invalidStoredData();
    }
  }
  return validatedReport;
}

function validateReportContextOrInvalid(value: unknown): ReportContext {
  try {
    return validateReportContext(value);
  } catch (cause) {
    throw invalidStoredData(cause);
  }
}

function validateSectionOrder(sections: readonly ReportSection[]): void {
  for (const [index, section] of sections.entries()) {
    if (section.heading !== REPORT_SECTION_HEADINGS[index]) {
      throw invalidStoredData();
    }
  }
}

function validateUtf8Size(value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_AI_REPORT_TEXT_BYTES) {
    throw invalidStoredData();
  }
}

function validateWatchlistInput(value: {
  readonly code: string;
  readonly name: string;
  readonly pinyinAbbreviation: string;
}): StockSearchResult {
  try {
    const parsed = z
      .strictObject({
        code: nonemptyString,
        name: nonemptyString,
        pinyinAbbreviation: z.string().trim().min(1).max(32),
      })
      .parse(value);
    return { ...parsed, code: stockCode(parsed.code) };
  } catch (cause) {
    throw invalidStoredData(cause);
  }
}

function validateWatchlistRecord(
  value: unknown,
): StoredWatchlistRecord & { readonly code: string } {
  const record = parseOrInvalid(storedWatchlistSchema, value);
  validStockCode(record.code);
  return record;
}

function validStockCode(value: string): string {
  try {
    return stockCode(value);
  } catch (cause) {
    throw invalidStoredData(cause);
  }
}

function validRecordId(value: string): string {
  try {
    return nonemptyString.parse(value);
  } catch (cause) {
    throw invalidStoredData(cause);
  }
}

function validTimestamp(value: Date): string {
  try {
    return timestampSchema.parse(value.toISOString());
  } catch (cause) {
    throw invalidStoredData(cause);
  }
}

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    if (cause instanceof LocalStorageError) {
      throw cause;
    }
    throw invalidStoredData(cause);
  }
}

function defaultReportId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `report-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
