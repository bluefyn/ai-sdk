import { AI_SPEND_EVENT_ID_NAMESPACE, eventIdFrom, sha1, uuidv5 } from './event-id';

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
const ascii = (value: string) => Array.from(value, (c) => c.charCodeAt(0));

describe('event ids (UUIDv5)', () => {
  it('sha1 matches the FIPS 180 test vectors', () => {
    expect(hex(sha1([]))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(sha1(ascii('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hex(sha1(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  });

  it('uuidv5 matches the RFC / reference implementation', () => {
    // uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.com')
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    // the SDK namespace itself: uuid.uuid5(uuid.NAMESPACE_URL, 'https://bluefyn.ai/ai-spend-sdk/event-id')
    expect(uuidv5('https://bluefyn.ai/ai-spend-sdk/event-id', '6ba7b811-9dad-11d1-80b4-00c04fd430c8')).toBe(AI_SPEND_EVENT_ID_NAMESPACE);
  });

  it('eventIdFrom is deterministic, UTF-8 aware, and keeps a UUID as is', () => {
    expect(eventIdFrom('job-42:step-1')).toBe('2c08801a-e213-597e-b15e-f5fae74122b3');
    expect(eventIdFrom('job-42:step-1')).toBe(eventIdFrom('job-42:step-1'));
    expect(eventIdFrom('job-42:step-2')).not.toBe(eventIdFrom('job-42:step-1'));
    expect(eventIdFrom('café 🚀')).toBe('a94ea95a-fc83-5de8-8c0f-75ffccb71e74');
    expect(eventIdFrom('0192F3A0-7B7C-7D5E-8F00-0123456789AB')).toBe('0192f3a0-7b7c-7d5e-8f00-0123456789ab');
  });
});
