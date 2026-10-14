import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './bridge';
import { ClipEditor } from './ClipEditor';
import { isVideo, mayBeAnimated, openAnimatedImage, openVideo, type Clip } from './clip';
import { Cutout } from './cutout';
import { kb } from './encode';
import { PhotoEditor } from './PhotoEditor';
import type { Status } from './types';

type Media = { kind: 'photo'; cutout: Cutout; id: number } | { kind: 'clip'; clip: Clip; id: number };

let nextMediaId = 1;

function dispose(media: Media | null) {
  if (media?.kind === 'photo') media.cutout.dispose();
  if (media?.kind === 'clip') media.clip.dispose();
}

export function App() {
  const [media, setMedia] = useState<Media | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (blob: Blob, mime: string, name = '') => {
    setStatus({ kind: 'info', text: 'Opening…' });
    try {
      let next: Media;
      const clip = isVideo(mime, name)
        ? await openVideo(blob)
        : mayBeAnimated(mime)
          ? await openAnimatedImage(blob, mime)
          : null;
      if (clip) {
        next = { kind: 'clip', clip, id: nextMediaId++ };
      } else {
        const bitmap = await createImageBitmap(blob);
        next = { kind: 'photo', cutout: Cutout.fromImage(bitmap), id: nextMediaId++ };
        bitmap.close();
      }
      setMedia((prev) => {
        dispose(prev);
        return next;
      });
      setStatus(null);
    } catch (err) {
      const text = err instanceof Error && err.message ? err.message : 'Could not open this file.';
      setStatus({ kind: 'error', text });
    }
  }, []);

  useEffect(() => {
    bridge.connect({
      onOpening() {
        setStatus({ kind: 'info', text: 'Opening…' });
      },
      async onSharedFile(file) {
        const res = await fetch(file.url);
        const blob = await res.blob();
        await load(blob, file.mime || blob.type);
      },
      onAddResult(result) {
        setBusy(false);
        setStatus({ kind: result.ok ? 'ok' : 'error', text: result.message });
      },
    });
  }, [load]);

  const pick = () => {
    if (!bridge.pickFile()) fileInput.current?.click();
  };

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void load(file, file.type, file.name);
  };

  const onAdd = async (webp: Blob, animated: boolean) => {
    setBusy(true);
    setStatus({ kind: 'info', text: `The sticker is ${kb(webp.size)}. Opening WhatsApp…` });
    try {
      await bridge.addSticker(webp, animated);
    } catch (err) {
      setBusy(false);
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const editorProps = { busy, setStatus, onAdd };

  return (
    <main className="app">
      <header className="top">
        <h1>Sticker Bridge</h1>
        {media && (
          <button className="ghost" onClick={pick} disabled={busy}>
            Pick another
          </button>
        )}
      </header>

      <input ref={fileInput} type="file" accept="image/*,video/*" hidden onChange={onPicked} />

      {!media && (
        <section className="empty">
          <p>Share a photo, GIF, or video to Sticker Bridge from your gallery, or pick one here.</p>
          <button className="primary" onClick={pick}>
            Pick a file
          </button>
        </section>
      )}
      {media?.kind === 'photo' && <PhotoEditor key={media.id} cutout={media.cutout} {...editorProps} />}
      {media?.kind === 'clip' && <ClipEditor key={media.id} clip={media.clip} {...editorProps} />}

      {status && <p className={`status ${status.kind}`}>{status.text}</p>}
    </main>
  );
}
