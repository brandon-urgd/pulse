// ErrorBoundary — route-level crash recovery
// Requirements: 6.3, 6.4, 6.5

import React from 'react';
import { Link } from 'react-router-dom';
import { labels } from '../config/labels-registry';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
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

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const t = labels.errorBoundary;

    return (
      <div className={styles.container} role="alert">
        <div className={styles.card}>
          <h2 className={styles.heading}>{t.heading}</h2>
          <p className={styles.body}>{t.body}</p>

          {this.state.error?.message && (
            <p className={styles.errorMessage}>{this.state.error.message}</p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.reloadBtn}
              onClick={this.handleReload}
            >
              {t.reloadButton}
            </button>
            <Link to="/admin/items" className={styles.homeLink}>
              {t.goHomeLink}
            </Link>
          </div>
        </div>
      </div>
    );
  }
}
