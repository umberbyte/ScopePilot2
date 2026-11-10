export async function toolJson<T>(apiBase: string, path: string, body?: unknown, method: 'GET' | 'POST' = 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    ...(body === undefined && method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

