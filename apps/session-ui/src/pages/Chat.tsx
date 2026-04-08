import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSession } from '../context/SessionContext'
import {
  deleteSessionTranscript,
  getSessionState,
  reportSessionCompletion,
  sendChatMessage,
  sendChatMessageStreaming,
} from '../api/session'
import { consumeStream } from '../hooks/useStreaming'
import ChatBubble from '../components/ChatBubble'
import { ScanLineIcon } from '../components/ScanLineIcon'
import PulseLine from '../components/PulseLine'
import FileAttachmentBar from '../components/FileAttachmentBar'
import ThinkingIndicator from '../components/ThinkingIndicator'
import ExitSheet from '../components/ExitSheet'
import StreamingBubble from '../components/StreamingBubble'
import ImagePanel from '../components/ImagePanel'
import ExpandableImageHeader from '../components/ExpandableImageHeader'
import CompletionCard from '../components/CompletionCard'
import { useInteractionTimer } from '../hooks/useInteractionTimer'

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
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-body)',
    minWidth: '375px',
  },
  topBar: {
    height: '48px',
    background: 'var(--color-bg)',
    borderBottom: '1px solid var(--color-border)',
    padding: '0 1rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  },
  wordmark: {
    color: 'var(--color-accent)',
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
    color: 'var(--color-text-muted)',
  },
  endSessionButton: {
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-muted)',
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
    overflowX: 'hidden' as const,
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    boxSizing: 'border-box' as const,
    minWidth: 0,
  },
  messageRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '0.5rem',
    minWidth: 0,
    maxWidth: '100%',
  },
  messageRowReviewer: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  inputArea: {
    borderTop: '1px solid var(--color-border)',
    padding: '0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom, 0px))',
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'flex-end',
    background: 'var(--color-bg)',
    flexShrink: 0,
    boxSizing: 'border-box' as const,
    minWidth: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: '48px',
    borderRadius: '24px',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    color: 'var(--color-text-primary)',
    fontSize: '0.9375rem',
    padding: '0.75rem 1rem',
    resize: 'none' as const,
    fontFamily: 'inherit',
    lineHeight: 1.5,
    boxSizing: 'border-box' as const,
  },
  inputFocused: {
    border: '1px solid var(--color-accent-deep)',
  },
  sendButton: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    background: 'var(--color-accent-deep)',
    border: 'none',
    color: 'var(--color-text-white)',
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
    color: 'var(--color-text-muted)',
    textAlign: 'center' as const,
    padding: '1rem 1rem calc(1rem + env(safe-area-inset-bottom, 0px))',
    borderTop: '1px solid var(--color-border)',
  },
  completionCard: {
    background: 'var(--color-accent-subtle)',
    borderLeft: '3px solid var(--color-accent-deep)',
    borderRadius: 'var(--radius-lg)',
    padding: '1rem 1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  completionHeading: {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--color-text-white)',
    margin: 0,
  },
  completionBody: {
    fontSize: '0.875rem',
    color: 'var(--color-text-secondary)',
    margin: 0,
    lineHeight: 1.6,
  },
  completionLink: {
    color: 'var(--color-accent)',
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
    color: 'var(--color-accent)',
    fontWeight: 700,
    letterSpacing: '0.05em',
    fontSize: '1.25rem',
    marginBottom: '0.5rem',
  },
  discardedHeading: {
    fontSize: '1.125rem',
    fontWeight: 600,
    color: 'var(--color-text-white)',
    margin: 0,
  },
  discardedBody: {
    fontSize: '0.875rem',
    color: 'var(--color-text-muted)',
    margin: 0,
    lineHeight: 1.6,
    maxWidth: '320px',
  },
  discardedLink: {
    color: 'var(--color-accent)',
    fontSize: '0.875rem',
    textDecoration: 'none',
  },
  expiredLink: {
    color: 'var(--color-accent)',
    fontSize: '0.875rem',
    textDecoration: 'none',
    display: 'block',
    marginTop: '0.5rem',
  },
  previewBanner: {
    background: 'var(--color-accent-subtle)',
    borderBottom: '1px solid rgba(74, 124, 89, 0.25)',
    padding: '0.5rem 1rem',
    fontSize: '0.8125rem',
    color: 'var(--color-text-secondary)',
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

  // Image session state
  const [itemType, setItemType] = useState<'document' | 'image'>('document')
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')

  const chatAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number | null>(null)

  // ── Interaction timer (engagement-aware session pacing) ─────────────────────
  const { cumulativeMs, wallClockMs } = useInteractionTimer()
  const completionReportedRef = useRef(false)

  // ── Document title ──────────────────────────────────────────────────────────
  useEffect(() => {
    document.title = 'Session — Pulse'
  }, [])

  // ── Report interaction timing on session completion ─────────────────────────
  useEffect(() => {
    if (sessionStatus !== 'complete' || completionReportedRef.current) return
    if (!sessionToken || !sessionId) return
    completionReportedRef.current = true
    reportSessionCompletion(sessionId, sessionToken, {
      interactionTimeMs: cumulativeMs,
      wallClockTimeMs: wallClockMs,
    }).catch(() => { /* best-effort — don't block completion UX */ })
  }, [sessionStatus, sessionId, sessionToken, cumulativeMs, wallClockMs])

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
        if (state.itemType) setItemType(state.itemType)
        if (state.imageUrl) setImageUrl(state.imageUrl)

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
        } else if (state.status === 'completed' || state.status === 'complete') {
          setSessionStatus('complete')
          setMessages([...existingMessages, { role: 'content', content: '__completion__' }])
        } else if (state.status === 'expired') {
          setSessionExpired(true)
          setSessionStatus('in_progress')
          setMessages([...existingMessages, {
            role: 'error',
            content: 'This session has expired. The close date has passed.',
          }])
        } else if (state.status === 'discarded' || state.status === 'cancelled') {
          setSessionStatus('discarded')
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

  // Refresh presigned image URL when it expires (1-hour TTL)
  async function refreshImageUrl() {
    if (!sessionToken || !sessionId) return
    try {
      const state = await getSessionState(sessionId, sessionToken)
      if (state.imageUrl) setImageUrl(state.imageUrl)
    } catch { /* best-effort */ }
  }

  function handleSendError(status: number | undefined, currentMessages: Message[]) {
    if (status === 401) {
      navigate(`/s/${sessionId}`)
      return
    }
    if (status === 403 && !isPreview) {
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
    if (!text || !sessionToken || isThinking || isStreaming || sessionStatus !== 'in_progress') return

    const userMsg: Message = { role: 'reviewer', content: text }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInputValue('')
    setIsStreaming(true)
    setStreamingText('')
    startTimer()

    try {
      const wd = windingDown ?? undefined
      const response = await sendChatMessageStreaming(sessionId, sessionToken, text, wd as 'true' | 'final' | undefined)

      let sessionComplete = false
      let fullText = ''

      await consumeStream(response, {
        onToken: (tokenText) => {
          setStreamingText((prev) => prev + tokenText)
        },
        onSection: (n) => {
          setCurrentSection(n)
        },
        onComplete: (completedText) => {
          fullText = completedText
          sessionComplete = true
        },
        onError: (err) => {
          // Check for status-based errors that need redirects (from in-stream error JSON)
          const status = (err as Error & { status?: number }).status
          if (status === 401 || status === 403 || status === 410) {
            setIsStreaming(false)
            setStreamingText('')
            handleSendError(status, nextMessages)
            return
          }
          // Preserve partial text as an agent message, then show error
          const partialText = fullText || ''
          const partialMessages = partialText
            ? [...nextMessages, { role: 'agent' as const, content: partialText }]
            : nextMessages
          setMessages([
            ...partialMessages,
            { role: 'error' as const, content: err.message + ' Tap retry to try again.' },
          ])
          setIsStreaming(false)
          setStreamingText('')
        },
      })

      if (sessionComplete) {
        // Stream completed successfully — add agent message
        const agentMsg: Message = { role: 'agent', content: fullText }
        const finalMessages = [...nextMessages, agentMsg]
        setMessages(finalMessages)
        setStreamingText('')
        setIsStreaming(false)

        // Check if session is complete (the [SESSION_COMPLETE] tag was detected)
        // We detect this by checking if the raw stream contained the tag
        // The consumeStream already stripped it, but onComplete fires after
        // For now, fall back to the non-streaming response check
        // The backend will also update session status
        try {
          const state = await getSessionState(sessionId, sessionToken)
          if (state.closingState) setClosingState(state.closingState)
          if (state.status === 'completed' || state.status === 'complete') {
            setSessionStatus('complete')
            if (timerRef.current) clearInterval(timerRef.current)
            setMessages([...finalMessages, { role: 'content', content: '__completion__' }])
          }
        } catch {
          // Best-effort state refresh
        }
      }
    } catch (err) {
      const status = (err as Error & { status?: number }).status
      setIsStreaming(false)
      setStreamingText('')
      handleSendError(status, nextMessages)
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
  // isPaused: only lock the session when the backend explicitly pauses it.
  // closingState === 'closed' no longer pauses here — the Lambda now marks
  // the session as completed when the grace window expires, so isComplete
  // handles that case. This prevents the dead-state bug where the input was
  // disabled but no completion card was shown.
  const isPaused = sessionStatus === 'paused'
  const isComplete = sessionStatus === 'complete'
  const isDiscarded = sessionStatus === 'discarded'
  const isLoading = sessionStatus === 'loading'

  const inputDisabled = isThinking || isStreaming || isComplete || isPaused || isDiscarded || isLoading || sessionExpired
  const showEndSessionButton =
    sessionStatus === 'in_progress' && !isThinking && !isStreaming && !isPaused && !isComplete && !isDiscarded && !sessionExpired



  // PulseLine animation slows during closing state
  const pulseLineAnimation = closingState === 'closing' ? '4s' : animationDuration

  // ── Discarded state ─────────────────────────────────────────────────────────
  if (isDiscarded) {
    return (
      <div style={styles.page}>
        <a href="#main-content" className="skip-nav">Skip to main content</a>
        <div style={styles.topBar}>
          <span style={styles.wordmark}>pulse</span>
        </div>
        <main id="main-content" style={styles.discardedPage}>
          <div style={styles.discardedWordmark}>pulse</div>
          <h1 style={styles.discardedHeading}>Your session was discarded.</h1>
          <p style={styles.discardedBody}>
            Your responses have been removed and won't be shared.
          </p>
          <p style={styles.discardedBody}>
            You can start a new session if the item is still open.
          </p>
          <button
            type="button"
            onClick={() => navigate(`/s/${sessionId}`)}
            style={{
              background: 'var(--color-accent-deep)',
              color: 'var(--color-text-white)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '0.625rem 1.25rem',
              fontSize: '0.9375rem',
              fontWeight: 600,
              cursor: 'pointer',
              marginTop: '0.5rem',
            }}
          >
            Start over
          </button>
        </main>
      </div>
    )
  }

  // ── Main render ─────────────────────────────────────────────────────────────
  return (
    <div style={styles.page}>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      {/* Hide desktop image panel on mobile */}
      <style>{`
        @media (max-width: 768px) {
          .image-panel-desktop { display: none !important; }
        }
        @media (min-width: 769px) {
          .image-header-mobile { display: none !important; }
        }
        @media (min-width: 769px) and (max-width: 1024px) and (orientation: portrait) {
          .image-panel-desktop {
            width: 100% !important;
            max-height: 45vh !important;
            flex-shrink: 0 !important;
          }
          .split-pane-wrapper {
            flex-direction: column !important;
          }
        }
      `}</style>
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
          {/* "Wrapping up" indicator — only shown during closing state.
             The countdown was removed: time limit is an internal pacing guide
             for the agent, not a visible clock for the reviewer. */}
          {closingState === 'closing' && !isComplete && !isPaused && !isDiscarded && (
            <span style={styles.timeDisplay} aria-hidden="true">
              Wrapping up
            </span>
          )}
          {isPreview ? (
            <button
              type="button"
              style={styles.endSessionButton}
              onClick={() => { window.close(); if (!window.closed) navigate('/') }}
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
          ) : (isComplete || sessionExpired) ? (
            <button
              type="button"
              style={styles.endSessionButton}
              onClick={() => navigate(`/s/${sessionId}/summary`)}
            >
              Close
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

      {/* Progress line — hidden when totalSections === 1 (image items, single-section docs) */}
      {totalSections > 1 && (
        <div style={styles.pulseLineWrapper}>
          <PulseLine
            current={isComplete ? totalSections : currentSection}
            total={totalSections}
            animationDuration={pulseLineAnimation}
          />
        </div>
      )}

      {/* Expandable image header — mobile image sessions */}
      {itemType === 'image' && imageUrl && (
        <div className="image-header-mobile">
          <ExpandableImageHeader imageUrl={imageUrl} onImageError={refreshImageUrl} />
        </div>
      )}

      {/* File attachment bar */}
      {files.length > 0 && sessionToken && (
        <FileAttachmentBar
          files={files}
          sessionId={sessionId}
          sessionToken={sessionToken}
        />
      )}

      {/* Split-pane wrapper for image sessions (desktop) */}
      <div className="split-pane-wrapper" style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
      }}>
        {/* Desktop image panel — hidden on mobile via media query inline */}
        {itemType === 'image' && imageUrl && (
          <div className="image-panel-desktop" style={{
            width: '60%',
            minWidth: '320px',
            flexShrink: 0,
            borderRight: '1px solid var(--color-border)',
            overflow: 'hidden',
            alignSelf: 'stretch',
          }}>
            <ImagePanel imageUrl={imageUrl} onImageError={refreshImageUrl} />
          </div>
        )}

        {/* Chat column */}
        <main id="main-content" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', overflow: 'hidden', minWidth: 0, maxWidth: '100%', contain: 'inline-size' as const }}>
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
            if (isPreview) {
              // Preview sessions: simple end message, no summary link
              return (
                <div key={i} style={styles.completionCard}>
                  <h2 style={styles.completionHeading}>Preview complete.</h2>
                  <p style={styles.completionBody}>This is how the session would end for a reviewer.</p>
                  <button
                    type="button"
                    onClick={() => { window.close(); if (!window.closed) navigate('/') }}
                    style={{ background: 'transparent', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-muted)', fontSize: '0.875rem', borderRadius: 'var(--radius-md)', padding: '0.25rem 0.75rem', cursor: 'pointer' }}
                  >
                    Close preview
                  </button>
                </div>
              )
            }
            return (
              <CompletionCard
                key={i}
                sessionId={sessionId}
              />
            )
          }

          // Determine if this is the first message in a cluster from the same role
          const prevMsg = messages[i - 1]
          const isFirstInCluster = !prevMsg || prevMsg.role !== msg.role || prevMsg.content === '__completion__'

          if (msg.role === 'reviewer') {
            return (
              <div key={i} style={{ ...styles.messageRowReviewer, ...(isFirstInCluster ? {} : { marginTop: '-0.375rem' }) }}>
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

          // agent — strip section/completion tags, render as single bubble
          const cleaned = msg.content
            .replace(/\[SECTION:\d+\]/g, '')
            .replace(/\[SESSION_COMPLETE\]/g, '')
            .trim()

          if (!cleaned) return null

          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', ...(isFirstInCluster ? {} : { marginTop: '-0.375rem' }) }}>
              {/* Name label — only on first message in an agent cluster */}
              {isFirstInCluster && (
                <span style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', fontWeight: 500, marginLeft: '36px', letterSpacing: '0.02em' }}>
                  Pulse
                </span>
              )}
              <div style={styles.messageRow}>
                {isFirstInCluster ? (
                  <div style={{ flexShrink: 0, width: '28px', display: 'flex', justifyContent: 'center', overflow: 'hidden' }}>
                    <ScanLineIcon size={28} />
                  </div>
                ) : (
                  <div style={{ width: '28px', flexShrink: 0 }} />
                )}
                <ChatBubble type="agent">{cleaned}</ChatBubble>
              </div>
            </div>
          )
        })}

        {isThinking && <ThinkingIndicator />}
        {isStreaming && streamingText && <StreamingBubble text={streamingText} />}
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
              isPaused
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
        </main>{/* end chat column */}
      </div>{/* end split-pane wrapper */}

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
