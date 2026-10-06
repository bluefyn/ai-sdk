/**
 * A fake `openai` client whose moving parts mirror the real SDK (openai-node 4.x–7.x, all
 * Stainless-generated): a lazily-parsing `APIPromise` subclass with `asResponse()` /
 * `withResponse()` / `_thenUnwrap()`, a `Stream` with `controller`, `tee()` and
 * `toReadableStream()` that aborts on `break` and exits quietly on `controller.abort()`,
 * and an event-emitter `ResponseStream`. Every class uses real `#private` fields, so a
 * wrapper that calls them with the wrong `this` fails here as it would against the SDK.
 * `openai` is not a dev dependency of this package; the compat check (scripts/compat-check.mjs)
 * type-checks the adapter against the real package.
 */

export class FakeOpenAIError extends Error {
  public override readonly name: string = 'APIError';

  public constructor(
    message: string,
    public readonly status: number | undefined = undefined,
  ) {
    super(message);
  }
}

export class FakeUserAbortError extends Error {
  public override readonly name: string = 'APIUserAbortError';
}

interface FakeHttpResponse {
  status: number;
  headers: Map<string, string>;
}

/** Mirrors `APIPromise`: nothing is parsed until `then` / `catch` / `finally` / `withResponse`. */
export class FakeAPIPromise<T> extends Promise<T> {
  #client: object;
  private parsed: Promise<T> | undefined;
  public parseCount = 0;

  public constructor(
    client: object,
    private readonly responsePromise: Promise<{ response: FakeHttpResponse; parse: () => T }>,
  ) {
    super((resolve) => {
      resolve(null as unknown as T);
    });
    this.#client = client;
  }

  public static resolving<T>(client: object, value: () => T) {
    return new FakeAPIPromise<T>(client, Promise.resolve({ response: { status: 200, headers: new Map([['x-request-id', 'req_1']]) }, parse: value }));
  }

  public static rejecting<T>(client: object, error: unknown) {
    const responsePromise = Promise.reject(error) as Promise<{ response: FakeHttpResponse; parse: () => T }>;

    responsePromise.catch(() => undefined);

    return new FakeAPIPromise<T>(client, responsePromise);
  }

  public _thenUnwrap<U>(transform: (data: T) => U) {
    return new FakeAPIPromise<U>(
      this.#client,
      this.responsePromise.then((props) => ({ response: props.response, parse: () => transform(props.parse()) })),
    );
  }

  public asResponse() {
    // Touching the private field proves `this` is the real instance.
    void this.#client;

    return this.responsePromise.then((props) => props.response);
  }

  public async withResponse() {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);

    return { data, response, request_id: response.headers.get('x-request-id') ?? null };
  }

  private parse() {
    if (!this.parsed) {
      this.parseCount++;
      this.parsed = this.responsePromise.then((props) => props.parse());
    }

    return this.parsed;
  }

  public override then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null) {
    return this.parse().then(onfulfilled, onrejected);
  }

  public override catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null) {
    return this.parse().catch(onrejected);
  }

  public override finally(onfinally?: (() => void) | null) {
    return this.parse().finally(onfinally);
  }
}

/** Mirrors `Stream` (SSE): consumable once, `break` aborts the request, `controller.abort()` ends it quietly. */
export class FakeStream<Item> implements AsyncIterable<Item> {
  public controller: AbortController;
  #client: object | undefined;

  public constructor(
    private readonly iterator: () => AsyncIterator<Item>,
    controller: AbortController,
    client?: object,
  ) {
    this.controller = controller;
    this.#client = client;
  }

  public static fromEvents<Item>(events: Item[], options: { errorAt?: number; error?: unknown } = {}, client?: object) {
    const controller = new AbortController();
    let consumed = false;

    async function* iterator() {
      if (consumed) {
        throw new FakeOpenAIError('Cannot iterate over a consumed stream, use `.tee()` to split the stream.');
      }

      consumed = true;

      let done = false;

      try {
        for (let i = 0; i < events.length; i++) {
          await Promise.resolve();

          if (controller.signal.aborted) return;
          if (options.errorAt === i) throw options.error;

          yield events[i];
        }

        done = true;
      } finally {
        if (!done) controller.abort();
      }
    }

    return new FakeStream<Item>(iterator, controller, client);
  }

