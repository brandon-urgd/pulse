// Unit tests for Chat.tsx — Template greeting flow REMOVED
// Requirements: Requirement 13 (Phased Cache Priming — template greeting infrastructure removal)
//
// Updated: initTemplateGreeting and templateGreeting have been removed.
// The session now sends __session_start__ directly for model-generated greetings.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetch globally
const fetchSpy = vi.fn()
vi.stubGlobal('fetch', fetchSpy)

// Mock import.meta.env
vi.stubEnv('VITE_API_BASE_URL', 'https://api.test.com')
vi.stubEnv('VITE_CHAT_FUNCTION_URL', 'https://fn.test.com/chat')

// Import the API functions under test
const {
  getSessionState,
  sendChatMessageStreaming,
} = await import('../api/session.ts')

// Also import consumeStream to verify streaming integration
const { consumeStream } = await import('../hooks/useStreaming.ts')

describe('Chat.tsx — session start flow (template greeting removed)', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  // ── initTemplateGreeting is no longer exported ──────────────────────────
  describe('initTemplateGreeting removed from API', () => {
    it('initTemplateGreeting is no longer exported from session API', async () => {
      const sessionApi = await import('../api/session.ts')
      expect((sessionApi as any).initTemplateGreeting).toBeUndefined()
    })
  })

  // ── templateGreeting removed from SessionStateResponse ──────────────────
  describe('getSessionState — templateGreeting no longer in response interface', () => {
    it('returns session state without templateGreeting field', async () => {
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
          },
        }),
      })

      const state = await getSessionState('session-1', 'token-abc')
      expect(state.status).toBe('not_started')
      expect(state.messages).toHaveLength(0)
      // templateGreeting is no longer part of the interface
      expect((state as any).templateGreeting).toBeUndefined()
    })
  })

  // ── Session start always uses __session_start__ ─────────────────────────
  describe('session start — always sends __session_start__ via streaming', () => {
    it('sends __session_start__ signal via Function URL (streaming)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: null,
      })

      await sendChatMessageStreaming('session-1', 'token-abc', '__session_start__')

      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, options] = fetchSpy.mock.calls[0]
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

  // ── consumeStream integration for autoSend ──────────────────────────────
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
