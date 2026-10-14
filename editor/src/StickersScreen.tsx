import { useCallback, useEffect, useState } from 'react';
import { bridge, type SavedSticker, type StickerLibrary } from './bridge';
import type { Status } from './types';

interface Props {
  onClose(): void;
  setStatus(status: Status | null): void;
  /** Changes when WhatsApp reports back, so the list reloads. */
  refreshKey: number;
}

const keyOf = (s: SavedSticker) => `${s.packId}/${s.file}`;

/** Every sticker made in the app, with delete. Packs stay hidden: the app manages them on its own. */
export function StickersScreen({ onClose, setStatus, refreshKey }: Props) {
  const [library, setLibrary] = useState<StickerLibrary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLibrary(await bridge.listStickers());
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [setStatus]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const remove = async (sticker: SavedSticker) => {
    try {
      await bridge.deleteSticker(sticker);
      setSelected(null);
      setStatus(null);
      await reload();
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <>
      <header className="top">
        <h1>Your stickers</h1>
        <button className="ghost" onClick={onClose}>
          Done
        </button>
      </header>

      {library?.needsUpdate && (
        <section className="banner">
          <p>WhatsApp still shows your old stickers until you update it.</p>
          <button className="primary" onClick={() => bridge.updateWhatsApp()}>
            Update WhatsApp
          </button>
        </section>
      )}

      {library && library.stickers.length === 0 && <p className="hint">You have no stickers yet.</p>}

      {library && library.stickers.length > 0 && (
        <>
          <div className="grid">
            {library.stickers.map((s) => {
              const key = keyOf(s);
              const isSelected = key === selected;
              return (
                <div
                  key={key}
                  className={`tile${isSelected ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onClick={() => setSelected(isSelected ? null : key)}
                >
                  <img src={s.url} alt={s.animated ? 'Animated sticker' : 'Sticker'} loading="lazy" />
                  {s.animated && <span className="badge">GIF</span>}
                  {isSelected && (
                    <button
                      className="delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(s);
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="hint">Tap a sticker, then tap Delete.</p>
        </>
      )}
    </>
  );
}
