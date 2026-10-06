/**
 * Drives `wrapAnthropic` with the REAL `@anthropic-ai/sdk` dev dependency (0.77),
 * talking to a canned `fetch` (JSON and SSE bodies shaped like the Messages API), so the
 * APIPromise / Stream / MessageStream behaviour under the wrapper is the SDK's own.
 */
import Anthropic from '@anthropic-ai/sdk';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';

import { captureClient, drain, readJsonLines, recordingDouble } from './__fixtures__/capture';
import { anthropicProviderOf, aiSpendOptions, wrapAnthropic } from './anthropic';
import { withContext } from './attribution';
import { AiSpendAttributionError } from './errors';

const MODEL = 'claude-opus-5-5-20260901';

const RAW_USAGE = {
  input_tokens: 2095,
  cache_creation_input_tokens: 2051,
  cache_read_input_tokens: 12304,
  cache_creation: { ephemeral_5m_input_tokens: 1024, ephemeral_1h_input_tokens: 1027 },
  output_tokens: 503,
  server_tool_use: { web_search_requests: 2 },
  service_tier: 'priority',
};

const EXPECTED_USAGE = {
  input_tokens: 2095,
  cached_input_tokens: 12304,
  cache_write_5m_tokens: 1024,
  cache_write_1h_tokens: 1027,
  output_tokens: 503,
  reasoning_tokens: 0,
  tool_requests: { web_search: 2 },
};

const MESSAGE = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'text', text: 'Hello' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: RAW_USAGE,
};

function streamEvents(options: { failAfterStart?: boolean } = {}) {
  const start = {
    type: 'message_start',
    message: { ...MESSAGE, content: [], stop_reason: null, usage: { ...RAW_USAGE, output_tokens: 1, server_tool_use: null } },
  };
  const rest = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 503, input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: { web_search_requests: 2 } },
    },
    { type: 'message_stop' },
  ];

  if (options.failAfterStart) {
    return [start, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }];
  }

  return [start, ...rest];
}

function sse(events: Array<{ type: string }>) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

interface CannedResponse {
  status?: number;
  json?: unknown;
  sse?: string;
}

function anthropicWith(respond: (body: Record<string, unknown>) => CannedResponse, clientOptions: { baseURL?: string } = {}) {
  const requests: Array<Record<string, unknown>> = [];

  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    requests.push(body);

    const canned = respond(body);

    if (canned.sse !== undefined) {
      return new Response(canned.sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stream' } });
    }

    return new Response(JSON.stringify(canned.json), {
      status: canned.status ?? 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
    });
  };

  const anthropic = new Anthropic({ apiKey: 'sk-ant-test', fetch, maxRetries: 0, ...clientOptions });

  return { anthropic, requests };
}

const BODY = { model: 'claude-opus-5-5', max_tokens: 1024, messages: [{ role: 'user' as const, content: 'Hi' }] };

