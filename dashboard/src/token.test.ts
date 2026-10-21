import { beforeEach, describe, expect, it } from 'vitest';
import { loadToken, looksLikeViewerToken, resolveToken, roomFromPath, saveToken, tokenFromFragment } from './token';

beforeEach(() => localStorage.clear());

describe('viewer token', () => {
  it('reads the room from the path', () => {
    expect(roomFromPath('/r/hackathon')).toBe('hackathon');
    expect(roomFromPath('/r/a%20b/extra')).toBe('a b');
    expect(roomFromPath('/')).toBe('demo');
  });

  it('reads the token from the fragment', () => {
    expect(tokenFromFragment('#v=hm_v.test.demo.1.AAAA')).toBe('hm_v.test.demo.1.AAAA');
    expect(tokenFromFragment('#other=1')).toBeNull();
    expect(tokenFromFragment('')).toBeNull();
  });

  it('checks the shape', () => {
    expect(looksLikeViewerToken('hm_v.test.demo.1.AAAA')).toBe(true);
    expect(looksLikeViewerToken('hm_a.test.nobody.1.AAAA')).toBe(false);
    expect(looksLikeViewerToken('')).toBe(false);
  });

  it('stores a fragment token and clears the address bar', () => {
    let replaced = '';
    const t = resolveToken({ pathname: '/r/demo', hash: '#v=hm_v.test.demo.1.AAAA', search: '' }, (u) => (replaced = u));
    expect(t).toBe('hm_v.test.demo.1.AAAA');
    expect(replaced).toBe('/r/demo');
    expect(loadToken('demo')).toBe('hm_v.test.demo.1.AAAA');
  });

  it('falls back to storage', () => {
    saveToken('demo', 'hm_v.test.demo.2.BBBB');
    expect(resolveToken({ pathname: '/r/demo', hash: '', search: '' }, () => {})).toBe('hm_v.test.demo.2.BBBB');
    expect(resolveToken({ pathname: '/r/other', hash: '', search: '' }, () => {})).toBeNull();
  });
});