  public [Symbol.asyncIterator]() {
    return this.iterator();
  }

  public tee(): [FakeStream<Item>, FakeStream<Item>] {
    const left: Array<Promise<IteratorResult<Item>>> = [];
    const right: Array<Promise<IteratorResult<Item>>> = [];
    const iterator = this.iterator();

    const teeIterator = (queue: Array<Promise<IteratorResult<Item>>>): AsyncIterator<Item> => ({
      next: () => {
        if (queue.length === 0) {
          const result = iterator.next();

          left.push(result);
          right.push(result);
        }

        return queue.shift() as Promise<IteratorResult<Item>>;
      },
    });

    return [new FakeStream(() => teeIterator(left), this.controller, this.#client), new FakeStream(() => teeIterator(right), this.controller, this.#client)];
  }

  public toReadableStream() {
    // The SDK reads the iterator off `self` too.
    const self = this;
    const encoder = new TextEncoder();
    let iter: AsyncIterator<Item>;

    return new ReadableStream<Uint8Array>({
      start() {
        iter = self[Symbol.asyncIterator]();
      },
      async pull(ctrl) {
        const { value, done } = await iter.next();

        if (done) {
          ctrl.close();

          return;
        }

        ctrl.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      },
      async cancel() {
        await iter.return?.();
      },
    });
  }
}

type Listener = (...args: unknown[]) => void;

/** Mirrors `ResponseStream` (an `EventStream`): runs eagerly, emits `event`… then `end` (also after error/abort). */
export class FakeResponseStream {
  public readonly controller = new AbortController();
  #listeners: Record<string, Listener[]> = {};
  #ended = false;
  #errored = false;
  #aborted = false;
  #final: unknown;
  #endPromise: Promise<void>;
  #resolveEnd: () => void = () => undefined;
  #rejectEnd: (error: unknown) => void = () => undefined;

  public constructor() {
    this.#endPromise = new Promise<void>((resolve, reject) => {
      this.#resolveEnd = resolve;
      this.#rejectEnd = reject;
    });
    this.#endPromise.catch(() => undefined);
  }

  public static create(events: Array<Record<string, unknown>>, options: { error?: unknown } = {}) {
    const runner = new FakeResponseStream();

    runner.run(async () => {
      for (const event of events) {
        await Promise.resolve();

        if (runner.controller.signal.aborted) throw new FakeUserAbortError('Request was aborted.');

        runner.emit('event', event);

        if (typeof event['type'] === 'string' && event['type'].startsWith('response.') && 'response' in event) {
          runner.#final = event['response'];
        }
      }

      if (options.error) throw options.error;
    });

    return runner;
  }

  public get ended() {
    return this.#ended;
  }

  public get errored() {
    return this.#errored;
  }

  public get aborted() {
    return this.#aborted;
  }

