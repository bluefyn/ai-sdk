import { isUuid, uuidv7 } from './uuidv7';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The Unix-ms timestamp embedded in a UUIDv7 (its first 48 bits). */
function uuidv7Timestamp(id: string) {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

describe('uuidv7', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('produces RFC 9562 version-7 / variant-10 ids', () => {
    const id = uuidv7();

    expect(id).toMatch(V7);
    expect(isUuid(id)).toBe(true);
  });

  it('embeds exactly the explicit timestamp', () => {
    const at = Date.UTC(2026, 8, 30, 12, 0, 0);

    expect(uuidv7Timestamp(uuidv7(at))).toBe(at);
    expect(uuidv7Timestamp(uuidv7(Date.UTC(2020, 0, 1)))).toBe(Date.UTC(2020, 0, 1));
  });

  it('is strictly increasing within one millisecond, far beyond 4096 ids (26-bit counter)', () => {
    const fixed = Date.UTC(2030, 0, 1);
    const ids = Array.from({ length: 20_000 }, () => uuidv7(fixed));

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }

    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(V7));
    expect(uuidv7Timestamp(ids[ids.length - 1])).toBe(fixed);
  });

  it('keeps the process clock monotonic when Date.now() steps backwards', () => {
    const now = jest.spyOn(Date, 'now');

    now.mockReturnValue(Date.UTC(2031, 0, 1));

    const later = uuidv7();

    now.mockReturnValue(Date.UTC(2020, 0, 1));

    const earlier = uuidv7();

    expect(earlier > later).toBe(true);
  });

  it('an explicit timestamp never advances the process-wide clock', () => {
    const before = uuidv7Timestamp(uuidv7());

    uuidv7(Date.UTC(2200, 0, 1));

    const after = uuidv7Timestamp(uuidv7());

    expect(after - before).toBeLessThan(5_000);
    expect(after).toBeLessThan(Date.UTC(2200, 0, 1));
  });

  it('clamps timestamps to 48 bits', () => {
    expect(uuidv7Timestamp(uuidv7(2 ** 48 + 5))).toBe(2 ** 48 - 1);
    expect(uuidv7(2 ** 48 - 1)).toMatch(V7);
    expect(uuidv7Timestamp(uuidv7(-5))).toBe(0);
  });

  it('rejects non-uuids', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
