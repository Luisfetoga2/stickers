/** The first web link in a text, without trailing punctuation, or null. Share texts often wrap the link in words. */
export function firstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"]+/i.exec(text);
  return match ? match[0].replace(/[).,!?\]]+$/, '') : null;
}

/** A short form of a link for a small line of text: the site and the start of the path. */
export function shortUrl(url: string, max = 40): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/i, '');
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}
