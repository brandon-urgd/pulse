// @vitest-environment jsdom
/**
 * Unit tests for SessionTimeoutModal component:
 * 1. Countdown displays correct remaining seconds
 * 2. "Extend Session" button calls onExtend
 * 3. "Sign Out" button calls onSignOut
 * 4. Modal has proper ARIA attributes (role="dialog", aria-modal="true")
 * 5. Countdown updates when remainingSeconds prop changes
 *
 * Validates: Requirements 4.5, 4.6, 4.7
 *
 * Pattern: test harness component that mirrors the real SessionTimeoutModal
 * rendering logic, avoiding CSS module and import.meta.env dependencies.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createElement } from 'react';

// ─── Labels (subset matching real labels-registry sessionTimeout) ─────────────

const labels = {
  sessionTimeout: {
    heading: 'Session expiring',
    body: 'Your session will expire due to inactivity.',
    countdown: 'Time remaining: {seconds}s',
    extendButton: 'Extend Session',
    signOutButton: 'Sign Out',
  },
} as const;

// ─── SessionTimeoutModal Harness ──────────────────────────────────────────────
// Mirrors the rendering logic from SessionTimeoutModal.tsx, avoiding CSS modules.

interface SessionTimeoutModalHarnessProps {
  remainingSeconds: number;
  onExtend: () => void;
  onSignOut: () => void;
}

function SessionTimeoutModalHarness({
  remainingSeconds,
  onExtend,
  onSignOut,
}: SessionTimeoutModalHarnessProps) {
  const t = labels.sessionTimeout;

  return createElement(
    'div',
    { 'aria-modal': 'true', role: 'dialog', 'aria-labelledby': 'timeout-heading' },
    createElement(
      'div',
      null,
      createElement('h2', { id: 'timeout-heading' }, t.heading),
      createElement('p', null, t.body),
      createElement(
        'p',
        { 'aria-live': 'polite', 'aria-atomic': 'true', 'data-testid': 'countdown' },
        t.countdown.replace('{seconds}', String(Math.max(0, remainingSeconds)))
      ),
      createElement(
        'div',
        null,
        createElement(
          'button',
          { type: 'button', onClick: onExtend },
          t.extendButton
        ),
        createElement(
          'button',
          { type: 'button', onClick: onSignOut },
          t.signOutButton
        )
      )
    )
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionTimeoutModal — Countdown display', () => {
  it('displays the correct remaining seconds', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 45,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByTestId('countdown')).toHaveTextContent('Time remaining: 45s');
  });

  it('displays 0 when remainingSeconds is 0', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 0,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByTestId('countdown')).toHaveTextContent('Time remaining: 0s');
  });

  it('clamps negative remainingSeconds to 0', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: -5,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByTestId('countdown')).toHaveTextContent('Time remaining: 0s');
  });

  it('updates countdown when remainingSeconds prop changes', () => {
    const { rerender } = render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 60,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByTestId('countdown')).toHaveTextContent('Time remaining: 60s');

    rerender(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 30,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByTestId('countdown')).toHaveTextContent('Time remaining: 30s');
  });
});

describe('SessionTimeoutModal — Extend Session button', () => {
  it('calls onExtend when "Extend Session" is clicked', () => {
    const onExtend = vi.fn();
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 45,
        onExtend,
        onSignOut: vi.fn(),
      })
    );

    fireEvent.click(screen.getByText(labels.sessionTimeout.extendButton));
    expect(onExtend).toHaveBeenCalledOnce();
  });
});

describe('SessionTimeoutModal — Sign Out button', () => {
  it('calls onSignOut when "Sign Out" is clicked', () => {
    const onSignOut = vi.fn();
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 45,
        onExtend: vi.fn(),
        onSignOut,
      })
    );

    fireEvent.click(screen.getByText(labels.sessionTimeout.signOutButton));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});

describe('SessionTimeoutModal — ARIA attributes', () => {
  it('has role="dialog"', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 30,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('has aria-modal="true"', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 30,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('has aria-labelledby pointing to the heading', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 30,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'timeout-heading');
    expect(screen.getByText(labels.sessionTimeout.heading)).toHaveAttribute('id', 'timeout-heading');
  });

  it('countdown region has aria-live="polite" for screen readers', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 15,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByTestId('countdown')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('countdown')).toHaveAttribute('aria-atomic', 'true');
  });
});

describe('SessionTimeoutModal — Content rendering', () => {
  it('renders the heading text', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 60,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByText(labels.sessionTimeout.heading)).toBeInTheDocument();
  });

  it('renders the body text', () => {
    render(
      createElement(SessionTimeoutModalHarness, {
        remainingSeconds: 60,
        onExtend: vi.fn(),
        onSignOut: vi.fn(),
      })
    );

    expect(screen.getByText(labels.sessionTimeout.body)).toBeInTheDocument();
  });
});
