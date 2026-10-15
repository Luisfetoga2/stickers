import { progressOf } from './progress';
import type { Status } from './types';

/**
 * The status of the editor, shown right below the stage. While a task runs, it shows a progress bar
 * and Cancel over the stage instead, where the user just worked.
 */
export function StatusLine({ status, working, onCancel }: { status: Status | null; working: boolean; onCancel?: () => void }) {
  if (working) {
    const text = status?.text ?? 'Working…';
    const progress = status?.kind === 'info' ? progressOf(text) : null;
    return (
      <div className="stage-overlay" role="status">
        {progress !== null && (
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <div className="status-row">
          <p className="status">{text}</p>
          {onCancel && (
            <button className="ghost small" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!status) return null;
  return (
    <p className={`status clamp ${status.kind}`} role="status">
      {status.text}
    </p>
  );
}
