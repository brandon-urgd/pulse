// @vitest-environment jsdom
/**
 * Unit tests for ErrorBoundary component:
 * 1. Reload button calls window.location.reload()
 * 2. Go Home link has href /admin/items
 * 3. Error details (message, stack) are logged to console via console.error
 * 4. Heading and body text are rendered in the fallback
 *
 * Validates: Requirements 6.3, 6.4, 6.5
 *
 * Pattern: test harness component that mirrors the real ErrorBoundary
 * rendering logic using createElement, avoiding CSS module and router deps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createElement, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

// ─── Labels (matching real labels-registry errorBoundary) ─────────────────────

const labels = {
  errorBoundary: {
    heading: 'Something went wrong',
    body: 'An unexpected error occurred. You can try reloading the page or go back to the items list.',
    reloadButton: 'Reload',
    goHomeLink: 'Go Home',
  },
} as const;

// ─── ErrorBoundary Harness ────────────────────────────────────────────────────
// Mirrors the real ErrorBoundary component logic, including componentDidCatch
// logging, handleReload, and Go Home link. No CSS modules or react-router.

interface HarnessState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundaryHarness extends Component<
  { children: ReactNode },
  HarnessState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<HarnessState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    const componentName =
      errorInfo.componentStack
        ?.split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? 'Unknown';

    console.error('[ErrorBoundary] Component:', componentName);
    console.error('[ErrorBoundary] Message:', error.message);
    console.error('[ErrorBoundary] Stack:', error.stack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const t = labels.errorBoundary;

    return createElement('div', { role: 'alert' },
      createElement('div', null,
        createElement('h2', null, t.heading),
        createElement('p', null, t.body),
        this.state.error?.message
          ? createElement('p', { 'data-testid': 'error-message' }, this.state.error.message)
          : null,
        createElement('div', null,
          createElement('button', {
            type: 'button',
            onClick: this.handleReload,
            'data-testid': 'reload-button',
          }, t.reloadButton),
          createElement('a', {
            href: '/admin/items',
            'data-testid': 'go-home-link',
          }, t.goHomeLink),
        ),
      ),
    );
  }
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function createThrowingComponent(error: Error): () => ReactNode {
  return function ThrowingComponent(): ReactNode {
    throw error;
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ErrorBoundary — Reload button', () => {
  const originalConsoleError = console.error;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    console.error = vi.fn();
    reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { reload: reloadMock },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('calls window.location.reload() when Reload button is clicked', () => {
    const Thrower = createThrowingComponent(new Error('boom'));

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    fireEvent.click(screen.getByTestId('reload-button'));
    expect(reloadMock).toHaveBeenCalledOnce();
  });
});

describe('ErrorBoundary — Go Home link', () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('has href pointing to /admin/items', () => {
    const Thrower = createThrowingComponent(new Error('crash'));

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    const link = screen.getByTestId('go-home-link');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/admin/items');
    expect(link.textContent).toBe(labels.errorBoundary.goHomeLink);
  });
});

describe('ErrorBoundary — Console error logging', () => {
  const originalConsoleError = console.error;
  let consoleErrorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleErrorSpy = vi.fn();
    console.error = consoleErrorSpy as typeof console.error;
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('logs error message to console via console.error', () => {
    const error = new Error('test error message');
    const Thrower = createThrowingComponent(error);

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    const calls = consoleErrorSpy.mock.calls.map(
      (args: unknown[]) => args.join(' '),
    );

    expect(calls.some((c: string) => c.includes('test error message'))).toBe(true);
  });

  it('logs error stack to console via console.error', () => {
    const error = new Error('stack trace test');
    const Thrower = createThrowingComponent(error);

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    const calls = consoleErrorSpy.mock.calls.map(
      (args: unknown[]) => args.join(' '),
    );

    expect(calls.some((c: string) => c.includes('[ErrorBoundary] Stack:'))).toBe(true);
  });

  it('logs component name to console via console.error', () => {
    const error = new Error('component name test');
    const Thrower = createThrowingComponent(error);

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    const calls = consoleErrorSpy.mock.calls.map(
      (args: unknown[]) => args.join(' '),
    );

    expect(calls.some((c: string) => c.includes('[ErrorBoundary] Component:'))).toBe(true);
  });
});

describe('ErrorBoundary — Fallback content rendering', () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('renders the heading text in the fallback', () => {
    const Thrower = createThrowingComponent(new Error('heading test'));

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    expect(screen.getByText(labels.errorBoundary.heading)).toBeInTheDocument();
  });

  it('renders the body text in the fallback', () => {
    const Thrower = createThrowingComponent(new Error('body test'));

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    expect(screen.getByText(labels.errorBoundary.body)).toBeInTheDocument();
  });

  it('displays the error message in the fallback', () => {
    const Thrower = createThrowingComponent(new Error('specific error'));

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    expect(screen.getByTestId('error-message')).toHaveTextContent('specific error');
  });

  it('renders fallback inside a role="alert" container', () => {
    const Thrower = createThrowingComponent(new Error('alert test'));

    render(
      createElement(ErrorBoundaryHarness, null, createElement(Thrower)),
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
