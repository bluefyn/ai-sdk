import { CHAT_MODEL, FakeAPIPromise, FakeOpenAI, FakeOpenAIError, FakeResponseStream, FakeStream } from './__fixtures__/openai-fakes';
import { captureClient, drain, readJsonLines, recordingDouble } from './__fixtures__/capture';
import { withContext } from './attribution';
import { AiSpendAttributionError } from './errors';
import { aiSpendOptions, openAIProviderOf, wrapOpenAI } from './openai';

const ZERO_USAGE = { input_tokens: 0, cached_input_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
const CHAT_EXPECTED = { input_tokens: 200, cached_input_tokens: 800, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 300, reasoning_tokens: 120 };
const RESPONSES_EXPECTED = { input_tokens: 904, cached_input_tokens: 4096, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 700, reasoning_tokens: 500 };
const CHAT_BODY = { model: 'gpt-5', messages: [{ role: 'user', content: 'Hi' }] };

type Chunk = { choices: unknown[]; usage?: unknown };

function setup(fake = new FakeOpenAI(), clientOptions: Parameters<typeof captureClient>[0] = {}) {
  const captured = captureClient(clientOptions);
  const openai = wrapOpenAI(fake, captured.client);

  return { ...captured, fake, openai };
}

describe('wrapOpenAI — chat completions', () => {
  it('records a non-streaming completion (cached tokens split out) and returns the SDK object itself', async () => {
    const { fake, openai, flushed } = setup();

    const completion = await openai.chat.completions.create(CHAT_BODY, aiSpendOptions({ customer: 'cus_1', feature: 'chat' }));

    expect(completion).toBe(fake.produced[0]);
    expect(fake.requests[0].body).toBe(CHAT_BODY);

    const events = await flushed();

    expect(events).toEqual([
      expect.objectContaining({ provider: 'openai', model: CHAT_MODEL, status: 'success', service_tier: 'flex', customer: 'cus_1', feature: 'chat', usage: CHAT_EXPECTED, sdk: expect.objectContaining({ adapter: 'openai' }) }),
    ]);
  });

  it('keeps the APIPromise lazy: nothing is parsed before the caller awaits, and asResponse() still works', async () => {
    const { openai, flushed } = setup();

    const pending = openai.chat.completions.create(CHAT_BODY) as unknown as FakeAPIPromise<unknown>;

    expect(pending.parseCount).toBe(0);
    expect(pending).toBeInstanceOf(FakeAPIPromise);
    expect((await pending.asResponse()).status).toBe(200);
    expect(await flushed()).toHaveLength(0);

    await pending;
    await pending;

    expect(pending.parseCount).toBe(1);
    expect(await flushed()).toHaveLength(1);
  });

  it('records once across then + withResponse, and withResponse returns the same data', async () => {
    const { fake, openai, flushed } = setup();
    const pending = openai.chat.completions.create(CHAT_BODY);

    const { data, request_id } = await pending.withResponse();

    expect(data).toBe(fake.produced[0]);
    expect(request_id).toBe('req_1');
    expect(await pending).toBe(data);
    expect(await flushed()).toHaveLength(1);
  });

  it('injects include_usage on a stream, hides the usage-only chunk, and records the usage', async () => {
    const { fake, openai, flushed } = setup();
    const body = { ...CHAT_BODY, stream: true as const };

    const stream = await openai.chat.completions.create(body);
    const chunks = (await drain(stream)) as Chunk[];

    expect(stream).toBe(fake.produced[0]);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.choices.length > 0)).toBe(true);
    expect(fake.requests[0].body).toEqual({ ...body, stream_options: { include_usage: true } });
    expect(body).toEqual({ ...CHAT_BODY, stream: true });

    const events = await flushed();

    expect(events).toEqual([expect.objectContaining({ status: 'success', model: CHAT_MODEL, service_tier: 'default', usage: CHAT_EXPECTED })]);
  });

  it('keeps the usage chunk (and the body object) when the caller asked for include_usage', async () => {
    const { fake, openai, flushed } = setup();
    const body = { ...CHAT_BODY, stream: true as const, stream_options: { include_usage: true } };

    const chunks = (await drain(await openai.chat.completions.create(body))) as Chunk[];

    expect(fake.requests[0].body).toBe(body);
    expect(chunks).toHaveLength(4);
    expect(chunks[3].usage).toEqual(expect.objectContaining({ prompt_tokens: 1000 }));
    expect(await flushed()).toEqual([expect.objectContaining({ usage: CHAT_EXPECTED })]);
  });

  it('respects include_usage: false (no injection; recorded without token counts)', async () => {
    const { fake, openai, flushed } = setup();
    const body = { ...CHAT_BODY, stream: true as const, stream_options: { include_usage: false } };

    await drain(await openai.chat.completions.create(body));

    expect(fake.requests[0].body).toBe(body);
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'success', usage: ZERO_USAGE })]);
  });

  it('hides the usage chunk from toReadableStream() and from both tee() branches, recording once', async () => {
    const { openai, flushed } = setup();

    const viaReadable = await readJsonLines((await openai.chat.completions.create({ ...CHAT_BODY, stream: true })).toReadableStream());

    expect(viaReadable).toHaveLength(3);

    const [left, right] = (await openai.chat.completions.create({ ...CHAT_BODY, stream: true })).tee();
    const [a, b] = await Promise.all([drain(left), drain(right)]);

    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(await flushed()).toEqual([expect.objectContaining({ usage: CHAT_EXPECTED }), expect.objectContaining({ usage: CHAT_EXPECTED })]);
  });

  it('records an early break as aborted (usage arrives only at the end)', async () => {
    const { openai, flushed } = setup();
    const stream = await openai.chat.completions.create({ ...CHAT_BODY, stream: true });

    for await (const chunk of stream) {
      expect(chunk).toBeDefined();
      break;
    }

    expect(stream.controller.signal.aborted).toBe(true);
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'aborted', model: CHAT_MODEL, usage: ZERO_USAGE })]);
  });

  it('records controller.abort() mid-stream as aborted', async () => {
    const { openai, flushed } = setup();
    const stream = await openai.chat.completions.create({ ...CHAT_BODY, stream: true });
    let seen = 0;

    for await (const chunk of stream) {
      expect(chunk).toBeDefined();
      seen++;
      stream.controller.abort();
    }

    expect(seen).toBe(1);
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'aborted' })]);
  });

  it('records a mid-stream error as error and re-throws the same error', async () => {
    const { openai, flushed } = setup(new FakeOpenAI({}, { streamErrorAt: 2 }));
    const stream = await openai.chat.completions.create({ ...CHAT_BODY, stream: true });

    const error = await drain(stream).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FakeOpenAIError);
    expect((error as FakeOpenAIError).message).toBe('stream broke');
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'error' })]);
  });

  it('records an API error as a zero-token error with the requested model and re-throws it untouched', async () => {
    const failure = new FakeOpenAIError('rate limited', 429);
    const { openai, flushed } = setup(new FakeOpenAI({}, { fail: failure }));

    await expect(openai.chat.completions.create(CHAT_BODY)).rejects.toBe(failure);
    await expect(openai.chat.completions.create(CHAT_BODY).catch((e: unknown) => e)).resolves.toBe(failure);
    await expect(openai.chat.completions.create(CHAT_BODY).finally(() => undefined)).rejects.toBe(failure);

    const events = await flushed();

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(expect.objectContaining({ status: 'error', model: 'gpt-5', usage: ZERO_USAGE }));
  });

  it('records chat.completions.parse once (the SDK helper calls the raw client internally)', async () => {
    const { openai, flushed } = setup();

    const parsed = await openai.chat.completions.parse(CHAT_BODY);

    expect(parsed).toEqual(expect.objectContaining({ parsed: true }));
    expect(await flushed()).toEqual([expect.objectContaining({ usage: CHAT_EXPECTED })]);
  });
});