  public on(event: string, listener: Listener) {
    (this.#listeners[event] ??= []).push(listener);

    return this;
  }

  public abort() {
    this.controller.abort();
  }

  public async done() {
    await this.#endPromise;
  }

  public async finalResponse() {
    await this.done();

    return this.#final;
  }

  private run(executor: () => Promise<void>) {
    executor().then(
      () => this.emit('end'),
      (error: unknown) => {
        this.#errored = true;

        if (error instanceof FakeUserAbortError) {
          this.#aborted = true;
          this.emit('abort', error);

          return;
        }

        this.emit('error', error);
      },
    );
  }

  private emit(event: string, ...args: unknown[]) {
    if (this.#ended) return;

    if (event === 'end') {
      this.#ended = true;
      this.#resolveEnd();
    }

    for (const listener of this.#listeners[event] ?? []) {
      listener(...args);
    }

    if (event === 'abort' || event === 'error') {
      this.#rejectEnd(args[0]);
      this.emit('end');
    }
  }
}

// ---------------------------------------------------------------- canned API behaviour

export const CHAT_MODEL = 'gpt-5-2026-08-07';
export const CHAT_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 300,
  total_tokens: 1300,
  prompt_tokens_details: { cached_tokens: 800 },
  completion_tokens_details: { reasoning_tokens: 120 },
};
export const RESPONSES_USAGE = {
  input_tokens: 5000,
  input_tokens_details: { cached_tokens: 4096 },
  output_tokens: 700,
  output_tokens_details: { reasoning_tokens: 500 },
  total_tokens: 5700,
};

type Body = Record<string, unknown>;
export type FakeChatChunk = Record<string, unknown> & { choices: unknown[]; usage?: unknown };
export type FakeChatCompletion = ReturnType<typeof chatCompletion>;
export type FakeResponse = ReturnType<typeof response>;

function chatCompletion() {
  return {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 1,
    model: CHAT_MODEL,
    service_tier: 'flex',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: CHAT_USAGE,
  };
}

/** Chunks as the API streams them: `usage: null` everywhere + a final usage-only chunk only when asked. */
function chatChunks(body: Body) {
  const includeUsage = (body['stream_options'] as { include_usage?: boolean } | undefined)?.include_usage === true;
  const base = { id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: CHAT_MODEL, service_tier: 'default', ...(includeUsage ? { usage: null } : {}) };
  const chunks: FakeChatChunk[] = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];

  if (includeUsage) {
    chunks.push({ ...base, choices: [], usage: CHAT_USAGE });
  }

  return chunks;
}

function response(status = 'completed', output: unknown[] = []) {
  return { id: 'resp_1', object: 'response', model: 'gpt-5-2026-08-07', status, service_tier: 'priority', output, usage: status === 'queued' ? null : RESPONSES_USAGE };
}

function responseEvents(terminal = 'response.completed', output: unknown[] = []) {
  // Each output item is also announced mid-stream (`response.output_item.done`), like the API does.
  const items = output.map((item, index) => ({ type: 'response.output_item.done', sequence_number: 2 + index, output_index: index, item }));

  return [
    { type: 'response.created', sequence_number: 0, response: { ...response('in_progress'), usage: null } },
    { type: 'response.output_text.delta', sequence_number: 1, delta: 'Hi' },
    ...items,
    {
      type: terminal,
      sequence_number: 2 + items.length,
      response: response(terminal === 'response.failed' ? 'failed' : terminal === 'response.incomplete' ? 'incomplete' : 'completed', output),
    },
  ];
}

export interface FakeBehaviour {
  /** Reject every call with this error (an API error). */
  fail?: unknown;
  /** Throw this mid-stream, before the event at this index. */
  streamErrorAt?: number;
  /** Terminal Responses event type. */
  responsesTerminal?: string;
  /** Non-streaming Responses status. */
  responsesStatus?: string;
  /** Responses `output` items (built-in tool calls, …) of the final response. */
  responsesOutput?: unknown[];
}

export interface FakeRequest {
  method: string;
  body: unknown;
  options: unknown;
  argCount: number;
}

class FakeChatCompletions {
  public constructor(private readonly client: FakeOpenAI) {}

  // Overloads mirror the SDK's (`stream: true` → a Stream, else a completion).
  public create(body: Body & { stream: true }, ...rest: unknown[]): FakeAPIPromise<FakeStream<FakeChatChunk>>;
  public create(body: Body, ...rest: unknown[]): FakeAPIPromise<FakeChatCompletion>;
  public create(body: Body, ...rest: unknown[]): FakeAPIPromise<FakeStream<FakeChatChunk> | FakeChatCompletion> {
    const client = this.client;

    client.requests.push({ method: 'chat.completions.create', body, options: rest[0], argCount: 1 + rest.length });

    if (client.behaviour.fail) return FakeAPIPromise.rejecting<FakeChatCompletion>(client, client.behaviour.fail);

    if (body['stream'] === true) {
      return FakeAPIPromise.resolving(client, () => client.remember(FakeStream.fromEvents(chatChunks(body), { errorAt: client.behaviour.streamErrorAt, error: new FakeOpenAIError('stream broke', 500) }, client)));
    }

    return FakeAPIPromise.resolving(client, () => client.remember(chatCompletion()));
  }

