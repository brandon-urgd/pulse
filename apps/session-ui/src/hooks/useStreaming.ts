// useStreaming — consumes a streaming fetch response, strips control tags, emits events

const TAG_SECTION = /\[SECTION:(\d+)\]/g
const TAG_COMPLETE = /\[SESSION_COMPLETE\]/g
const BUFFER_SIZE = 20
const TIMEOUT_MS = 15_000

export interface StreamingCallbacks {
  onToken: (text: string) => void
  onSection: (n: number) => void
  onComplete: (fullText: string) => void
  onError: (err: Error) => void
}

/**
 * Strip all control tags from a string, firing onSection for each [SECTION:N].
 */
function stripTags(
  text: string,
  onSection: (n: number) => void
): string {
  // Extract section numbers before stripping
  let match: RegExpExecArray | null
  const re = /\[SECTION:(\d+)\]/g
  while ((match = re.exec(text)) !== null) {
    onSection(parseInt(match[1], 10))
  }
  return text.replace(TAG_SECTION, '').replace(TAG_COMPLETE, '')
}

/**
 * Consume a streaming fetch Response, stripping control tags via a 20-char
 * tail buffer and emitting callbacks for tokens, section changes, completion,
 * and errors.
 */
export async function consumeStream(
  response: Response,
  callbacks: StreamingCallbacks
): Promise<void> {
  const { onToken, onSection, onComplete, onError } = callbacks

  if (!response.body) {
    onError(new Error('Response body is null — streaming not supported'))
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let completed = false

  function resetTimeout() {
    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true
        reader.cancel().catch(() => {})
        onError(new Error('No tokens received for 15 seconds'))
      }
    }, TIMEOUT_MS)
  }

  resetTimeout()

  try {
    let firstChunk = true

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      resetTimeout()

      const chunk = decoder.decode(value, { stream: true })
      buffer += chunk

      // Detect error JSON on first chunk — Lambda writes error as a single JSON object
      // and ends the stream. The HTTP status is 200 (streaming wrapper), so we must
      // detect the error in-band.
      if (firstChunk) {
        firstChunk = false
        try {
          const parsed = JSON.parse(buffer)
          if (parsed.error === true && parsed.statusCode) {
            completed = true
            if (timeoutId) clearTimeout(timeoutId)
            const err = new Error(parsed.message ?? 'Request failed') as Error & { status: number }
            err.status = parsed.statusCode
            onError(err)
            return
          }
        } catch {
          // Not valid JSON — continue normal streaming
        }
      }

      // Flush all but trailing BUFFER_SIZE chars
      if (buffer.length > BUFFER_SIZE) {
        const safe = buffer.slice(0, -BUFFER_SIZE)
        buffer = buffer.slice(-BUFFER_SIZE)
        const stripped = stripTags(safe, onSection)
        if (stripped) {
          fullText += stripped
          onToken(stripped)
        }
      }
    }

    // Final flush — strip tags from remaining buffer
    if (!completed) {
      const stripped = stripTags(buffer, onSection)
      if (stripped) {
        fullText += stripped
        onToken(stripped)
      }
      buffer = ''

      // Check for session complete in the full raw stream
      // (the tag may have been in the buffer)
      completed = true
      if (timeoutId) clearTimeout(timeoutId)
      onComplete(fullText)
    }
  } catch (err) {
    if (!completed) {
      completed = true
      if (timeoutId) clearTimeout(timeoutId)
      onError(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
