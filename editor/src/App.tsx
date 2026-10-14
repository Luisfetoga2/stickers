import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './bridge';
import { Cutout } from './cutout';
import { STATIC_LIMIT, fitToLimit, kb, renderSticker, webpEncoder } from './encode';
import { Stage, type Tool } from './Stage';
import { centered, fitBox, fitScale, normalizeAngle, toSource, type Point, type Transform } from './transform';

interface Status {
  kind: 'info' | 'ok' | 'error';
  text: string;
}

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'move', label: 'Move' },
  { id: 'erase', label: 'Erase' },
  { id: 'restore', label: 'Restore' },
];

const HINTS: Record<Tool, string> = {
  move: 'Drag to move. Pinch to zoom and rotate. The checkerboard area stays see-through.',
  erase: 'One finger erases. Two fingers move and zoom.',
  restore: 'One finger paints the photo back. Two fingers move and zoom.',
};

export function App() {
  const [cutout, setCutout] = useState<Cutout | null>(null);
  const [version, setVersion] = useState(0);
  const [transform, setTransform] = useState<Transform>({ x: 256, y: 256, scale: 1, rotation: 0 });
  const [tool, setTool] = useState<Tool>('move');
  const [brushSize, setBrushSize] = useState(24);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<'add' | 'background' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const bump = () => setVersion((v) => v + 1);

  const load = useCallback(async (blob: Blob) => {
    try {
      const bitmap = await createImageBitmap(blob);
      const next = Cutout.fromImage(bitmap);
      bitmap.close();
      setCutout((prev) => {
        prev?.dispose();
        return next;
      });
      setTransform(centered(next.width, next.height));
      setTool('move');
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
        setBusy(null);
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

  /** Fits what is left of the photo, so a cutout fills the sticker. */
  const frame = (mode: 'fit' | 'fill') => {
    if (!cutout) return;
    const box = cutout.edited ? cutout.contentBounds() : null;
    setTransform(box ? fitBox(cutout.width, cutout.height, box, mode) : centered(cutout.width, cutout.height, mode));
  };

  const removeBackground = async () => {
    if (!cutout) return;
    setBusy('background');
    setStatus({ kind: 'info', text: 'Removing the background…' });
    try {
      const jpeg = await cutout.photoJpeg();
      const mask = await bridge.removeBackground(jpeg, (text) => setStatus({ kind: 'info', text }));
      const bitmap = await createImageBitmap(mask);
      cutout.applyMask(bitmap);
      bitmap.close();
      const box = cutout.contentBounds();
      if (!box) {
        cutout.undo();
        setStatus({ kind: 'error', text: 'No subject found in this photo. Use the Erase brush instead.' });
      } else {
        setTransform(fitBox(cutout.width, cutout.height, box, 'fit'));
        setStatus({ kind: 'ok', text: 'Background removed. Use Erase and Restore to fix the edges.' });
      }
      bump();
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const brushRadius = () => brushSize / transform.scale;
  const source = (p: Point) => toSource(transform, p, cutout!.width, cutout!.height);

  const onBrushStart = (p: Point) => {
    if (!cutout || tool === 'move') return;
    cutout.snapshot();
    const s = source(p);
    cutout.stroke(s, s, brushRadius(), tool);
    bump();
  };

  const onBrushMove = (from: Point, to: Point) => {
    if (!cutout || tool === 'move') return;
    cutout.stroke(source(from), source(to), brushRadius(), tool);
    bump();
  };

  const undo = () => {
    if (cutout?.undo()) bump();
  };

  const resetCutout = () => {
    if (!cutout) return;
    cutout.reset();
    bump();
    setStatus(null);
  };

  const add = async () => {
    if (!cutout) return;
    setBusy('add');
    setStatus({ kind: 'info', text: 'Making the sticker…' });
    try {
      const canvas = renderSticker(cutout.view, cutout.width, cutout.height, transform);
      const { blob } = await fitToLimit(webpEncoder(canvas), STATIC_LIMIT);
      canvas.width = 0;
      setStatus({ kind: 'info', text: `The sticker is ${kb(blob.size)}. Opening WhatsApp…` });
      await bridge.addSticker(blob, false);
    } catch (err) {
      setBusy(null);
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const fit = cutout ? fitScale(cutout.width, cutout.height) : 1;
  const zoom = Math.log2(transform.scale / fit);
  const degrees = Math.round((transform.rotation * 180) / Math.PI);

  return (
    <main className="app">
      <header className="top">
        <h1>Sticker Bridge</h1>
        {cutout && (
          <button className="ghost" onClick={pick}>
            Pick another
          </button>
        )}
      </header>

      <input ref={fileInput} type="file" accept="image/*" hidden onChange={onPicked} />

      {!cutout ? (
        <section className="empty">
          <p>Share a photo to Sticker Bridge from your gallery, or pick one here.</p>
          <button className="primary" onClick={pick}>
            Pick a photo
          </button>
        </section>
      ) : (
        <>
          <Stage
            image={cutout.view}
            width={cutout.width}
            height={cutout.height}
            version={version}
            transform={transform}
            onChange={setTransform}
            tool={tool}
            brushSize={brushSize}
            onBrushStart={onBrushStart}
            onBrushMove={onBrushMove}
          />
          <p className="hint">{HINTS[tool]}</p>

          <div className="row">
            <button className="secondary grow" onClick={removeBackground} disabled={busy !== null}>
              Remove background
            </button>
            <button className="ghost" onClick={undo} disabled={!cutout.canUndo || busy !== null}>
              Undo
            </button>
          </div>

          <div className="segmented" role="tablist">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tool === t.id}
                className={tool === t.id ? 'on' : ''}
                onClick={() => setTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <section className="controls">
            {tool === 'move' ? (
              <>
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
                    onChange={(e) =>
                      setTransform({ ...transform, rotation: (Number(e.target.value) * Math.PI) / 180 })
                    }
                  />
                </label>
                <div className="row">
                  <button className="ghost" onClick={() => frame('fit')}>
                    Fit
                  </button>
                  <button className="ghost" onClick={() => frame('fill')}>
                    Fill
                  </button>
                  <button
                    className="ghost"
                    onClick={() =>
                      setTransform({ ...transform, rotation: normalizeAngle(transform.rotation + Math.PI / 2) })
                    }
                  >
                    Turn 90°
                  </button>
                </div>
              </>
            ) : (
              <>
                <label>
                  <span>Brush {brushSize}</span>
                  <input
                    type="range"
                    min={4}
                    max={80}
                    step={1}
                    value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                  />
                </label>
                <div className="row">
                  <button className="ghost" onClick={resetCutout} disabled={!cutout.edited || busy !== null}>
                    Bring back the whole photo
                  </button>
                </div>
              </>
            )}
          </section>

          <button className="primary add" onClick={add} disabled={busy !== null}>
            {bridge.isNative ? 'Add to WhatsApp' : 'Download sticker'}
          </button>
        </>
      )}

      {status && <p className={`status ${status.kind}`}>{status.text}</p>}
    </main>
  );
}
