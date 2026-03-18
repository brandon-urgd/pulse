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

  const makeRequest = (t: string) =>
    fetch(`${API_BASE}${url}`, { headers: { Authorization: `Bearer ${t}` } });

  let res = await makeRequest(token);

  // API Gateway Lambda authorizers return 403 (not 401) for expired tokens — try refresh first
  if (res.status === 401 || res.status === 403) {
    try {
      const refreshed = await fetchAuthSession({ forceRefresh: true });
      const newToken = refreshed.tokens?.accessToken?.toString();
      if (!newToken) throw new Error('Refresh failed');
      res = await makeRequest(newToken);
    } catch {
      // Refresh failed — session is truly expired, redirect outside render cycle
      setTimeout(() => navigate('/admin/login'), 0);
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
