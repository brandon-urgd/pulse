import { useMutation, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useNavigate } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

type HttpMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function authedMutate(
  url: string,
  method: HttpMethod,
  body: unknown,
  navigate: ReturnType<typeof useNavigate>
): Promise<unknown> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) {
    navigate('/admin/login');
    throw new Error('No access token');
  }

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  let res = await fetch(`${API_BASE}${url}`, init);

  if (res.status === 401 || res.status === 403) {
    try {
      const refreshed = await fetchAuthSession({ forceRefresh: true });
      const newToken = refreshed.tokens?.accessToken?.toString();
      if (!newToken) throw new Error('Refresh failed');
      res = await fetch(`${API_BASE}${url}`, {
        ...init,
        headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${newToken}` },
      });
      // If still 403 after refresh, it's a real permission error — let it fall through
    } catch {
      navigate('/admin/login');
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw Object.assign(new Error((errBody as { error?: string }).error ?? res.statusText), {
      status: res.status,
    });
  }

  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

export function useAuthedMutation<TData = unknown, TVariables = unknown>(
  url: string,
  method: HttpMethod,
  options?: Omit<UseMutationOptions<TData, Error, TVariables>, 'mutationFn'>
): UseMutationResult<TData, Error, TVariables> {
  const navigate = useNavigate();

  return useMutation<TData, Error, TVariables>({
    mutationFn: (variables) =>
      authedMutate(url, method, variables, navigate) as Promise<TData>,
    ...options,
  });
}
