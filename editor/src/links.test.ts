import { describe, expect, it } from 'vitest';
import { firstUrl, shortUrl } from './links';

describe('firstUrl', () => {
  it('finds the link inside a share text', () => {
    expect(firstUrl('Check out this video! https://vm.tiktok.com/ZMabc123/ #fyp')).toBe('https://vm.tiktok.com/ZMabc123/');
  });

  it('drops punctuation after the link', () => {
    expect(firstUrl('(https://youtu.be/xyz).')).toBe('https://youtu.be/xyz');
  });

  it('returns null without a link', () => {
    expect(firstUrl('tiktok video')).toBeNull();
  });
});

describe('shortUrl', () => {
  it('drops the scheme and www, and cuts long links', () => {
    expect(shortUrl('https://www.reddit.com/r/cats')).toBe('reddit.com/r/cats');
    expect(shortUrl('https://vm.tiktok.com/ZMabcdefghijklmnopqrstuvwxyz0123456789/')).toHaveLength(40);
  });
});
