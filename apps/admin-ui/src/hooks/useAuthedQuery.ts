import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useNavigate } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

async function authedFetch(url: string, navigate: ReturnType<typeof useNavigate>): Promise<unknown> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) {
    navigate('/admin/login');
    throw new Error('No access token');
  }

  let res = await fetch(`${API_BASE}${url}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 || res.status === 403) {
    // Silent refresh — API Gateway Lambda authorizers return 403 on expired tokens
    try {
      const refreshed = await fetchAuthSession({ forceRefresh: true });
      const newToken = refreshed.tokens?.accessToken?.toString();
      if (!newToken) throw new Error('Refresh failed');
      res = await fetch(`${API_BASE}${url}`, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      // If still 403 after refresh, it's a real permission error — let it fall through
    } catch {
      navigate('/admin/login');
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error((body as { error?: string }).error ?? res.statusText), {
      status: res.status,
    });
  }

  return res.json();
}

export function useAuthedQuery<TData = unknown>(
  key: readonly unknown[],
  url: string,
  options?: Omit<UseQueryOptions<TData>, 'queryKey' | 'queryFn'>
): UseQueryResult<TData> {
  const navigate = useNavigate();

  return useQuery<TData>({
    queryKey: key,
    queryFn: () => authedFetch(url, navigate) as Promise<TData>,
    ...options,
  });
}
