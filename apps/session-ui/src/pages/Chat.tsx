import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSession } from '../context/SessionContext'
import {
  deleteSessionTranscript,
  getSessionState,
  sendChatMessage,
} from '../api/session'
import ChatBubble from '../components/ChatBubble'
import PulseDot from '../components/PulseDot'
import PulseLine from '../components/PulseLine'
import FileAttachmentBar from '../components/FileAttachmentBar'
import ThinkingIndicator from '../components/ThinkingIndicator'
import ExitSheet from '../components/ExitSheet'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'agent' | 'reviewer' | 'content' | 'error'
  content: string
  section?: number
}

type SessionStatus =
  | 'not_started'
  | 'in_progress'
  | 'complete'
  | 'discarded'
  | 'paused'
  | 'loading'

type WindingDown = 'true' | 'final' | null
type ClosingState = 'exploring' | 'narrowing' | 'closing' | 'closed'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimeLeft(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function errorMessage(status: number | undefined): string {
  if (status === 503) return 'The agent is temporarily unavailable. Try sending your message again in a moment.'
  if (status === 504) return 'That took longer than expected. Try sending your message again.'
  if (status === 410) return 'This session has expired. The close date has passed.'
  if (status === 500) return 'Something went wrong. Try sending your message again.'
  return 'Unable to connect. Check your internet and try again.'
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100dvh',
    background: '#0f0f0f',
    color: '#e5e5e5',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    minWidth: '375px',
  },
  topBar: {
    height: '48px',
    background: '#0f0f0f',
    borderBottom: '1px solid #2a2a2a',
    padding: '0 1rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  },
  wordmark: {
    color: '#7C9E8A',
    fontWeight: 700,
    letterSpacing: '0.05em',
    fontSize: '0.875rem',
  },
  topBarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  timeDisplay: {
    fontSize: '0.8125rem',
    color: '#888',
  },
  endSessionButton: {
    background: 'transparent',
    border: 'none',
    color: '#888',
    fontSize: '0.8125rem',
    cursor: 'pointer',
    padding: '0.25rem 0.5rem',
  },
  pulseLineWrapper: {
    padding: '0.5rem 0',
    flexShrink: 0,
  },
  chatArea: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  messageRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '0.5rem',
  },
  messageRowReviewer: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  inputArea: {
    borderTop: '1px solid #2a2a2a',
    padding: '0.75rem 1rem',
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'flex-end',
    background: '#0f0f0f',
    flexShrink: 0,
  },
  input: {
    flex: 1,
    minHeight: '48px',
    borderRadius: '24px',
    background: '#0f0f0f',
    border: '1px solid #2a2a2a',
    color: '#e5e5e5',
    fontSize: '0.9375rem',
    padding: '0.75rem 1rem',
    resize: 'none' as const,
    fontFamily: 'inherit',
    outline: 'none',
    lineHeight: 1.5,
  },
  inputFocused: {
    border: '1px solid #4a7c59',
  },
  sendButton: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    background: '#4a7c59',
    border: 'none',
    color: '#ffffff',
    fontSize: '1rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    alignSelf: 'flex-end',
    marginBottom: '6px',
  },
  sendButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  sessionCompleteCaption: {
    fontSize: '0.875rem',
    color: '#888',
    textAlign: 'center' as const,
    padding: '1rem',
    borderTop: '1px solid #2a2a2a',
  },
  completionCard: {
    background: 'rgba(74,124,89,0.12)',
    borderLeft: '3px solid #4a7c59',
    borderRadius: '12px',
    padding: '1rem 1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  completionHeading: {
    fontSize: '1rem',
    fontWeight: 600,
    color: '#ffffff',
    margin: 0,
  },
  completionBody: {
    fontSize: '0.875rem',
    color: '#ccc',
    margin: 0,
    lineHeight: 1.6,
  },
  completionLink: {
    color: '#7C9E8A',
    fontSize: '0.875rem',
    textDecoration: 'none',
  },
  discardedPage: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    padding: '2rem',
    textAlign: 'center' as const,
  },
  discardedWordmark: {
    color: '#7C9E8A',
    fontWeight: 700,
    letterSpacing: '0.05em',
    fontSize: '1.25rem',
    marginBottom: '0.5rem',
  },
  discardedHeading: {
    fontSize: '1.125rem',
    fontWeight: 600,
    color: '#ffffff',
    margin: 0,
  },
  discardedBody: {
    fontSize: '0.875rem',
    color: '#888',
    margin: 0,
    lineHeight: 1.6,
    maxWidth: '320px',
  },
  discardedLink: {
    color: '#7C9E8A',
    fontSize: '0.875rem',
    textDecoration: 'none',
  },
  expiredLink: {
    color: '#7C9E8A',
    fontSize: '0.875rem',
    textDecoration: 'none',
    display: 'block',
    marginTop: '0.5rem',
  },
  previewBanner: {
    background: 'var(--color-accent-pulse-subtle, rgba(74, 124, 89, 0.12))',
    borderBottom: '1px solid rgba(74, 124, 89, 0.25)',
    padding: '0.5rem 1rem',
    fontSize: '0.8125rem',
    color: '#ccc',
    textAlign: 'center' as const,
    flexShrink: 0,
    width: '100%',
  },
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Chat() {
  const { sessionId: paramSessionId } = useParams<{ sessionId: string }>()
  const { sessionToken, sessionId: ctxSessionId, itemName, isPreview } = useSession()
  const navigate = useNavigate()

  const sessionId = paramSessionId ?? ctxSessionId ?? ''

  const [messages, setMessages] = useState<Message[]>([])
  const [currentSection, setCurrentSection] = useState(1)
  const [totalSections, setTotalSections] = useState(1)
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('loading')
  const [files, setFiles] = useState<Array<{ fileId: string; filename: string; contentType: string }>>([])
  const [timeLimitSeconds, setTimeLimitSeconds] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [timerStarted, setTimerStarted] = useState(false)
  const [windingDown, setWindingDown] = useState<WindingDown>(null)
  const [closingState, setClosingState] = useState<ClosingState>('exploring')
  const [animationDuration, setAnimationDuration] = useState('2s')
  const [isThinking, setIsThinking] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [inputFocused, setInputFocused] = useState(false)
  const [showExitSheet, setShowExitSheet] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [timeAnnouncement, setTimeAnnouncement] = useState('')
  const [announced80, setAnnounced80] = useState(false)
  const [announced95, setAnnounced95] = useState(false)

  const chatAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number | null>(null)

  // ── Document title ──────────────────────────────────────────────────────────
  useEffect(() => {
    document.title = 'Session — Pulse'
  }, [])

  // ── Redirect if no token ────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken) {
      navigate(`/s/${sessionId}`)
    }
  }, [sessionToken, sessionId, navigate])

  // ── Load session state ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken || !sessionId) return

    async function load() {
      try {
        const state = await getSessionState(sessionId, sessionToken!)
        setCurrentSection(state.currentSection)
        setTotalSections(state.totalSections)
        setTimeLimitSeconds(state.timeLimitMinutes * 60)
        setFiles(state.files ?? [])
        if (state.closingState) setClosingState(state.closingState)

        const existingMessages: Message[] = state.messages.map((m) => ({
          role: m.role,
          content: m.content,
          section: m.section,
        }))

        if (state.status === 'not_started') {
          setSessionStatus('not_started')
          setMessages(existingMessages)
          // Auto-send start signal
          await autoSend('__session_start__', existingMessages)
        } else if (state.status === 'in_progress') {
          setSessionStatus('in_progress')
          setMessages(existingMessages)
          if (existingMessages.length > 0) {
            await autoSend('__session_resume__', existingMessages)
          }
        } else if (state.status === 'complete') {
          setSessionStatus('complete')
          setMessages(existingMessages)
        } else {
          setSessionStatus('in_progress')
          setMessages(existingMessages)
        }
      } catch (err) {
        const status = (err as Error & { status?: number }).status
        if (status === 401) {
          navigate(`/s/${sessionId}`)
        } else if (status === 403) {
          navigate(`/s/${sessionId}/confidentiality`)
        } else if (status === 410) {
          setSessionExpired(true)
          setSessionStatus('in_progress')
          setMessages([{
            role: 'error',
            content: 'This session has expired. The close date has passed.',
          }])
        } else {
          setMessages([{
            role: 'error',
            content: errorMessage(status),
          }])
          setSessionStatus('in_progress')
        }
      }
    }

    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionToken])

  // ── Auto-send helper ────────────────────────────────────────────────────────
  const autoSend = useCallback(
    async (signal: string, currentMessages: Message[]) => {
      if (!sessionToken) return
      setIsThinking(true)
      try {
        const resp = await sendChatMessage(sessionId, sessionToken, signal)
        const newMsg: Message = { role: 'agent', content: resp.message, section: resp.section }
        setMessages([...currentMessages, newMsg])
        setCurrentSection(resp.section)
        setSessionStatus('in_progress')
        if (resp.closingState) setClosingState(resp.closingState)
        if (resp.sessionComplete) {
          setSessionStatus('complete')
        }
      } catch (err) {
        const status = (err as Error & { status?: number }).status
        // Ensure session is in_progress so the End Session button appears
        // even after a failed auto-send — reviewer needs a way out
        setSessionStatus('in_progress')
        handleSendError(status, currentMessages)
      } finally {
        setIsThinking(false)
      }
    },
    [sessionId, sessionToken]
  )

  // ── Timer ───────────────────────────────────────────────────────────────────
  function startTimer() {
    // Never run the timer in preview mode — preview is a 15-min TTL session,
    // not a paced review. Wind-down signals don't apply.
    if (timerStarted || timeLimitSeconds === 0 || isPreview) return
    setTimerStarted(true)
    startTimeRef.current = Date.now()
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current!) / 1000)
      setElapsedSeconds(elapsed)
    }, 1000)
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // ── Wind-down logic ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (timeLimitSeconds === 0 || !timerStarted) return
    const remaining = timeLimitSeconds - elapsedSeconds

    // Absolute remaining-time thresholds — percentages don't scale to short sessions.
    // At 3 min remaining: soft wrap signal. At 90 sec remaining: closing signal.
    if (remaining <= 90 && windingDown !== 'final') {
      setWindingDown('final')
      setAnimationDuration('4s')
      if (!announced95) {
        setTimeAnnouncement('Session is wrapping up.')
        setAnnounced95(true)
      }
    } else if (remaining <= 180 && windingDown === null) {
      setWindingDown('true')
      if (!announced80) {
        setTimeAnnouncement('Session is nearing its end.')
        setAnnounced80(true)
      }
    }

    if (remaining <= 0 && timerRef.current) {
      clearInterval(timerRef.current)
    }
  }, [elapsedSeconds, timeLimitSeconds, timerStarted, windingDown, announced80, announced95])

  // ── Scroll to bottom ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = chatAreaRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, isThinking])

  // ── Send message ────────────────────────────────────────────────────────────
  function handleSendError(status: number | undefined, currentMessages: Message[]) {
    if (status === 401) {
      navigate(`/s/${sessionId}`)
      return
    }
    if (status === 403) {
      navigate(`/s/${sessionId}/confidentiality`)
      return
    }
    const errMsg: Message = {
      role: 'error',
      content: errorMessage(status),
    }
    if (status === 410) {
      setSessionExpired(true)
    }
    setMessages([...currentMessages, errMsg])
  }

  async function handleSend() {
    const text = inputValue.trim()
    if (!text || !sessionToken || isThinking || sessionStatus !== 'in_progress') return

    const userMsg: Message = { role: 'reviewer', content: text }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInputValue('')
    setIsThinking(true)
    startTimer()

    try {
      const wd = windingDown ?? undefined
      const resp = await sendChatMessage(sessionId, sessionToken, text, wd as 'true' | 'final' | undefined)
      const agentMsg: Message = { role: 'agent', content: resp.message, section: resp.section }
      const finalMessages = [...nextMessages, agentMsg]
      setMessages(finalMessages)
      setCurrentSection(resp.section)
      if (resp.closingState) setClosingState(resp.closingState)

      if (resp.sessionComplete) {
        setSessionStatus('complete')
        if (timerRef.current) clearInterval(timerRef.current)
        // Add completion card
        const completionMsg: Message = {
          role: 'content',
          content: '__completion__',
        }
        setMessages([...finalMessages, completionMsg])
      }
    } catch (err) {
      const status = (err as Error & { status?: number }).status
      handleSendError(status, nextMessages)
    } finally {
      setIsThinking(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Exit sheet handlers ─────────────────────────────────────────────────────
  async function handleSubmitFeedback() {
    if (!sessionToken) return
    setShowExitSheet(false)
    setIsThinking(true)
    try {
      const resp = await sendChatMessage(sessionId, sessionToken, '__session_end__')
      const agentMsg: Message = { role: 'agent', content: resp.message, section: resp.section }
      setMessages((prev) => [...prev, agentMsg])
      if (resp.closingState) setClosingState(resp.closingState)
      if (resp.sessionComplete) {
        setSessionStatus('complete')
        if (timerRef.current) clearInterval(timerRef.current)
        const completionMsg: Message = { role: 'content', content: '__completion__' }
        setMessages((prev) => [...prev, completionMsg])
      }
    } catch (err) {
      const status = (err as Error & { status?: number }).status
      setMessages((prev) => [...prev, { role: 'error', content: errorMessage(status) }])
    } finally {
      setIsThinking(false)
    }
  }

  async function handleDiscard() {
    if (!sessionToken) return
    setShowExitSheet(false)
    try {
      await deleteSessionTranscript(sessionId, sessionToken)
    } catch { /* best-effort */ }
    setSessionStatus('discarded')
    if (timerRef.current) clearInterval(timerRef.current)
  }

  // ── Derived state ───────────────────────────────────────────────────────────
  // isPaused: only lock the session when the backend explicitly closes it,
  // or the session status is 'paused'. The time limit is a soft pacing guide —
  // never hard-lock based on the client-side timer reaching zero.
  const isPaused = sessionStatus === 'paused' || closingState === 'closed'
  const isComplete = sessionStatus === 'complete'
  const isDiscarded = sessionStatus === 'discarded'
  const isLoading = sessionStatus === 'loading'

  const inputDisabled = isThinking || isComplete || isPaused || isDiscarded || isLoading || sessionExpired
  const showEndSessionButton =
    sessionStatus === 'in_progress' && !isThinking && !isPaused && !isComplete && !isDiscarded



  // PulseLine animation slows during closing state
  const pulseLineAnimation = closingState === 'closing' ? '4s' : animationDuration

  // ── Discarded state ─────────────────────────────────────────────────────────
  if (isDiscarded) {
    return (
      <div style={styles.page}>
        <div style={styles.topBar}>
          <span style={styles.wordmark}>pulse</span>
        </div>
        <div style={styles.discardedPage}>
          <div style={styles.discardedWordmark}>pulse</div>
          <h1 style={styles.discardedHeading}>Your session has ended.</h1>
          <p style={styles.discardedBody}>
            Your responses have been removed and won't be shared.
          </p>
          <a href="https://pulse.urgdstudios.com" style={styles.discardedLink}>
            Go to pulse.urgdstudios.com
          </a>
        </div>
      </div>
    )
  }

  // ── Main render ─────────────────────────────────────────────────────────────
  return (
    <div style={styles.page}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <span style={styles.wordmark}>pulse</span>
        <div style={styles.topBarRight}>
          {/* Visually hidden aria-live region for threshold announcements */}
          <span
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}
            aria-live="polite"
            aria-atomic="true"
          >
            {timeAnnouncement}
          </span>
          {isPreview ? (
            <button
              type="button"
              style={styles.endSessionButton}
              onClick={() => window.close()}
            >
              End preview
            </button>
          ) : showEndSessionButton ? (
            <button
              type="button"
              style={styles.endSessionButton}
              onClick={() => setShowExitSheet(true)}
            >
              End session
            </button>
          ) : null}
        </div>
      </div>

      {/* Preview banner — non-dismissible, full-width */}
      {isPreview && (
        <div style={styles.previewBanner} role="status" aria-live="polite">
          This is a preview. Responses are not saved.
        </div>
      )}

      {/* Progress line */}
      <div style={styles.pulseLineWrapper}>
        <PulseLine
          current={isComplete ? totalSections : currentSection}
          total={totalSections}
          animationDuration={pulseLineAnimation}
        />
      </div>

      {/* File attachment bar */}
      {files.length > 0 && sessionToken && (
        <FileAttachmentBar
          files={files}
          sessionId={sessionId}
          sessionToken={sessionToken}
        />
      )}

      {/* Chat area */}
      <div
        ref={chatAreaRef}
        className="chat-scroll-area"
        style={styles.chatArea}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {messages.map((msg, i) => {
          if (msg.content === '__completion__') {
            return (
              <div key={i} style={styles.completionCard}>
                <h2 style={styles.completionHeading}>Thanks — your feedback has been captured.</h2>
                <p style={styles.completionBody}>
                  Your responses have been shared with the team.
                </p>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <a href={`/s/${sessionId}/summary`} style={styles.completionLink}>
                    View session summary →
                  </a>
                  <button
                    type="button"
                    onClick={() => window.close()}
                    style={{
                      background: 'transparent',
                      border: '1px solid #3a3a3a',
                      color: '#888',
                      fontSize: '0.875rem',
                      borderRadius: '8px',
                      padding: '0.25rem 0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            )
          }

          if (msg.role === 'reviewer') {
            return (
              <div key={i} style={styles.messageRowReviewer}>
                <ChatBubble type="reviewer">{msg.content}</ChatBubble>
              </div>
            )
          }

          if (msg.role === 'error') {
            return (
              <div key={i}>
                <ChatBubble type="error">
                  {msg.content}
                  {sessionExpired && (
                    <a href="https://pulse.urgdstudios.com" style={styles.expiredLink}>
                      Go to pulse.urgdstudios.com
                    </a>
                  )}
                </ChatBubble>
              </div>
            )
          }

          if (msg.role === 'content') {
            return (
              <div key={i}>
                <ChatBubble type="content">{msg.content}</ChatBubble>
              </div>
            )
          }

          // agent — strip section/completion tags, then split into multi-bubble groups
          const cleaned = msg.content
            .replace(/\[SECTION:\d+\]/g, '')
            .replace(/\[SESSION_COMPLETE\]/g, '')
            .trim()
          const paragraphs = cleaned.split(/\n\n+/).map(p => p.trim()).filter(Boolean)

          // Group short consecutive paragraphs into a single bubble to avoid over-fragmentation.
          // Paragraphs under 160 chars merge unless the current buffer ends with a question
          // (questions are natural pause points and should stand alone).
          const grouped: string[] = []
          let buffer = ''
          for (const para of paragraphs) {
            if (!buffer) {
              buffer = para
            } else if (buffer.length < 160 && para.length < 160 && !buffer.endsWith('?')) {
              buffer += '\n\n' + para
            } else {
              grouped.push(buffer)
              buffer = para
            }
          }
          if (buffer) grouped.push(buffer)

          return grouped.map((text, pi) => (
            <div key={`${i}-${pi}`} style={{
              ...styles.messageRow,
              ...(pi > 0 ? { marginTop: '-0.5rem' } : {}),
            }}>
              {pi === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                  <PulseDot state="idle" />
                  <span style={{ fontSize: '0.625rem', color: '#555', letterSpacing: '0.04em', fontWeight: 500 }} aria-hidden="true">Pulse</span>
                </div>
              ) : (
                <div style={{ width: '28px', flexShrink: 0 }} />
              )}
              <ChatBubble type="agent">{text}</ChatBubble>
            </div>
          ))
        })}

        {isThinking && <ThinkingIndicator />}
      </div>

      {/* Input area */}
      {isComplete ? (
        <div style={styles.sessionCompleteCaption}>Session complete</div>
      ) : (
        <div style={styles.inputArea}>
          <textarea
            ref={inputRef}
            style={{
              ...styles.input,
              ...(inputFocused ? styles.inputFocused : {}),
            }}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            aria-label="Your message"
            placeholder={
              closingState === 'closed'
                ? 'Session complete'
                : isPaused
                ? 'Session paused — come back to continue.'
                : sessionExpired
                ? 'This session has expired.'
                : 'Share your thoughts…'
            }
            disabled={inputDisabled}
            rows={1}
          />
          <button
            type="button"
            style={{
              ...styles.sendButton,
              ...(inputDisabled || !inputValue.trim() ? styles.sendButtonDisabled : {}),
            }}
            onClick={handleSend}
            disabled={inputDisabled || !inputValue.trim()}
            aria-label="Send message"
          >
            ↑
          </button>
        </div>
      )}

      {/* Exit sheet */}
      {showExitSheet && (
        <ExitSheet
          tenantName={itemName ?? 'the team'}
          sessionId={sessionId}
          sessionToken={sessionToken ?? ''}
          onSubmit={handleSubmitFeedback}
          onDiscard={handleDiscard}
          onKeepGoing={() => setShowExitSheet(false)}
        />
      )}
    </div>
  )
}