describe('wrapOpenAI — Responses API', () => {
  it('records a non-streaming response', async () => {
    const { fake, openai, flushed } = setup();

    const response = await openai.responses.create({ model: 'gpt-5', input: 'Hi' });

    expect(response).toBe(fake.produced[0]);
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'success', service_tier: 'priority', usage: RESPONSES_EXPECTED })]);
  });

  it.each([
    ['incomplete', 'success'],
    ['failed', 'error'],
    ['cancelled', 'aborted'],
  ])('maps a %s response to %s', async (responsesStatus, status) => {
    const { openai, flushed } = setup(new FakeOpenAI({}, { responsesStatus }));

    await openai.responses.create({ model: 'gpt-5', input: 'Hi' });

    expect(await flushed()).toEqual([expect.objectContaining({ status })]);
  });

  it('does not record background responses (billed when they finish)', async () => {
    const { openai, flushed } = setup(new FakeOpenAI(), { strict: true });

    await openai.responses.create({ model: 'gpt-5', input: 'Hi', background: true });

    expect(await flushed()).toHaveLength(0);
  });

  it('records a stream: true response from its terminal event', async () => {
    const { openai, flushed } = setup();

    const events = await drain(await openai.responses.create({ model: 'gpt-5', input: 'Hi', stream: true }));

    expect(events).toHaveLength(3);
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'success', model: 'gpt-5-2026-08-07', usage: RESPONSES_EXPECTED })]);
  });

  it('records a response.failed stream as error', async () => {
    const { openai, flushed } = setup(new FakeOpenAI({}, { responsesTerminal: 'response.failed' }));

    await drain(await openai.responses.create({ model: 'gpt-5', input: 'Hi', stream: true }));

    expect(await flushed()).toEqual([expect.objectContaining({ status: 'error', usage: RESPONSES_EXPECTED })]);
  });

  it('records responses.stream() on end, returning the SDK ResponseStream itself', async () => {
    const { fake, openai, flushed } = setup();

    const stream = openai.responses.stream({ model: 'gpt-5', input: 'Hi' }, aiSpendOptions({ customer: 'cus_3' }, { timeout: 1_000 }));

    expect(stream).toBe(fake.produced[0]);
    expect(stream).toBeInstanceOf(FakeResponseStream);
    expect(fake.requests[0].options).toEqual({ timeout: 1_000 });
    expect(await stream.finalResponse()).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(await flushed()).toEqual([expect.objectContaining({ status: 'success', customer: 'cus_3', usage: RESPONSES_EXPECTED })]);
  });

  it('records an aborted responses.stream() as aborted', async () => {
    const { openai, flushed } = setup();
    const stream = openai.responses.stream({ model: 'gpt-5', input: 'Hi' });

    stream.abort();
    await expect(stream.done()).rejects.toBeDefined();

    expect(await flushed()).toEqual([expect.objectContaining({ status: 'aborted', model: 'gpt-5' })]);
  });

  it('passes responses.stream({ response_id }) replays through without recording', async () => {
    const { openai, flushed } = setup();

    await openai.responses.stream({ response_id: 'resp_1' }).done();

    expect(await flushed()).toHaveLength(0);
  });

  it('records responses.parse once', async () => {
    const { openai, flushed } = setup();

    await openai.responses.parse({ model: 'gpt-5', input: 'Hi' });

    expect(await flushed()).toHaveLength(1);
  });

  it('counts built-in web_search / file_search calls as tool requests (not code interpreter) — non-streaming and streaming', async () => {
    const output = [{ type: 'web_search_call', id: 'ws_1' }, { type: 'web_search_call', id: 'ws_2' }, { type: 'file_search_call', id: 'fs_1' }, { type: 'code_interpreter_call', id: 'ci_1' }];
    const { openai, flushed } = setup(new FakeOpenAI({}, { responsesOutput: output }));

    await openai.responses.create({ model: 'gpt-5', input: 'Hi', tools: [{ type: 'web_search' }] });
    await drain(await openai.responses.create({ model: 'gpt-5', input: 'Hi', stream: true }));

    const events = await flushed();

    expect(events.map((e) => e.usage?.tool_requests)).toEqual([
      { web_search: 2, file_search: 1 },
      { web_search: 2, file_search: 1 },
    ]);
  });

  it('counts built-in tool calls once from the terminal response of a stream — create(stream), stream() helper and an incomplete response', async () => {
    const output = [{ type: 'web_search_call', id: 'ws_1' }, { type: 'file_search_call', id: 'fs_1' }, { type: 'file_search_call', id: 'fs_2' }];
    const { openai, flushed } = setup(new FakeOpenAI({}, { responsesOutput: output }));
    const incomplete = setup(new FakeOpenAI({}, { responsesOutput: output, responsesTerminal: 'response.incomplete' }));

    // The stream also announces every item mid-stream (`response.output_item.done`): those are never counted on top.
    await drain(await openai.responses.create({ model: 'gpt-5', input: 'Hi', stream: true }));
    await openai.responses.stream({ model: 'gpt-5', input: 'Hi' }).done();
    await drain(await incomplete.openai.responses.create({ model: 'gpt-5', input: 'Hi', stream: true }));

    expect([...(await flushed()), ...(await incomplete.flushed())].map((e) => e.usage?.tool_requests)).toEqual([
      { web_search: 1, file_search: 2 },
      { web_search: 1, file_search: 2 },
      { web_search: 1, file_search: 2 },
    ]);
  });

  it('never counts code interpreter calls (billed per container session, not per call)', async () => {
    const output = [{ type: 'code_interpreter_call', id: 'ci_1' }, { type: 'code_interpreter_call', id: 'ci_2' }];
    const { openai, flushed } = setup(new FakeOpenAI({}, { responsesOutput: output }));

    await openai.responses.create({ model: 'gpt-5', input: 'Hi', tools: [{ type: 'code_interpreter' }] });
    await drain(await openai.responses.create({ model: 'gpt-5', input: 'Hi', stream: true }));

    expect((await flushed()).map((e) => e.usage?.tool_requests)).toEqual([undefined, undefined]);
  });

  it('counts one web search per Chat Completions search-model call', async () => {
    const { openai, flushed } = setup();

    await openai.chat.completions.create({ ...CHAT_BODY, model: 'gpt-4o-search-preview' });
    await openai.chat.completions.create(CHAT_BODY);

    expect((await flushed()).map((e) => e.usage?.tool_requests)).toEqual([{ web_search: 1 }, undefined]);
  });
});

