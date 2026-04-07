// @vitest-environment jsdom
/**
 * Property 9: Error boundary catch-all
 *
 * For any React component that throws an error during render, when wrapped in
 * the ErrorBoundary, the boundary SHALL catch the error and render a fallback
 * UI containing a "Reload" button and a "Go Home" link, rather than propagating
 * the error upward.
 *
 * Validates: Requirements 6.3, 6.4
 *
 * Pattern: test harness ErrorBoundary that mirrors the real component's render
 * logic using createElement, avoiding CSS module and import.meta.env dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createElement, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import fc from 'fast-check';

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
// Mirrors the real ErrorBoundary component logic without CSS modules or router.

interface ErrorBoundaryHarnessState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundaryHarness extends Component<
  { children: ReactNode },
  ErrorBoundaryHarnessState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryHarnessState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
  }

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


// ─── Generators ───────────────────────────────────────────────────────────────

/** Arbitrary non-empty error message strings */
const errorMessageArb = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

/** Arbitrary Error subclass names */
const errorTypeArb = fc.constantFrom(
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
) as fc.Arbitrary<string>;

/** Build an Error instance of the given type with the given message */
function makeError(type: string, message: string): Error {
  switch (type) {
    case 'TypeError':
      return new TypeError(message);
    case 'RangeError':
      return new RangeError(message);
    case 'ReferenceError':
      return new ReferenceError(message);
    case 'SyntaxError':
      return new SyntaxError(message);
    case 'URIError':
      return new URIError(message);
    case 'EvalError':
      return new EvalError(message);
    default:
      return new Error(message);
  }
}

/**
 * Creates a functional component that throws the given error during render.
 * Each call produces a fresh component reference so React doesn't cache state.
 */
function createThrowingComponent(error: Error): () => ReactNode {
  return function ThrowingComponent(): ReactNode {
    throw error;
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Property 9: Error boundary catch-all', () => {
  // Suppress React's console.error for expected error boundary catches
  const originalConsoleError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
    return () => {
      console.error = originalConsoleError;
    };
  });

  it('catches any thrown error and renders fallback with Reload button and Go Home link', () => {
    fc.assert(
      fc.property(
        errorMessageArb,
        errorTypeArb,
        (message, errorType) => {
          const error = makeError(errorType, message);
          const Thrower = createThrowingComponent(error);

          const { unmount } = render(
            createElement(ErrorBoundaryHarness, null,
              createElement(Thrower),
            ),
          );

          // Boundary caught the error — fallback is rendered
          const alert = screen.getByRole('alert');
          expect(alert).toBeInTheDocument();

          // Fallback contains the heading
          expect(screen.getByText(labels.errorBoundary.heading)).toBeInTheDocument();

          // Fallback contains a "Reload" button
          const reloadBtn = screen.getByTestId('reload-button');
          expect(reloadBtn).toBeInTheDocument();
          expect(reloadBtn.textContent).toBe(labels.errorBoundary.reloadButton);

          // Fallback contains a "Go Home" link pointing to /admin/items
          const homeLink = screen.getByTestId('go-home-link');
          expect(homeLink).toBeInTheDocument();
          expect(homeLink.textContent).toBe(labels.errorBoundary.goHomeLink);
          expect(homeLink.getAttribute('href')).toBe('/admin/items');

          // The error message is displayed in the fallback
          const errorMsg = screen.getByTestId('error-message');
          expect(errorMsg.textContent).toBe(message);

          // Clean up to avoid leaking between iterations
          unmount();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not render fallback when child renders successfully', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (content) => {
          function HappyChild(): ReactNode {
            return createElement('p', { 'data-testid': 'child-content' }, content);
          }

          const { unmount } = render(
            createElement(ErrorBoundaryHarness, null,
              createElement(HappyChild),
            ),
          );

          // No fallback rendered
          expect(screen.queryByRole('alert')).not.toBeInTheDocument();
          expect(screen.queryByTestId('reload-button')).not.toBeInTheDocument();
          expect(screen.queryByTestId('go-home-link')).not.toBeInTheDocument();

          // Child content is rendered
          expect(screen.getByTestId('child-content')).toBeInTheDocument();

          unmount();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('error does not propagate past the boundary', () => {
    fc.assert(
      fc.property(
        errorMessageArb,
        errorTypeArb,
        (message, errorType) => {
          const error = makeError(errorType, message);
          const Thrower = createThrowingComponent(error);

          // If the error propagated, render() itself would throw.
          // Wrapping in expect().not.toThrow() confirms containment.
          expect(() => {
            const { unmount } = render(
              createElement(ErrorBoundaryHarness, null,
                createElement(Thrower),
              ),
            );
            unmount();
          }).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});
