import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { labels } from '../config/labels-registry';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * Wraps any route that requires valid Cognito tokens.
 * Redirects to /admin/login if the user is not authenticated.
 * Requirements: 3.25
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <div aria-live="polite">{labels.protectedRoute.redirecting}</div>;
  }

  if (!user) {
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