describe('wrapOpenAI — embeddings, provider, proxy', () => {
  it('records embeddings as input tokens', async () => {
    const { openai, flushed } = setup();

    await openai.embeddings.create({ model: 'text-embedding-3-small', input: 'hello' });

    expect(await flushed()).toEqual([expect.objectContaining({ model: 'text-embedding-3-small', usage: { ...ZERO_USAGE, input_tokens: 42 } })]);
  });

  it('records Azure OpenAI clients as azure_openai with the response model (never the deployment)', async () => {
    const { openai, flushed } = setup(new FakeOpenAI({ baseURL: 'https://acme.openai.azure.com/openai', apiVersion: '2025-04-01-preview' }));

    await openai.chat.completions.create({ ...CHAT_BODY, model: 'my-gpt5-deployment' });

    expect(await flushed()).toEqual([expect.objectContaining({ provider: 'azure_openai', model: CHAT_MODEL })]);
  });

  it('detects the provider from baseURL / apiVersion', () => {
    expect(openAIProviderOf({ baseURL: 'https://api.openai.com/v1' })).toBe('openai');
    expect(openAIProviderOf({ baseURL: 'https://acme.openai.azure.com/openai' })).toBe('azure_openai');
    expect(openAIProviderOf({ baseURL: 'https://acme.cognitiveservices.azure.com/openai' })).toBe('azure_openai');
    expect(openAIProviderOf({ baseURL: 'https://acme-foundry.services.ai.azure.com/openai/v1' })).toBe('azure_openai');
    expect(openAIProviderOf({ baseURL: 'https://gateway.example.com/openai', apiVersion: '2024-10-21' })).toBe('azure_openai');
    expect(openAIProviderOf({ baseURL: 'not a url' })).toBe('openai');
    expect(openAIProviderOf({})).toBe('openai');
  });

  it.each([
    ['https://api.groq.com/openai/v1', 'groq'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'google'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://api.together.xyz/v1', 'together'],
    ['https://api.fireworks.ai/inference/v1', 'fireworks'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['http://LOCALHOST:8000/v1', 'localhost'],
    ['https://llm-proxy.corp.example/v1', 'llm-proxy.corp.example'],
  ])('maps the OpenAI-compatible host %s to provider %s', (baseURL, provider) => {
    expect(openAIProviderOf({ baseURL })).toBe(provider);
  });

  it('records OpenAI-compatible traffic under its own provider, and honours a { provider } override (also on withOptions copies)', async () => {
    const groq = setup(new FakeOpenAI({ baseURL: 'https://api.groq.com/openai/v1' }));

    await groq.openai.chat.completions.create(CHAT_BODY);
    expect(await groq.flushed()).toEqual([expect.objectContaining({ provider: 'groq' })]);

    const captured = captureClient();
    const proxied = wrapOpenAI(new FakeOpenAI({ baseURL: 'https://litellm.internal/v1' }), captured.client, undefined, { provider: 'OpenAI' });

    await proxied.chat.completions.create(CHAT_BODY);
    await proxied.withOptions({ baseURL: 'https://other.internal/v1' }).chat.completions.create(CHAT_BODY);
    expect((await captured.flushed()).map((e) => e.provider)).toEqual(['openai', 'openai']);
  });

  it('warns ONCE per unrecognised host that its calls are recorded under the host name, unpriced — naming the { provider } override and how to price it', async () => {
    const warn = jest.fn();
    const captured = captureClient({ logger: { warn } });
    const proxied = wrapOpenAI(new FakeOpenAI({ baseURL: 'https://oai.helicone.ai/v1' }), captured.client);

    await proxied.chat.completions.create(CHAT_BODY);
    await proxied.chat.completions.create(CHAT_BODY);
    wrapOpenAI(new FakeOpenAI({ baseURL: 'https://oai.helicone.ai/v1' }), captured.client);
    await proxied.withOptions({ baseURL: 'https://litellm.internal/v1' }).chat.completions.create(CHAT_BODY);

    const hostWarnings = warn.mock.calls.map(([m]) => m as string).filter((m) => m.includes('is not a provider AI Spend knows'));

    expect((await captured.flushed()).map((e) => e.provider)).toEqual(['oai.helicone.ai', 'oai.helicone.ai', 'litellm.internal']);
    expect(hostWarnings).toHaveLength(2);
    expect(hostWarnings[0]).toContain('"oai.helicone.ai"');
    expect(hostWarnings[0]).toContain("{ provider: 'openai' }");
    expect(hostWarnings[0]).toContain('Add price');
    expect(hostWarnings[1]).toContain('"litellm.internal"');
  });

  it('does not warn about the host for known providers, an explicit { provider }, or a disabled AI Spend client', () => {
    const warn = jest.fn();
    const captured = captureClient({ logger: { warn } });

    wrapOpenAI(new FakeOpenAI({ baseURL: 'https://api.groq.com/openai/v1' }), captured.client);
    wrapOpenAI(new FakeOpenAI({ baseURL: 'https://acme.services.ai.azure.com/openai/v1' }), captured.client);
    wrapOpenAI(new FakeOpenAI({ baseURL: 'https://litellm.internal/v1' }), captured.client, undefined, { provider: 'openai' });
    wrapOpenAI(new FakeOpenAI({ baseURL: 'https://litellm.internal/v1' }), captureClient({ logger: { warn }, disabled: true }).client);

    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT inject stream_options on an AzureOpenAI client pinned before 2024-09-01: the stream works and is recorded without tokens (one warning)', async () => {
    const warn = jest.fn();
    const fake = new FakeOpenAI({ baseURL: 'https://acme.openai.azure.com/openai', apiVersion: '2024-06-01' });
    const { openai, flushed } = setup(fake, { logger: { warn } });

    for (let i = 0; i < 2; i++) {
      const stream = await openai.chat.completions.create({ ...CHAT_BODY, stream: true });

      await drain(stream);
    }

    expect(fake.requests[0].body).not.toHaveProperty('stream_options');
    const events = await flushed();

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({ provider: 'azure_openai', status: 'success', usage: ZERO_USAGE }));
    expect(warn.mock.calls.filter(([m]) => (m as string).includes('api-version'))).toHaveLength(1);
  });

  it('still injects include_usage on an AzureOpenAI client with a newer api-version', async () => {
    const fake = new FakeOpenAI({ baseURL: 'https://acme.openai.azure.com/openai', apiVersion: '2024-10-21' });
    const { openai, flushed } = setup(fake);

    await drain(await openai.chat.completions.create({ ...CHAT_BODY, stream: true }));

    expect(fake.requests[0].body).toEqual(expect.objectContaining({ stream_options: { include_usage: true } }));
    expect(await flushed()).toEqual([expect.objectContaining({ usage: CHAT_EXPECTED })]);
  });

  it('is a transparent proxy: stable members, #private methods, instanceof, untouched pass-throughs', async () => {
    const { fake, openai } = setup();

    expect(openai).toBeInstanceOf(FakeOpenAI);
    expect(openai.chat).toBe(openai.chat);
    expect(openai.chat.completions.create).toBe(openai.chat.completions.create);
    expect(openai.authHeader()).toBe('Bearer sk-test');
    expect(openai.baseURL).toBe(fake.baseURL);
    expect(openai.requests).toBe(fake.requests);
    await expect(openai.responses.retrieve('resp_9')).resolves.toEqual(expect.objectContaining({ id: 'resp_9' }));
  });

  it('re-wraps withOptions() clients and re-detects their provider', async () => {
    const { openai, flushed } = setup();

    await openai.withOptions({ baseURL: 'https://acme.openai.azure.com/openai' }).chat.completions.create(CHAT_BODY);

    expect(await flushed()).toEqual([expect.objectContaining({ provider: 'azure_openai' })]);
  });
});

describe('wrapOpenAI — attribution and options', () => {
  function precedenceSetup() {
    const captured = captureClient({ defaultCustomer: 'client-default', defaultFeature: 'client.default' });
    const openai = wrapOpenAI(new FakeOpenAI(), captured.client, { customer: 'wrap', feature: 'wrap.feature', user: 'wrap-user', tags: { a: 'wrap' } });

    return { ...captured, openai };
  }

  it('resolves per-call > withAttribution > ambient > wrap defaults > client defaults', async () => {
    const { openai, flushed } = precedenceSetup();
    const scoped = openai.withAttribution({ customer: 'scoped', entityRef: 'doc:1' });

    await withContext({ customer: 'ambient', runId: 'run-ambient', tags: { b: 'ambient' } }, async () => {
      await scoped.chat.completions.create(CHAT_BODY, aiSpendOptions({ customer: 'per-call' }));
      await scoped.chat.completions.create(CHAT_BODY);
      await openai.chat.completions.create(CHAT_BODY);
    });
    await openai.chat.completions.create(CHAT_BODY);

    const events = await flushed();

    expect(events.map((e) => e.customer)).toEqual(['per-call', 'scoped', 'ambient', 'wrap']);
    expect(events[0]).toEqual(expect.objectContaining({ feature: 'wrap.feature', user: 'wrap-user', run_id: 'run-ambient', entity_ref: 'doc:1', tags: { a: 'wrap', b: 'ambient' } }));
  });

  it('falls back to the AI Spend client defaults', async () => {
    const captured = captureClient({ defaultCustomer: 'client-default', defaultFeature: 'client.default' });

    await wrapOpenAI(new FakeOpenAI(), captured.client).chat.completions.create(CHAT_BODY);

    expect(await captured.flushed()).toEqual([expect.objectContaining({ customer: 'client-default', feature: 'client.default' })]);
  });

  it('withAttribution layers merge (inner wins) and do not leak into the parent view', async () => {
    const { openai, flushed } = setup();

    await openai.withAttribution({ customer: 'a', feature: 'x' }).withAttribution({ customer: 'b' }).chat.completions.create(CHAT_BODY);
    await openai.chat.completions.create(CHAT_BODY);

    const events = await flushed();

    expect(events[0]).toEqual(expect.objectContaining({ customer: 'b', feature: 'x' }));
    expect(events[1].customer).toBeUndefined();
  });

  it('strips the aiSpend option before the SDK sees it (and forwards untouched options by reference)', async () => {
    const { fake, openai } = setup();
    const plain = { timeout: 5 };

    await openai.chat.completions.create(CHAT_BODY, aiSpendOptions({ customer: 'c' }, { timeout: 5, maxRetries: 1 }));
    await openai.chat.completions.create(CHAT_BODY, aiSpendOptions({ customer: 'c' }));
    await openai.chat.completions.create(CHAT_BODY, plain);
    await openai.chat.completions.create(CHAT_BODY);

    expect(fake.requests.map((r) => r.options)).toEqual([{ timeout: 5, maxRetries: 1 }, {}, plain, undefined]);
    expect(fake.requests[2].options).toBe(plain);
    expect(fake.requests.map((r) => r.argCount)).toEqual([2, 2, 2, 1]);
  });

  it('strict mode throws before the request when attribution is missing', () => {
    const { fake, openai } = setup(new FakeOpenAI(), { strict: true });

    expect(() => openai.chat.completions.create(CHAT_BODY)).toThrow(AiSpendAttributionError);
    expect(() => openai.responses.stream({ model: 'gpt-5', input: 'Hi' })).toThrow(AiSpendAttributionError);
    expect(() => openai.embeddings.create({ model: 'e', input: 'x' }, aiSpendOptions({ customer: 'c', feature: 'f' }))).not.toThrow();
    expect(fake.requests.map((r) => r.method)).toEqual(['embeddings.create']);
  });
});

describe('wrapOpenAI — never in the way', () => {
  it('a disabled AI Spend client passes everything through untouched (no injection) but still strips aiSpend', async () => {
    const fake = new FakeOpenAI();
    const captured = captureClient({ disabled: true });
    const openai = wrapOpenAI(fake, captured.client);
    const body = { ...CHAT_BODY, stream: true as const };

    const chunks = await drain(await openai.chat.completions.create(body, aiSpendOptions({ customer: 'c' })));

    expect(fake.requests[0].body).toBe(body);
    expect(fake.requests[0].options).toEqual({});
    expect(chunks).toHaveLength(3);
    expect(await captured.flushed()).toHaveLength(0);
  });

  it('keeps working when record() throws — results and streams are unaffected', async () => {
    const fake = new FakeOpenAI();
    const openai = wrapOpenAI(fake, recordingDouble({ throwOnRecord: true }).client);

    const completion = await openai.chat.completions.create(CHAT_BODY);

    expect(completion).toBe(fake.produced[0]);
    await expect(drain(await openai.chat.completions.create({ ...CHAT_BODY, stream: true }))).resolves.toHaveLength(3);
    await expect(openai.responses.stream({ model: 'gpt-5', input: 'Hi' }).finalResponse()).resolves.toBeDefined();
  });

  it('works with a structural (non-SDK) AI Spend client through its public record()', async () => {
    const { client, records } = recordingDouble();

    await wrapOpenAI(new FakeOpenAI(), client, { feature: 'f' }).chat.completions.create(CHAT_BODY);

    expect(records).toEqual([expect.objectContaining({ provider: 'openai', model: CHAT_MODEL, feature: 'f', status: 'success' })]);
  });

  it('returns the client untouched when no AI Spend client is given', () => {
    const fake = new FakeOpenAI();

    expect(wrapOpenAI(fake, undefined as unknown as Parameters<typeof wrapOpenAI>[1])).toBe(fake);
  });

  it('never double-taps a stream the caller awaits twice', async () => {
    const { openai, flushed } = setup();
    const pending = openai.chat.completions.create({ ...CHAT_BODY, stream: true });
    const first = await pending;
    const second = await pending;

    expect(second).toBe(first);
    expect(first).toBeInstanceOf(FakeStream);

    await drain(first);

    expect(await flushed()).toHaveLength(1);
  });
});
