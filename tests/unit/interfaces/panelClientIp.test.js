import {
  rateLimitKeyForIp,
  createTrustedProxyMatcher,
  normalizeIp,
  parseTrustedProxies,
  resolveClientIp,
} from '../../../src/interfaces/http/panel/clientIp.js';

describe('normalizeIp', () => {
  it.each([
    ['::ffff:172.18.0.5', '172.18.0.5'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['203.0.113.7:51234', '203.0.113.7'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['no-es-ip', null],
    ['', null],
    [undefined, null],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });
});

describe('createTrustedProxyMatcher', () => {
  it('accepts addresses and CIDR ranges, including IPv4-mapped addresses', () => {
    const matcher = createTrustedProxyMatcher(parseTrustedProxies(' 172.18.0.0/16 , 10.0.0.5 '));

    expect(matcher.enabled).toBe(true);
    expect(matcher.isTrusted('::ffff:172.18.0.5')).toBe(true);
    expect(matcher.isTrusted('10.0.0.5')).toBe(true);
    expect(matcher.isTrusted('10.0.0.6')).toBe(false);
    expect(matcher.isTrusted('203.0.113.7')).toBe(false);
  });

  it('reports invalid entries and keeps the valid ones', () => {
    const matcher = createTrustedProxyMatcher(['basura', '10.0.0.0/40', '10.0.0.0/8/1', '192.168.1.0/24']);

    expect(matcher.invalidEntries).toEqual(['basura', '10.0.0.0/40', '10.0.0.0/8/1']);
    expect(matcher.enabled).toBe(true);
    expect(matcher.isTrusted('192.168.1.9')).toBe(true);
  });

  it('is disabled with no entries', () => {
    const matcher = createTrustedProxyMatcher(parseTrustedProxies(''));

    expect(matcher.enabled).toBe(false);
    expect(matcher.isTrusted('127.0.0.1')).toBe(false);
  });
});

describe('resolveClientIp', () => {
  const trusted = createTrustedProxyMatcher(['172.18.0.0/16']);

  it('uses the socket address and ignores X-Forwarded-For without trusted proxies', () => {
    expect(resolveClientIp({
      socketAddress: '::ffff:203.0.113.7',
      forwardedFor: '1.1.1.1',
      matcher: createTrustedProxyMatcher([]),
    })).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For when the request does not come from a trusted proxy', () => {
    expect(resolveClientIp({ socketAddress: '203.0.113.7', forwardedFor: '1.1.1.1', matcher: trusted }))
      .toBe('203.0.113.7');
  });

  it('takes the client from X-Forwarded-For behind a trusted proxy', () => {
    expect(resolveClientIp({ socketAddress: '::ffff:172.18.0.3', forwardedFor: '198.51.100.20', matcher: trusted }))
      .toBe('198.51.100.20');
  });

  it('walks right to left through trusted hops and never reads spoofed entries on the left', () => {
    expect(resolveClientIp({
      socketAddress: '172.18.0.3',
      forwardedFor: '6.6.6.6, 198.51.100.20, 172.18.0.9',
      matcher: trusted,
    })).toBe('198.51.100.20');
  });

  it('drops garbage entries and falls back to the leftmost when every hop is trusted', () => {
    expect(resolveClientIp({ socketAddress: '172.18.0.3', forwardedFor: 'basura, 172.18.0.9', matcher: trusted }))
      .toBe('172.18.0.9');
  });
});

describe('rateLimitKeyForIp', () => {
  it('keeps IPv4 as is and groups IPv6 by its /64', () => {
    expect(rateLimitKeyForIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKeyForIp('2001:db8:abcd:12::1')).toBe('2001:0db8:abcd:0012::/64');
    expect(rateLimitKeyForIp('2001:db8:abcd:12:ffff:1:2:3')).toBe('2001:0db8:abcd:0012::/64');
    expect(rateLimitKeyForIp('::1')).toBe('0000:0000:0000:0000::/64');
    expect(rateLimitKeyForIp('basura')).toBeNull();
  });
});