  /** Like the SDK: goes through the RAW client (`this._client.chat.completions.create`), then `_thenUnwrap`. */
  public parse(body: Body, options?: unknown) {
    return this.client.chat.completions.create(body, options)._thenUnwrap((completion) => ({ ...completion, parsed: true }));
  }
}

class FakeResponses {
  public constructor(private readonly client: FakeOpenAI) {}

  public create(body: Body & { stream: true }, ...rest: unknown[]): FakeAPIPromise<FakeStream<Record<string, unknown>>>;
  public create(body: Body, ...rest: unknown[]): FakeAPIPromise<FakeResponse>;
  public create(body: Body, ...rest: unknown[]): FakeAPIPromise<FakeStream<Record<string, unknown>> | FakeResponse> {
    const client = this.client;

    client.requests.push({ method: 'responses.create', body, options: rest[0], argCount: 1 + rest.length });

    if (client.behaviour.fail) return FakeAPIPromise.rejecting<FakeResponse>(client, client.behaviour.fail);

    if (body['stream'] === true) {
      return FakeAPIPromise.resolving(client, () =>
        client.remember(FakeStream.fromEvents(responseEvents(client.behaviour.responsesTerminal, client.behaviour.responsesOutput), {}, client)),
      );
    }

    return FakeAPIPromise.resolving(client, () =>
      client.remember(response(body['background'] === true ? 'queued' : client.behaviour.responsesStatus, client.behaviour.responsesOutput)),
    );
  }

  public parse(body: Body, options?: unknown) {
    return this.client.responses.create(body, options)._thenUnwrap((value) => ({ ...value, output_parsed: {} }));
  }

  public stream(body: Body, ...rest: unknown[]) {
    this.client.requests.push({ method: 'responses.stream', body, options: rest[0], argCount: 1 + rest.length });

    return this.client.remember(
      FakeResponseStream.create(responseEvents(this.client.behaviour.responsesTerminal, this.client.behaviour.responsesOutput), { error: this.client.behaviour.fail }),
    );
  }

  public retrieve(id: string) {
    return FakeAPIPromise.resolving(this.client, () => ({ ...response(), id }));
  }
}

class FakeEmbeddings {
  public constructor(private readonly client: FakeOpenAI) {}

  public create(body: Body, ...rest: unknown[]) {
    this.client.requests.push({ method: 'embeddings.create', body, options: rest[0], argCount: 1 + rest.length });

    return FakeAPIPromise.resolving(this.client, () =>
      this.client.remember({ object: 'list', model: 'text-embedding-3-small', data: [{ object: 'embedding', index: 0, embedding: [0.1] }], usage: { prompt_tokens: 42, total_tokens: 42 } }),
    );
  }
}

export class FakeOpenAI {
  public readonly baseURL: string;
  public readonly apiVersion: string | undefined;
  public readonly requests: FakeRequest[] = [];
  /** Every value the fake SDK produced (to assert reference equality). */
  public readonly produced: unknown[] = [];
  public readonly chat: { completions: FakeChatCompletions };
  public readonly responses: FakeResponses;
  public readonly embeddings: FakeEmbeddings;
  #apiKey: string;

  public constructor(
    options: { baseURL?: string; apiVersion?: string; apiKey?: string } = {},
    public readonly behaviour: FakeBehaviour = {},
  ) {
    this.baseURL = options.baseURL ?? 'https://api.openai.com/v1';
    this.apiVersion = options.apiVersion;
    this.#apiKey = options.apiKey ?? 'sk-test';
    this.chat = { completions: new FakeChatCompletions(this) };
    this.responses = new FakeResponses(this);
    this.embeddings = new FakeEmbeddings(this);
  }

  public remember<T>(value: T) {
    this.produced.push(value);

    return value;
  }

  /** Uses a `#private` field: only works when called on the real instance. */
  public authHeader() {
    return `Bearer ${this.#apiKey}`;
  }

  public withOptions(options: { baseURL?: string }) {
    return new FakeOpenAI({ baseURL: options.baseURL ?? this.baseURL, apiVersion: this.apiVersion, apiKey: this.#apiKey }, this.behaviour);
  }
}
