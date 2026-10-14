import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Decimals in the number box. The slider step follows from it. */
  decimals: number;
  onChange(value: number): void;
  disabled?: boolean;
  /** For a slider that is not linear, such as zoom: maps a value to a slider position and back. */
  toSlider?(value: number): number;
  fromSlider?(position: number): number;
  sliderMin?: number;
  sliderMax?: number;
}

/** Reads "1,5" and "1.5" alike, for keyboards that type a comma as the decimal mark. */
export function parseNumber(text: string): number {
  return Number.parseFloat(text.trim().replace(',', '.'));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A slider plus a number box. The slider is quick, and the box is exact. */
export function SliderField(props: Props) {
  const { label, value, min, max, decimals, onChange, disabled } = props;
  const toSlider = props.toSlider ?? ((v: number) => v);
  const fromSlider = props.fromSlider ?? ((p: number) => p);
  const format = (v: number) => v.toFixed(decimals);

  const [draft, setDraft] = useState(format(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(format(value));
    // format only depends on decimals, which does not change.
  }, [value]);

  const commit = (text: string) => {
    const n = parseNumber(text);
    if (!Number.isFinite(n)) return;
    const v = clamp(n, min, max);
    onChange(v);
    return v;
  };

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="range"
        min={props.sliderMin ?? min}
        max={props.sliderMax ?? max}
        step={props.toSlider ? 0.01 : 10 ** -decimals}
        value={clamp(toSlider(value), props.sliderMin ?? min, props.sliderMax ?? max)}
        disabled={disabled}
        onChange={(e) => onChange(clamp(fromSlider(Number(e.target.value)), min, max))}
      />
      <input
        className="number"
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        onFocus={(e) => {
          editing.current = true;
          e.target.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          // Apply while typing when the number is already in range, so the stage updates live.
          const n = parseNumber(e.target.value);
          if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
        }}
        onBlur={(e) => {
          editing.current = false;
          const v = commit(e.target.value);
          setDraft(format(v ?? value));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
}
