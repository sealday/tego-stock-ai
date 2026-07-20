import { useEffect, useRef, useState } from 'react';

import {
  createLocalDataExport,
  downloadLocalDataExport,
  serializeLocalDataExport,
} from '../../storage/export';
import type { LocalRepository } from '../../storage/repository';

export type PrivacyControlsRepository = Pick<
  LocalRepository,
  'clearAll' | 'clearCredentials' | 'getExportSnapshot'
>;

export interface PrivacyControlsProps {
  readonly repository: PrivacyControlsRepository;
  readonly disabled?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
  readonly download?:
    | ((serialized: string, exportedAt: string) => void | Promise<void>)
    | undefined;
  readonly onCredentialsClearStart?: (() => void) | undefined;
  readonly onCredentialsClearSuccess?: (() => void | Promise<void>) | undefined;
  readonly onCredentialsClearFailure?: (() => void | Promise<void>) | undefined;
  readonly onAllClearStart?: (() => void) | undefined;
  readonly onAllCleared?: (() => void | Promise<void>) | undefined;
  readonly onAllClearFailure?: (() => void | Promise<void>) | undefined;
}

type PrivacyAction = 'export' | 'credentials' | 'all';

export function PrivacyControls({
  repository,
  disabled = false,
  now,
  download = downloadLocalDataExport,
  onCredentialsClearStart,
  onCredentialsClearSuccess,
  onCredentialsClearFailure,
  onAllClearStart,
  onAllCleared,
  onAllClearFailure,
}: PrivacyControlsProps) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [busy, setBusy] = useState<PrivacyAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<PrivacyAction | null>(null);
  const openButton = useRef<HTMLButtonElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const confirmButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmationOpen) {
      cancelButton.current?.focus();
    }
  }, [confirmationOpen]);

  const closeConfirmation = () => {
    setConfirmationOpen(false);
    openButton.current?.focus();
  };

  const perform = async (action: PrivacyAction, allowWhileDisabled = false) => {
    if (disabled && !allowWhileDisabled) {
      return;
    }
    setBusy(action);
    setNotice(null);
    setFailedAction(null);
    if (action === 'all') {
      onAllClearStart?.();
    } else if (action === 'credentials') {
      onCredentialsClearStart?.();
    }
    try {
      if (action === 'export') {
        const exported = await createLocalDataExport(repository, {
          ...(now === undefined ? {} : { now }),
        });
        await download(serializeLocalDataExport(exported), exported.exportedAt);
        setNotice('本地数据已导出。');
      } else if (action === 'credentials') {
        await repository.clearCredentials();
        await onCredentialsClearSuccess?.();
        setNotice('AI 凭据已清除；提供商地址、模型与报告均已保留。');
      } else {
        await repository.clearAll();
        await onAllCleared?.();
        setNotice('全部本地数据已清除。');
      }
    } catch {
      if (action === 'all') {
        await recoverSafely(onAllClearFailure);
      } else if (action === 'credentials') {
        await recoverSafely(onCredentialsClearFailure);
      }
      setFailedAction(action);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      id="local-privacy"
      className="workspace-panel privacy-controls"
      aria-labelledby="local-privacy-heading"
      tabIndex={-1}
    >
      <div className="panel-heading-row">
        <div>
          <p className="panel-kicker">无账户 · 无云同步</p>
          <h2 id="local-privacy-heading">本地隐私与数据控制</h2>
        </div>
      </div>
      <p className="local-privacy-note">
        全部数据仅保存在当前浏览器。本项目不提供账户或云同步；卸载浏览器、清理站点数据或更换设备都可能丢失这些内容。
      </p>
      <p className="local-privacy-note">
        只有明确勾选“在此设备上记住 API key”后才会持久化 key；导出文件永远排除 API key。
      </p>
      <div className="privacy-controls__actions">
        <button
          type="button"
          disabled={disabled || busy !== null}
          onClick={() => void perform('export')}
        >
          {busy === 'export' ? '导出中…' : '导出本地数据 JSON'}
        </button>
        <button
          type="button"
          disabled={disabled || busy !== null}
          onClick={() => void perform('credentials')}
        >
          {busy === 'credentials' ? '清除中…' : '清除 AI 凭据'}
        </button>
        <button
          ref={openButton}
          type="button"
          className="privacy-controls__danger"
          disabled={disabled || busy !== null}
          onClick={() => setConfirmationOpen(true)}
        >
          清除全部本地数据
        </button>
      </div>

      {notice === null ? null : (
        <p className="local-storage-notice" role="status">
          {notice}
        </p>
      )}
      {failedAction === null ? null : (
        <div className="local-storage-error" role="alert">
          <p>本地数据操作失败，未宣称成功且未显示内部存储细节。</p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void perform(failedAction, true)}
          >
            重试上一次操作
          </button>
        </div>
      )}

      {confirmationOpen ? (
        <div
          className="privacy-dialog-backdrop"
          role="presentation"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeConfirmation();
            } else if (event.key === 'Tab') {
              const first = cancelButton.current;
              const last = confirmButton.current;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <div
            className="privacy-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-all-dialog-heading"
            aria-describedby="clear-all-dialog-description"
          >
            <h3 id="clear-all-dialog-heading">确认清除全部本地数据</h3>
            <p id="clear-all-dialog-description">
              这将删除自选股、界面偏好、AI 设置与全部报告。此操作无法撤销。
            </p>
            <div className="privacy-dialog__actions">
              <button ref={cancelButton} type="button" onClick={closeConfirmation}>
                取消
              </button>
              <button
                ref={confirmButton}
                type="button"
                className="privacy-controls__danger"
                onClick={() => {
                  closeConfirmation();
                  void perform('all');
                }}
              >
                确认清除全部数据
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

async function recoverSafely(recover: (() => void | Promise<void>) | undefined): Promise<void> {
  try {
    await recover?.();
  } catch {
    // The visible operation stays failed even when authoritative recovery also fails.
  }
}