describe('wrapAnthropic × @anthropic-ai/sdk (real client, canned fetch)', () => {
  it('records ONE event for a non-streaming create, with the cache split, tier, response model and latency', async () => {
    const { client, flushed } = captureClient();
    const { anthropic, requests } = anthropicWith(() => ({ json: MESSAGE }));
    const wrapped = wrapAnthropic(anthropic, client, { feature: 'support.reply' });

    const message = await wrapped.messages.create(BODY, aiSpendOptions({ customer: 'cus_1' }));

    expect(message).toEqual(expect.objectContaining({ id: 'msg_01', usage: RAW_USAGE }));
    expect(requests).toEqual([BODY]);

    const events = await flushed();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        model: MODEL,
        status: 'success',
        service_tier: 'priority',
        customer: 'cus_1',
        feature: 'support.reply',
        usage: EXPECTED_USAGE,
        sdk: expect.objectContaining({ adapter: 'anthropic' }),
      }),
    );
    expect(events[0].latency_ms).toEqual(expect.any(Number));
  });

  it('records a fast-mode call (usage.speed = fast) with service tier "fast" — streaming too', async () => {
    const { client, flushed } = captureClient();
    const fastUsage = { ...RAW_USAGE, service_tier: 'standard', speed: 'fast' };
    const { anthropic } = anthropicWith((body) =>
      body['stream'] === true
        ? { sse: sse(streamEvents().map((e) => (e.type === 'message_start' ? { ...e, message: { ...MESSAGE, content: [], usage: { ...fastUsage, output_tokens: 1 } } } : e))) }
        : { json: { ...MESSAGE, usage: fastUsage } },
    );
    const wrapped = wrapAnthropic(anthropic, client);

    await wrapped.messages.create(BODY);
    await drain(await wrapped.messages.create({ ...BODY, stream: true }));

    expect((await flushed()).map((e) => e.service_tier)).toEqual(['fast', 'fast']);
  });

  it('keeps withResponse() and asResponse() working (asResponse reads the body itself: nothing is recorded)', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ json: MESSAGE }));
    const wrapped = wrapAnthropic(anthropic, client);

    const { data, request_id } = await wrapped.messages.create(BODY).withResponse();

    expect(data.id).toBe('msg_01');
    expect(request_id).toBe('req_1');

    const raw = await wrapped.messages.create(BODY).asResponse();

    expect(await raw.json()).toEqual(MESSAGE);
    expect(await flushed()).toHaveLength(1);
  });

  it('records a stream: true create once, from message_start + the cumulative message_delta', async () => {
    const { client, flushed } = captureClient();
    const { anthropic, requests } = anthropicWith(() => ({ sse: sse(streamEvents()) }));
    const wrapped = wrapAnthropic(anthropic, client);

    const stream = await wrapped.messages.create({ ...BODY, stream: true });
    const events = await drain(stream);

    expect(events.map((e) => e.type)).toEqual(streamEvents().map((e) => e.type));
    expect(requests[0]).toEqual({ ...BODY, stream: true });

    const recorded = await flushed();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual(expect.objectContaining({ model: MODEL, status: 'success', service_tier: 'priority', usage: EXPECTED_USAGE }));
  });

  it('records an early break as aborted with the usage seen so far', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ sse: sse(streamEvents()) }));
    const wrapped = wrapAnthropic(anthropic, client);
    const stream = await wrapped.messages.create({ ...BODY, stream: true });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') break;
    }

    expect(stream.controller.signal.aborted).toBe(true);

    const [event] = await flushed();

    expect(event).toEqual(expect.objectContaining({ status: 'aborted', usage: expect.objectContaining({ input_tokens: 2095, cached_input_tokens: 12304, output_tokens: 1 }) }));
  });

  it('records a mid-stream error event as error and re-throws the SDK error', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ sse: sse(streamEvents({ failAfterStart: true })) }));
    const wrapped = wrapAnthropic(anthropic, client);
    const stream = await wrapped.messages.create({ ...BODY, stream: true });

    await expect(drain(stream)).rejects.toBeInstanceOf(Anthropic.APIError);

    const [event] = await flushed();

    expect(event).toEqual(expect.objectContaining({ status: 'error', usage: expect.objectContaining({ input_tokens: 2095, output_tokens: 1 }) }));
  });

  it('records a stream consumed through toReadableStream()', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ sse: sse(streamEvents()) }));
    const wrapped = wrapAnthropic(anthropic, client);
    const stream = await wrapped.messages.create({ ...BODY, stream: true });

    const items = await readJsonLines(stream.toReadableStream() as unknown as ReadableStream<Uint8Array>);

    expect(items).toHaveLength(streamEvents().length);
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'success', usage: EXPECTED_USAGE })]);
  });

  it('records messages.stream() on end without consuming it, and returns the SDK MessageStream itself', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ sse: sse(streamEvents()) }));
    const wrapped = wrapAnthropic(anthropic, client);
    let text = '';

    const stream = wrapped.messages.stream(BODY, aiSpendOptions({ customer: 'cus_2', feature: 'chat' })).on('text', (delta) => {
      text += delta;
    });

    expect(stream).toBeInstanceOf(MessageStream);

    const final = await stream.finalMessage();

    expect(text).toBe('Hello');
    expect(final.usage.output_tokens).toBe(503);

    const events = await flushed();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ status: 'success', customer: 'cus_2', feature: 'chat', usage: EXPECTED_USAGE, model: MODEL }));
  });

  it('records an aborted messages.stream() as aborted', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ sse: sse(streamEvents()) }));
    const wrapped = wrapAnthropic(anthropic, client);
    const stream = wrapped.messages.stream(BODY);

    stream.abort();
    await expect(stream.done()).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);

    const events = await flushed();

    expect(events).toEqual([expect.objectContaining({ status: 'aborted', model: 'claude-opus-5-5' })]);
  });

  it('records an API error as a zero-token error event and re-throws the SDK error untouched', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } }));
    const wrapped = wrapAnthropic(anthropic, client);

    const error = await wrapped.messages.create(BODY).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Anthropic.BadRequestError);
    expect((error as InstanceType<typeof Anthropic.BadRequestError>).status).toBe(400);

    const events = await flushed();

    expect(events).toEqual([
      expect.objectContaining({
        status: 'error',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
      }),
    ]);
  });

  it('records a synchronous SDK throw (non-streaming guard) and re-throws it', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ json: MESSAGE }));
    const wrapped = wrapAnthropic(anthropic, client);

    expect(() => wrapped.messages.create({ ...BODY, max_tokens: 500_000 })).toThrow(Anthropic.AnthropicError);
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'error' })]);
  });

  it('instruments beta.messages and passes countTokens / other members through', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith((body) => ('max_tokens' in body ? { json: MESSAGE } : { json: { input_tokens: 12 } }));
    const wrapped = wrapAnthropic(anthropic, client);

    await wrapped.beta.messages.create(BODY);

    const counted = await wrapped.messages.countTokens({ model: BODY.model, messages: BODY.messages });

    expect(counted.input_tokens).toBe(12);
    expect(wrapped.messages.batches).toBe(anthropic.messages.batches);
    expect(wrapped.baseURL).toBe('https://api.anthropic.com');
    expect(await flushed()).toHaveLength(1);
  });

  it('re-wraps withOptions() clients with the same attribution', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(() => ({ json: MESSAGE }));
    const wrapped = wrapAnthropic(anthropic, client).withAttribution({ customer: 'cus_9' });

    await wrapped.withOptions({ timeout: 5_000 }).messages.create(BODY);

    expect(await flushed()).toEqual([expect.objectContaining({ customer: 'cus_9' })]);
  });

  it('strict mode fails the call before any request when attribution is missing', () => {
    const { client } = captureClient({ strict: true });
    const { anthropic, requests } = anthropicWith(() => ({ json: MESSAGE }));
    const wrapped = wrapAnthropic(anthropic, client);

    expect(() => wrapped.messages.create(BODY)).toThrow(AiSpendAttributionError);
    expect(() => wrapped.messages.stream(BODY)).toThrow(AiSpendAttributionError);
    expect(requests).toHaveLength(0);
    expect(() => withContext({ customer: 'c', feature: 'f' }, () => wrapped.messages.create(BODY))).not.toThrow();
  });

  it('never throws when the AI Spend client blows up while recording', async () => {
    const { client } = recordingDouble({ throwOnRecord: true });
    const { anthropic } = anthropicWith(() => ({ sse: sse(streamEvents()) }));
    const wrapped = wrapAnthropic(anthropic, client);

    const stream = await wrapped.messages.create({ ...BODY, stream: true });

    await expect(drain(stream)).resolves.toHaveLength(streamEvents().length);
  });
});

