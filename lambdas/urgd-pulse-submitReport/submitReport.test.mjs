// Feature: pulse — urgd-pulse-submitReport unit tests
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Env setup ────────────────────────────────────────────────────────────────

const INTAKE_URL = 'https://command.example.com/v1/intake/report';
const API_KEY = 'test-api-key-abc123';

function setEnv() {
  process.env.COMMAND_INTAKE_URL = INTAKE_URL;
  process.env.COMMAND_API_KEY = API_KEY;
  process.env.CORS_ALLOWED_ORIGINS = 'https://pulse.urgdstudios.com';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test-001',
      authorizer: {},
    },
    body: JSON.stringify({
      type: 'bug-report',
      message: 'Something is broken on the items page.',
    }),
    ...overrides,
  };
}

function mockFetch(status = 200, body = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('urgd-pulse-submitReport', () => {
  let handler;

  beforeEach(async () => {
    setEnv();
    vi.resetModules();
    // handler is loaded fresh each test to pick up env
    ({ handler } = await import('./index.mjs'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Valid types ──────────────────────────────────────────────────────────────

  it.each([
    'general-inquiry',
    'bug-report',
    'feature-request',
    'privacy-question',
    'report-abuse',
  ])('forwards valid type "%s" to Command intake', async (type) => {
    const fetchSpy = mockFetch(200);
    global.fetch = fetchSpy;

    const event = makeEvent({ body: JSON.stringify({ type, message: 'Test message.' }) });
    const res = await handler(event);

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(INTAKE_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Api-Key']).toBe(API_KEY);

    const payload = JSON.parse(init.body);
    expect(payload.app).toBe('pulse');
    expect(payload.type).toBe(type);
    expect(payload.message).toBe('Test message.');
  });

  // ── Invalid type ─────────────────────────────────────────────────────────────

  it('returns 400 for invalid type', async () => {
    global.fetch = mockFetch(200);
    const event = makeEvent({ body: JSON.stringify({ type: 'spam', message: 'Hello.' }) });
    const res = await handler(event);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/Invalid report type/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 for missing type', async () => {
    global.fetch = mockFetch(200);
    const event = makeEvent({ body: JSON.stringify({ message: 'Hello.' }) });
    const res = await handler(event);

    expect(res.statusCode).toBe(400);
  });

  // ── Empty message ─────────────────────────────────────────────────────────────

  it('returns 400 for empty message', async () => {
    global.fetch = mockFetch(200);
    const event = makeEvent({ body: JSON.stringify({ type: 'bug-report', message: '' }) });
    const res = await handler(event);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/message is required/i);
  });

  it('returns 400 for whitespace-only message', async () => {
    global.fetch = mockFetch(200);
    const event = makeEvent({ body: JSON.stringify({ type: 'bug-report', message: '   ' }) });
    const res = await handler(event);

    expect(res.statusCode).toBe(400);
  });

  // ── Message > 5000 chars ──────────────────────────────────────────────────────

  it('returns 400 for message exceeding 5000 characters', async () => {
    global.fetch = mockFetch(200);
    const longMessage = 'a'.repeat(5001);
    const event = makeEvent({ body: JSON.stringify({ type: 'bug-report', message: longMessage }) });
    const res = await handler(event);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/5,000 characters/i);
  });

  it('accepts message of exactly 5000 characters', async () => {
    global.fetch = mockFetch(200);
    const maxMessage = 'a'.repeat(5000);
    const event = makeEvent({ body: JSON.stringify({ type: 'bug-report', message: maxMessage }) });
    const res = await handler(event);

    expect(res.statusCode).toBe(200);
  });

  // ── Upstream 4xx → 502 ───────────────────────────────────────────────────────

  it('returns 502 when upstream returns 4xx', async () => {
    global.fetch = mockFetch(422);
    const event = makeEvent();
    const res = await handler(event);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).message).toMatch(/could not be submitted/i);
  });

  it('returns 502 when upstream returns 5xx', async () => {
    global.fetch = mockFetch(503);
    const event = makeEvent();
    const res = await handler(event);

    expect(res.statusCode).toBe(502);
  });

  it('returns 502 when fetch throws (network error)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));
    const event = makeEvent();
    const res = await handler(event);

    expect(res.statusCode).toBe(502);
  });

  // ── No PII in logs ────────────────────────────────────────────────────────────

  it('does not log name or email fields', async () => {
    global.fetch = mockFetch(200);
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const event = makeEvent({
      body: JSON.stringify({
        type: 'general-inquiry',
        message: 'I have a question.',
        name: 'Jane Doe',
        email: 'jane@example.com',
      }),
    });
    await handler(event);

    const allOutput = logSpy.mock.calls.map(c => c[0]).join('');
    expect(allOutput).not.toContain('Jane Doe');
    expect(allOutput).not.toContain('jane@example.com');

    logSpy.mockRestore();
  });

  // ── Optional fields forwarded ─────────────────────────────────────────────────

  it('includes name and email in payload when provided', async () => {
    const fetchSpy = mockFetch(200);
    global.fetch = fetchSpy;

    const event = makeEvent({
      body: JSON.stringify({
        type: 'general-inquiry',
        message: 'Question here.',
        name: 'Jane Doe',
        email: 'jane@example.com',
      }),
    });
    await handler(event);

    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload.name).toBe('Jane Doe');
    expect(payload.email).toBe('jane@example.com');
  });

  it('omits name and email from payload when not provided', async () => {
    const fetchSpy = mockFetch(200);
    global.fetch = fetchSpy;

    const event = makeEvent();
    await handler(event);

    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('email');
  });

  // ── Context metadata ──────────────────────────────────────────────────────────

  it('includes sessionId in metadata when present in authorizer context', async () => {
    const fetchSpy = mockFetch(200);
    global.fetch = fetchSpy;

    const event = makeEvent({
      requestContext: {
        requestId: 'req-002',
        authorizer: { sessionId: 'sess-abc', tenantId: null },
      },
    });
    await handler(event);

    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload.metadata.sessionId).toBe('sess-abc');
  });

  it('includes tenantId in metadata when present in authorizer context', async () => {
    const fetchSpy = mockFetch(200);
    global.fetch = fetchSpy;

    const event = makeEvent({
      requestContext: {
        requestId: 'req-003',
        authorizer: { tenantId: 'tenant-xyz' },
      },
    });
    await handler(event);

    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload.metadata.tenantId).toBe('tenant-xyz');
  });

  // ── Invalid JSON body ─────────────────────────────────────────────────────────

  it('returns 400 for malformed JSON body', async () => {
    global.fetch = mockFetch(200);
    const event = makeEvent({ body: 'not-json' });
    const res = await handler(event);

    expect(res.statusCode).toBe(400);
  });
});
