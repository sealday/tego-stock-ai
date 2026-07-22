import type { SanitizedAiProviderSettings } from '../ai/provider-settings';
import { sanitizeAiProviderSettings } from '../ai/provider-settings';
import { invalidStoredData } from './database';
import type { LocalExportSnapshot, LocalRepository, SavedReport } from './repository';

export const LOCAL_EXPORT_SCHEMA = 'tego-stock-ai-local-export';
export const LOCAL_EXPORT_VERSION = 1;

export interface LocalDataExport {
  readonly schema: typeof LOCAL_EXPORT_SCHEMA;
  readonly version: typeof LOCAL_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly watchlist: Awaited<ReturnType<LocalRepository['listWatchlist']>>;
  readonly settings: SanitizedAiProviderSettings | null;
  readonly reports: readonly SavedReport[];
}

export interface CreateLocalDataExportOptions {
  readonly now?: (() => Date) | undefined;
}

type ExportRepository = Pick<LocalRepository, 'getExportSnapshot'>;

export async function createLocalDataExport(
  repository: ExportRepository,
  options: CreateLocalDataExportOptions = {},
): Promise<LocalDataExport> {
  const now = options.now ?? (() => new Date());
  const { watchlist, settings, reports }: LocalExportSnapshot =
    await repository.getExportSnapshot();
  let exportedAt: string;
  try {
    exportedAt = now().toISOString();
  } catch (cause) {
    throw invalidStoredData(cause);
  }
  return {
    schema: LOCAL_EXPORT_SCHEMA,
    version: LOCAL_EXPORT_VERSION,
    exportedAt,
    watchlist,
    settings: settings === null ? null : sanitizeAiProviderSettings(settings),
    reports,
  };
}

export function serializeLocalDataExport(value: LocalDataExport): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function downloadLocalDataExport(
  serialized: string,
  exportedAt: string,
  documentReference: Document = document,
  urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
): void {
  const objectUrl = urlApi.createObjectURL(
    new Blob([serialized], { type: 'application/json;charset=utf-8' }),
  );
  let anchor: HTMLAnchorElement | undefined;
  let downloadStarted = false;
  try {
    anchor = documentReference.createElement('a');
    const date = exportedAt.slice(0, 10);
    anchor.href = objectUrl;
    anchor.download = `tego-stock-ai-local-export-${date}.json`;
    anchor.hidden = true;
    documentReference.body.append(anchor);
    anchor.click();
    downloadStarted = true;
  } finally {
    try {
      anchor?.remove();
    } finally {
      if (downloadStarted) {
        globalThis.setTimeout(() => urlApi.revokeObjectURL(objectUrl), 0);
      } else {
        urlApi.revokeObjectURL(objectUrl);
      }
    }
  }
}