describe('wrapAnthropic — Bedrock / Vertex endpoint tier', () => {
  const STANDARD = { ...RAW_USAGE, service_tier: 'standard' };

  function respondWith(usage: Record<string, unknown>) {
    return (body: Record<string, unknown>): CannedResponse =>
      body['stream'] === true
        ? { sse: sse(streamEvents().map((e) => (e.type === 'message_start' ? { ...e, message: { ...MESSAGE, content: [], usage: { ...usage, output_tokens: 1 } } } : e))) }
        : { json: { ...MESSAGE, usage } };
  }

  it('Bedrock: regional for a geography profile or an in-region model id (create, stream, parse), nothing extra for the global profile', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(respondWith(STANDARD), { baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com' });
    const wrapped = wrapAnthropic(anthropic, client);

    await wrapped.messages.create({ ...BODY, model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' });
    await drain(await wrapped.messages.create({ ...BODY, model: 'apac.anthropic.claude-sonnet-4-5-20250929-v1:0', stream: true }));
    await wrapped.messages.stream({ ...BODY, model: 'anthropic.claude-sonnet-4-5-20250929-v1:0' }).done();
    await wrapped.messages.parse({ ...BODY, model: 'arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0' });
    await wrapped.messages.create({ ...BODY, model: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0' });
    await wrapped.messages.create({ ...BODY, model: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3' });

    expect((await flushed()).map((e) => [e.provider, e.service_tier])).toEqual([
      ['bedrock', 'regional'],
      ['bedrock', 'regional'],
      ['bedrock', 'regional'],
      ['bedrock', 'regional'],
      ['bedrock', 'standard'],
      ['bedrock', 'standard'],
    ]);
  });

  it('Bedrock: fast mode still records fast', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(respondWith({ ...STANDARD, speed: 'fast' }), { baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com' });
    const wrapped = wrapAnthropic(anthropic, client);

    await wrapped.messages.create({ ...BODY, model: 'us.anthropic.claude-opus-4-6-v1' });
    await drain(await wrapped.messages.create({ ...BODY, model: 'us.anthropic.claude-opus-4-6-v1', stream: true }));

    expect((await flushed()).map((e) => e.service_tier)).toEqual(['fast', 'fast']);
  });

  it('Vertex: regional unless the client region is global (region property first, else the endpoint host)', async () => {
    const { client, flushed } = captureClient();
    const regionalHost = anthropicWith(respondWith(STANDARD), { baseURL: 'https://us-east5-aiplatform.googleapis.com/v1' }).anthropic;
    const multiRegion = Object.assign(anthropicWith(respondWith(STANDARD), { baseURL: 'https://aiplatform.us.rep.googleapis.com/v1' }).anthropic, { region: 'us' });
    const globalRegion = Object.assign(anthropicWith(respondWith(STANDARD), { baseURL: 'https://aiplatform.googleapis.com/v1' }).anthropic, { region: 'global' });
    const globalHost = anthropicWith(respondWith(STANDARD), { baseURL: 'https://aiplatform.googleapis.com/v1' }).anthropic;

    for (const anthropic of [regionalHost, multiRegion, globalRegion, globalHost]) {
      await wrapAnthropic(anthropic, client).messages.create(BODY);
    }

    expect((await flushed()).map((e) => [e.provider, e.service_tier])).toEqual([
      ['google', 'regional'],
      ['google', 'regional'],
      ['google', 'standard'],
      ['google', 'standard'],
    ]);
  });

  it('a first-party Anthropic client never gets an endpoint tier, whatever the model id', async () => {
    const { client, flushed } = captureClient();
    const { anthropic } = anthropicWith(respondWith(STANDARD));

    await wrapAnthropic(anthropic, client).messages.create({ ...BODY, model: 'us.anthropic.claude-opus-5-5' });

    expect((await flushed()).map((e) => e.service_tier)).toEqual(['standard']);
  });
});

describe('anthropicProviderOf', () => {
  it('maps the Bedrock and Vertex flavours by base URL', () => {
    expect(anthropicProviderOf({ baseURL: 'https://api.anthropic.com' })).toBe('anthropic');
    expect(anthropicProviderOf({ baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com' })).toBe('bedrock');
    expect(anthropicProviderOf({ baseURL: 'https://us-east5-aiplatform.googleapis.com/v1' })).toBe('google');
    expect(anthropicProviderOf({ baseURL: 'https://aiplatform.googleapis.com/v1' })).toBe('google');
    expect(anthropicProviderOf({ baseURL: 'https://aiplatform.eu.rep.googleapis.com/v1' })).toBe('google');
    expect(anthropicProviderOf({})).toBe('anthropic');
  });
});
