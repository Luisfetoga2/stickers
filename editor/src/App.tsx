import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './bridge';
import { STATIC_LIMIT, fitToLimit, kb, renderSticker, webpEncoder } from './encode';
import { Stage } from './Stage';
import { centered, fitScale, normalizeAngle, type Transform } from './transform';

interface Source {
  image: ImageBitmap;
  width: number;
  height: number;
}

interface Status {
  kind: 'info' | 'ok' | 'error';
  text: string;
}

export function App() {
  const [source, setSource] = useState<Source | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 256, y: 256, scale: 1, rotation: 0 });
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (blob: Blob) => {
    try {
      const image = await createImageBitmap(blob);
      setSource((prev) => {
        prev?.image.close();
        return { image, width: image.width, height: image.height };
      });
      setTransform(centered(image.width, image.height));
      setStatus(null);
    } catch {
      setStatus({ kind: 'error', text: 'Could not open this file. Pick a photo or a GIF.' });
    }
  }, []);

  useEffect(() => {
    bridge.connect({
      async onSharedFile(file) {
        if (!file.mime.startsWith('image/')) {
          setStatus({ kind: 'error', text: 'Only photos and GIFs work for now. Video comes in a later version.' });
          return;
        }
        const res = await fetch(file.url);
        await load(await res.blob());
      },
      onAddResult(result) {
        setBusy(false);
        setStatus({ kind: result.ok ? 'ok' : 'error', text: result.message });
      },
    });
  }, [load]);

  const pick = () => fileInput.current?.click();

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void load(file);
  };

  const add = async () => {
    if (!source) return;
    setBusy(true);
    setStatus({ kind: 'info', text: 'Making the sticker…' });
    try {
      const canvas = renderSticker(source.image, source.width, source.height, transform);
      const { blob } = await fitToLimit(webpEncoder(canvas), STATIC_LIMIT);
      setStatus({ kind: 'info', text: `The sticker is ${kb(blob.size)}. Opening WhatsApp…` });
      await bridge.addSticker(blob, false);
    } catch (err) {
      setBusy(false);
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const fit = source ? fitScale(source.width, source.height) : 1;
  const zoom = Math.log2(transform.scale / fit);
  const degrees = Math.round((transform.rotation * 180) / Math.PI);

  return (
    <main className="app">
      <header className="top">
        <h1>Sticker Bridge</h1>
        {source && (
          <button className="ghost" onClick={pick}>
            Pick another
          </button>
        )}
      </header>

      <input ref={fileInput} type="file" accept="image/*" hidden onChange={onPicked} />

      {!source ? (
        <section className="empty">
          <p>Share a photo to Sticker Bridge from your gallery, or pick one here.</p>
          <button className="primary" onClick={pick}>
            Pick a photo
          </button>
        </section>
      ) : (
        <>
          <Stage
            image={source.image}
            width={source.width}
            height={source.height}
            transform={transform}
            onChange={setTransform}
          />
          <p className="hint">Drag to move. Pinch to zoom and rotate. The checkerboard area stays see-through.</p>

          <section className="controls">
            <label>
              <span>Zoom</span>
              <input
                type="range"
                min={-2}
                max={3}
                step={0.01}
                value={Math.min(3, Math.max(-2, zoom))}
                onChange={(e) => setTransform({ ...transform, scale: fit * 2 ** Number(e.target.value) })}
              />
            </label>
            <label>
              <span>Rotate {degrees}°</span>
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={degrees}
                onChange={(e) => setTransform({ ...transform, rotation: (Number(e.target.value) * Math.PI) / 180 })}
              />
            </label>
            <div className="row">
              <button className="ghost" onClick={() => setTransform(centered(source.width, source.height, 'fit'))}>
                Fit
              </button>
              <button className="ghost" onClick={() => setTransform(centered(source.width, source.height, 'fill'))}>
                Fill
              </button>
              <button
                className="ghost"
                onClick={() => setTransform({ ...transform, rotation: normalizeAngle(transform.rotation + Math.PI / 2) })}
              >
                Turn 90°
              </button>
            </div>
          </section>

          <button className="primary add" onClick={add} disabled={busy}>
            {bridge.isNative ? 'Add to WhatsApp' : 'Download sticker'}
          </button>
        </>
      )}

      {status && <p className={`status ${status.kind}`}>{status.text}</p>}
    </main>
  );
}
