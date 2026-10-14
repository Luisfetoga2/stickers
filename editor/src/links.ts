/** The first web link in a text, without trailing punctuation, or null. Share texts often wrap the link in words. */
export function firstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"]+/i.exec(text);
  return match ? match[0].replace(/[).,!?\]]+$/, '') : null;
}
