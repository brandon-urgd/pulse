/**
 * WelcomeAnimation — branded "pulse" splash overlay (Session UI)
 *
 * Sequence: fade-in 800ms → hold 1500ms → fade-out 600ms → onComplete
 * Guards: sessionStorage key prevents replay within same session.
 * Accessibility: prefers-reduced-motion skips animation entirely.
 * Fallback: setTimeout(3000ms) fires onComplete if animationend never fires.
 *
 * Session-UI convention: inline styles, no CSS modules.
 * Keyframes injected once via <style> tag.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
import { useEffect, useRef, useCallback, useState } from 'react';

interface WelcomeAnimationProps {
  onComplete: () => void;
}

const SESSION_KEY = 'pulse-welcome-shown';
const FALLBACK_TIMEOUT = 3000;

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'hsl(225, 25%, 10%)',
};

const wordmarkStyle: React.CSSProperties = {
  fontFamily: "'Rubik', sans-serif",
  fontWeight: 400,
  textTransform: 'lowercase',
  color: 'hsl(220, 14%, 96%)',
  fontSize: 'clamp(1.5rem, 1.143rem + 1.786vw, 2.25rem)',
  letterSpacing: '0.06em',
  margin: 0,
};

const accentLineStyle: React.CSSProperties = {
  width: 60,
  height: 2,
  background: '#7a9e87',
  marginTop: 12,
  border: 'none',
};

/* Keyframe CSS injected once into <head> */
const KEYFRAME_ID = 'welcome-animation-keyframes';
const KEYFRAME_CSS = `
@keyframes welcomeFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes welcomeFadeOut {
  from { opacity: 1; }
  to   { opacity: 0; }
}
`;

function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAME_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAME_ID;
  style.textContent = KEYFRAME_CSS;
  document.head.appendChild(style);
}

export default function WelcomeAnimation({ onComplete }: WelcomeAnimationProps) {
  const firedRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = useState(true);

  const fireOnce = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* private browsing */ }
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    // Guard: already shown this session
    try {
      if (sessionStorage.getItem(SESSION_KEY)) {
        setShouldRender(false);
        fireOnce();
        return;
      }
    } catch { /* sessionStorage unavailable — play animation */ }

    // Reduced motion: skip immediately
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShouldRender(false);
      fireOnce();
      return;
    }

    ensureKeyframes();

    const el = overlayRef.current;
    const handleAnimationEnd = (e: AnimationEvent) => {
      if (e.animationName === 'welcomeFadeOut') {
        fireOnce();
      }
    };

    el?.addEventListener('animationend', handleAnimationEnd);

    // Fallback timeout in case animationend never fires
    const fallback = setTimeout(fireOnce, FALLBACK_TIMEOUT);

    return () => {
      el?.removeEventListener('animationend', handleAnimationEnd);
      clearTimeout(fallback);
    };
  }, [fireOnce]);

  if (!shouldRender) return null;

  return (
    <div
      ref={overlayRef}
      style={{
        ...overlayStyle,
        animation: 'welcomeFadeIn 800ms ease-in forwards, welcomeFadeOut 600ms ease-out 2300ms forwards',
      }}
      role="status"
      aria-live="polite"
      aria-label="Welcome to Pulse"
    >
      <p style={wordmarkStyle}>pulse</p>
      <hr style={accentLineStyle} aria-hidden="true" />
    </div>
  );
}
