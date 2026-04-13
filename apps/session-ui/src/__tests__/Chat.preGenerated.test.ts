// Unit tests for Chat.tsx — Pre-generated greeting behavior
// Requirements: 2.1–2.5
//
// Since session-ui doesn't have @testing-library/react installed,
// we test the API layer (writePreGeneratedTranscript) and the
// session state interface that drives the pre-generated greeting logic.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetch globally
const fetchSpy = vi.fn()
vi.stubGlobal('fetch', fetchSpy)

// Mock import.meta.env
vi.stubEnv('VITE_API_BASE_URL', 'https://api.test.com')

// We test the API function directly since it's the critical integration point
const { writePreGeneratedTranscript, getSessionState } = await import('../api/session.ts')

describe('Chat.tsx — pre-generated greeting API integration', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  describe('writePreGeneratedTranscript', () => {
    it('sends __init_pregenerated__ message with greeting to chat endpoint', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { greeting: 'Welcome!' } }),
      })

      await writePreGeneratedTranscript('session-1', 'token-abc', 'Welcome to your session!')

      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, options] = fetchSpy.mock.calls[0]
      expect(url).toContain('/api/session/session-1/chat')
      expect(options.method).toBe('POST')

      const body = JSON.parse(options.body)
      expect(body.message).toBe('__init_pregenerated__')
      expect(body.preGeneratedGreeting).toBe('Welcome to your session!')
    })

    it('does not throw on fetch failure (best-effort)', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'))

      // Should not throw
      await writePreGeneratedTranscript('session-1', 'token-abc', 'Welcome!')
    })

    it('does not throw on non-ok response (best-effort)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: true }),
      })

      // Should not throw
      await writePreGeneratedTranscript('session-1', 'token-abc', 'Welcome!')
    })
  })

  describe('getSessionState — preGeneratedGreeting field', () => {
    it('returns preGeneratedGreeting when present in response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 1,
            totalSections: 5,
            messages: [],
            status: 'not_started',
            timeLimitMinutes: 30,
            files: [],
            preGeneratedGreeting: 'Welcome to your session!',
          },
        }),
      })

      const state = await getSessionState('session-1', 'token-abc')
      expect(state.preGeneratedGreeting).toBe('Welcome to your session!')
    })

    it('returns undefined/null preGeneratedGreeting when absent', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 1,
            totalSections: 5,
            messages: [],
            status: 'not_started',
            timeLimitMinutes: 30,
            files: [],
          },
        }),
      })

      const state = await getSessionState('session-1', 'token-abc')
      expect(state.preGeneratedGreeting).toBeUndefined()
    })

    it('does not include preGeneratedGreeting for in_progress sessions (resume scenario)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            currentSection: 2,
            totalSections: 5,
            messages: [
              { role: 'reviewer', content: '[__session_start__]' },
              { role: 'agent', content: 'Welcome!' },
            ],
            status: 'in_progress',
            timeLimitMinutes: 30,
            files: [],
            // Backend omits preGeneratedGreeting for in_progress sessions
          },
        }),
      })

      const state = await getSessionState('session-1', 'token-abc')
      expect(state.preGeneratedGreeting).toBeUndefined()
      expect(state.messages).toHaveLength(2)
    })
  })
})
