/**
 * How far a task is, from its status text, from 0 to 1. Long tasks already say "frame 9 of 24" or "45%".
 * Returns null when the text has no count.
 */
export function progressOf(text: string): number | null {
  // A percentage goes first: a download says "part 1 of 2: 40%", and the bar shows the part's progress.
  const percent = /(\d+(?:\.\d+)?)%/.exec(text);
  if (percent) return Math.min(1, Number(percent[1]) / 100);
  const of = /(\d+) of (\d+)/.exec(text);
  if (!of) return null;
  const total = Number(of[2]);
  return total > 0 ? Math.min(1, Number(of[1]) / total) : null;
}
