import { useState } from 'react';
import { bridge } from './bridge';
import type { Cutout } from './cutout';
import { STATIC_LIMIT, fitToLimit, renderSticker, webpEncoder } from './encode';
import { MoveControls } from './MoveControls';
import { SliderField } from './SliderField';
import { Stage, type Tool } from './Stage';
import { centered, fitBox, toSource, type Point, type Transform } from './transform';
import type { EditorProps } from './types';

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'move', label: 'Move' },
  { id: 'erase', label: 'Erase' },
  { id: 'restore', label: 'Restore' },
];

const HINTS: Record<Tool, string> = {
  move: 'Drag to move. Pinch to zoom and rotate. The checkerboard area stays see-through.',
  erase: 'One finger erases. Two fingers move and zoom.',
  restore: 'One finger paints the photo back. Two fingers move and zoom.',
  pick: '',
  keep: '',
  remove: '',
};

export function PhotoEditor({ cutout, busy, setStatus, onAdd }: EditorProps & { cutout: Cutout }) {
  const [version, setVersion] = useState(0);
  const [transform, setTransform] = useState<Transform>(() => centered(cutout.width, cutout.height));
  const [tool, setTool] = useState<Tool>('move');
  const [brushSize, setBrushSize] = useState(24);
  const [removing, setRemoving] = useState(false);
  const locked = busy || removing;

  const bump = () => setVersion((v) => v + 1);

  /** Fits what is left of the photo, so a cutout fills the sticker. */
  const frame = (mode: 'fit' | 'fill') => {
    const box = cutout.edited ? cutout.contentBounds() : null;
    const framed = box ? fitBox(cutout.width, cutout.height, box, mode) : centered(cutout.width, cutout.height, mode);
    setTransform({ ...framed, flip: transform.flip });
  };

  const removeBackground = async () => {
    setRemoving(true);
    setStatus({ kind: 'info', text: 'Removing the background…' });
    try {
      const jpeg = await cutout.photoJpeg();
      const { mask } = await bridge.removeBackground(jpeg, (text) => setStatus({ kind: 'info', text }));
      const bitmap = await createImageBitmap(mask);
      cutout.applyMask(bitmap);
      bitmap.close();
      const box = cutout.contentBounds();
      if (!box) {
        cutout.undo();
        setStatus({ kind: 'error', text: 'No subject found in this photo. Use the Erase brush instead.' });
      } else {
        setTransform((t) => ({ ...fitBox(cutout.width, cutout.height, box, 'fit'), flip: t.flip }));
        setStatus({ kind: 'ok', text: 'Background removed. Use Erase and Restore to fix the edges.' });
      }
      bump();
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRemoving(false);
    }
  };

  const brushRadius = () => brushSize / transform.scale;
  const source = (p: Point) => toSource(transform, p, cutout.width, cutout.height);

  const onBrushStart = (p: Point) => {
    if (tool !== 'erase' && tool !== 'restore') return;
    cutout.snapshot();
    const s = source(p);
    cutout.stroke(s, s, brushRadius(), tool);
    bump();
  };

  const onBrushMove = (from: Point, to: Point) => {
    if (tool !== 'erase' && tool !== 'restore') return;
    cutout.stroke(source(from), source(to), brushRadius(), tool);
    bump();
  };

  const undo = () => {
    if (cutout.undo()) bump();
  };

  const resetCutout = () => {
    cutout.reset();
    bump();
    setStatus(null);
  };

  const add = async () => {
    setStatus({ kind: 'info', text: 'Making the sticker…' });
    try {
      const canvas = renderSticker(cutout.view, cutout.width, cutout.height, transform);
      const { blob } = await fitToLimit(webpEncoder(canvas), STATIC_LIMIT);
      canvas.width = 0;
      await onAdd(blob, false);
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
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
        <button className="secondary grow" onClick={removeBackground} disabled={locked}>
          Remove background
        </button>
        <button className="ghost" onClick={undo} disabled={!cutout.canUndo || locked}>
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
          <MoveControls
            transform={transform}
            onChange={setTransform}
            width={cutout.width}
            height={cutout.height}
            onFrame={frame}
          />
        ) : (
          <>
            <SliderField label="Brush" value={brushSize} min={4} max={80} decimals={0} onChange={setBrushSize} />
            <div className="row">
              <button className="ghost" onClick={resetCutout} disabled={!cutout.edited || locked}>
                Bring back the whole photo
              </button>
            </div>
          </>
        )}
      </section>

      <button className="primary add" onClick={add} disabled={locked}>
        {bridge.isNative ? 'Add to WhatsApp' : 'Download sticker'}
      </button>
    </>
  );
}
