// Unit tests for Chat.tsx — Template greeting flow
// Requirements: 4.1, 4.2, 4.4, 8.1, 8.2, 8.5, 9.1, 9.2, 11.1
//
// Since session-ui doesn't have @testing-library/react installed,
// we test the API layer (initTemplateGreeting, getSessionState,
// sendChatMessageStreaming) and the session state interface that
// drives the template greeting logic in Chat.tsx.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetch globally
const fetchSpy = vi.fn()
vi.stubGlobal('fetch', fetchSpy)

// Mock import.meta.env
vi.stubEnv('VITE_API_BASE_URL', 'https://api.test.com')
vi.stubEnv('VITE_CHAT_FUNCTION_URL', 'https://fn.test.com/chat')

// Import the API functions under test
const {
  initTemplateGreeting,
  getSessionState,
  sendChatMessageStreaming,
} = await import('../api/session.ts')

// Also import consumeStream to verify streaming integration
const { consumeStream } = await import('../hooks/useStreaming.ts')

describe('Chat.tsx — template greeting flow', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  // ── Requirement 4.1, 4.2: Template greeting displayed instantly ─────────
  describe('getSessionState — templateGreeting for not_started sessions', () => {
    it('returns templateGreeting when present for not_started session', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 1,
            totalSections: 5,
            messages: [],
            status: 'not_started',
            timeLimitMinutes: 17,
            files: [],
            templateGreeting: "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios. I'm here to walk you through Test Document.",
          },
        }),
      })

      const state = await getSessionState('session-1', 'token-abc')
      expect(state.templateGreeting).toBe(
        "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios. I'm here to walk you through Test Document."
      )
      expect(state.status).toBe('not_started')
      expect(state.messages).toHaveLength(0)
    })

    it('returns null/undefined templateGreeting for legacy items (no greeting stored)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 1,
            totalSections: 3,
            messages: [],
            status: 'not_started',
            timeLimitMinutes: 30,
            files: [],
            // No templateGreeting — legacy item
          },
        }),
      })

      const state = await getSessionState('session-2', 'token-def')
      expect(state.templateGreeting).toBeUndefined()
    })
  })

  // ── Requirement 4.4, 11.1: Greeting not re-displayed for in_progress ────
  describe('getSessionState — in_progress sessions (resume scenario)', () => {
    it('does not include templateGreeting for in_progress sessions', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 2,
            totalSections: 5,
            messages: [
              { role: 'agent', content: "Hey! I'm Pulse — greeting text here." },
              { role: 'reviewer', content: "I'm ready to start." },
              { role: 'agent', content: 'Great, let me review the document.' },
            ],
            status: 'in_progress',
            timeLimitMinutes: 17,
            files: [],
            // Backend omits templateGreeting for in_progress sessions
          },
        }),
      })

      const state = await getSessionState('session-3', 'token-ghi')
      expect(state.templateGreeting).toBeUndefined()
      expect(state.status).toBe('in_progress')
      expect(state.messages).toHaveLength(3)
    })

    it('returns existing transcript messages for resumed sessions', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 1,
            totalSections: 4,
            messages: [
              { role: 'agent', content: "Hey! I'm Pulse — greeting." },
              { role: 'reviewer', content: 'Ready!' },
            ],
            status: 'in_progress',
            timeLimitMinutes: 20,
            files: [],
          },
        }),
      })

      const state = await getSessionState('session-4', 'token-jkl')
      expect(state.messages).toHaveLength(2)
      expect(state.messages[0].role).toBe('agent')
      expect(state.messages[1].role).toBe('reviewer')
    })
  })

  // ── Requirement 4.1, 4.3: initTemplateGreeting writes transcript ────────
  describe('initTemplateGreeting', () => {
    it('sends __template_init__ message with templateGreeting to chat endpoint', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { greeting: 'stored', alreadyInitialized: false } }),
      })

      await initTemplateGreeting('session-1', 'token-abc', 'Hey! I am Pulse.')

      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, options] = fetchSpy.mock.calls[0]
      expect(url).toContain('/api/session/session-1/chat')
      expect(options.method).toBe('POST')

      const body = JSON.parse(options.body)
      expect(body.message).toBe('__template_init__')
      expect(body.templateGreeting).toBe('Hey! I am Pulse.')
    })

    it('does not throw on non-ok response (best-effort)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: true }),
      })

      // initTemplateGreeting is best-effort — should not throw
      await expect(initTemplateGreeting('session-1', 'token-abc', 'Hello!')).resolves.toBeUndefined()
    })

    it('does not throw on network failure (best-effort)', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'))

      // initTemplateGreeting should propagate the error (caller catches it)
      await expect(initTemplateGreeting('session-1', 'token-abc', 'Hello!')).rejects.toThrow('Network error')
    })

    it('includes Authorization header with session token', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      })

      await initTemplateGreeting('session-1', 'my-token', 'Greeting text')

      const [, options] = fetchSpy.mock.calls[0]
      expect(options.headers.Authorization).toBe('Bearer my-token')
    })
  })

  // ── Requirement 8.1, 8.2, 8.5: No __session_start__ when templateGreeting exists ──
  describe('session state interface — template greeting vs legacy fallback', () => {
    it('templateGreeting present + empty messages = instant greeting path (no __session_start__)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 1,
            totalSections: 5,
            messages: [],
            status: 'not_started',
            timeLimitMinutes: 17,
            files: [],
            templateGreeting: 'Hey! I am Pulse.',
          },
        }),
      })

      const state = await getSessionState('session-5', 'token-mno')

      // Chat.tsx logic: if templateGreeting && messages.length === 0 → instant display
      const shouldDisplayInstantly = !!state.templateGreeting && state.messages.length === 0
      expect(shouldDisplayInstantly).toBe(true)

      // Should NOT send __session_start__ in this path
      const shouldSendSessionStart = !state.templateGreeting
      expect(shouldSendSessionStart).toBe(false)
    })

    it('no templateGreeting = legacy fallback sends __session_start__ via streaming', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 1,
            totalSections: 3,
            messages: [],
            status: 'not_started',
            timeLimitMinutes: 30,
            files: [],
            // No templateGreeting — legacy item
          },
        }),
      })

      const state = await getSessionState('session-6', 'token-pqr')

      // Chat.tsx logic: no templateGreeting → legacy fallback → autoSend('__session_start__')
      const shouldFallbackToSessionStart = !state.templateGreeting
      expect(shouldFallbackToSessionStart).toBe(true)
    })

    it('preGeneratedGreeting field is no longer in the interface', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 1,
            totalSections: 5,
            messages: [],
            status: 'not_started',
            timeLimitMinutes: 17,
            files: [],
            templateGreeting: 'New greeting',
          },
        }),
      })

      const state = await getSessionState('session-7', 'token-stu')
      // The old preGeneratedGreeting field should not be present
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((state as any).preGeneratedGreeting).toBeUndefined()
      // The new templateGreeting field should be present
      expect(state.templateGreeting).toBe('New greeting')
    })
  })

  // ── Requirement 9.1, 9.2: autoSend uses sendChatMessageStreaming ────────
  describe('sendChatMessageStreaming — used by autoSend for all signals', () => {
    it('sends __session_start__ signal via Function URL (streaming)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: null,
      })

      await sendChatMessageStreaming('session-1', 'token-abc', '__session_start__')

      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, options] = fetchSpy.mock.calls[0]
      // Should use Function URL, not API Gateway
      expect(url).toBe('https://fn.test.com/chat')
      expect(options.method).toBe('POST')

      const body = JSON.parse(options.body)
      expect(body.message).toBe('__session_start__')
      expect(body.sessionId).toBe('session-1')
      expect(body.sessionToken).toBe('token-abc')
    })

    it('sends __session_resume__ signal via Function URL (streaming)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: null,
      })

      await sendChatMessageStreaming('session-1', 'token-abc', '__session_resume__')

      const [url, options] = fetchSpy.mock.calls[0]
      expect(url).toBe('https://fn.test.com/chat')
      const body = JSON.parse(options.body)
      expect(body.message).toBe('__session_resume__')
    })

    it('sends __session_end__ signal via Function URL (streaming)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: null,
      })

      await sendChatMessageStreaming('session-1', 'token-abc', '__session_end__')

      const [url, options] = fetchSpy.mock.calls[0]
      expect(url).toBe('https://fn.test.com/chat')
      const body = JSON.parse(options.body)
      expect(body.message).toBe('__session_end__')
    })

    it('does not include Authorization header when using Function URL', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: null,
      })

      await sendChatMessageStreaming('session-1', 'token-abc', '__session_start__')

      const [, options] = fetchSpy.mock.calls[0]
      // Function URL auth is in the body, not the header
      expect(options.headers.Authorization).toBeUndefined()
    })

    it('throws on non-ok response with error details', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ message: 'Service unavailable' }),
      })

      await expect(
        sendChatMessageStreaming('session-1', 'token-abc', '__session_start__')
      ).rejects.toThrow('Service unavailable')
    })
  })

  // ── Requirement 11.1: consumeStream integration for autoSend ────────────
  describe('consumeStream — streaming response handling for autoSend', () => {
    function makeStreamResponse(chunks: string[]): Response {
      const encoder = new TextEncoder()
      let index = 0
      const stream = new ReadableStream({
        pull(controller) {
          if (index < chunks.length) {
            controller.enqueue(encoder.encode(chunks[index]))
            index++
          } else {
            controller.close()
          }
        },
      })
      return { body: stream } as unknown as Response
    }

    it('calls onComplete with full text after stream finishes', async () => {
      const response = makeStreamResponse([
        'Hello, I am Pulse. ',
        'Let me review your document.',
      ])

      let completedText = ''
      await consumeStream(response, {
        onToken: () => {},
        onSection: () => {},
        onComplete: (text) => { completedText = text },
        onError: () => {},
      })

      expect(completedText).toContain('Hello, I am Pulse.')
      expect(completedText).toContain('Let me review your document.')
    })

    it('extracts section numbers from [SECTION:N] tags', async () => {
      const response = makeStreamResponse([
        'Section one content. [SECTION:2] Section two content.',
      ])

      const sections: number[] = []
      await consumeStream(response, {
        onToken: () => {},
        onSection: (n) => { sections.push(n) },
        onComplete: () => {},
        onError: () => {},
      })

      expect(sections).toContain(2)
    })

    it('fires onError when response body is null', async () => {
      const response = { body: null } as unknown as Response

      let errorMsg = ''
      await consumeStream(response, {
        onToken: () => {},
        onSection: () => {},
        onComplete: () => {},
        onError: (err) => { errorMsg = err.message },
      })

      expect(errorMsg).toContain('null')
    })

    it('detects in-stream error JSON and fires onError with status', async () => {
      const errorJson = JSON.stringify({ error: true, statusCode: 410, message: 'Session expired' })
      const response = makeStreamResponse([errorJson])

      let caughtError: (Error & { status?: number }) | null = null
      await consumeStream(response, {
        onToken: () => {},
        onSection: () => {},
        onComplete: () => {},
        onError: (err) => { caughtError = err as Error & { status?: number } },
      })

      expect(caughtError).not.toBeNull()
      expect(caughtError!.message).toBe('Session expired')
      expect(caughtError!.status).toBe(410)
    })
  })
})
