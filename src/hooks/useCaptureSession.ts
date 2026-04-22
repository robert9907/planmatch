import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CaptureItem, CaptureStartResponse, CaptureStatus } from '@/types/capture';
import { pollCapture, startCapture } from '@/lib/captureApi';

export interface IncomingQueueItem extends CaptureItem {
  decision: 'pending' | 'approved' | 'rejected';
}

export interface UseCaptureSessionResult {
  token: string | null;
  link: string | null;
  status: CaptureStatus | 'inactive';
  startedAt: string | null;
  expiresAt: string | null;
  smsError: string | null;
  clientName: string | null;
  lastPollAt: number | null;
  queue: IncomingQueueItem[];
  pendingCount: number;
  approvedCount: number;
  isStarting: boolean;
  startError: string | null;
  start: (input: { client_name?: string; client_phone: string; send_sms?: boolean }) => Promise<CaptureStartResponse | null>;
  approve: (itemId: string) => IncomingQueueItem | null;
  reject: (itemId: string) => void;
  reset: () => void;
}

export function useCaptureSession(): UseCaptureSessionResult {
  const [token, setToken] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
  const [queue, setQueue] = useState<IncomingQueueItem[]>([]);
  const [status, setStatus] = useState<CaptureStatus | 'inactive'>('inactive');
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());
  const lastSeenAtRef = useRef<string | null>(null);
  // Mirror of `queue` state available synchronously so the approve
  // handler can return the newly-approved item before the next render.
  // React 18 runs setState functional updaters at flush-time, not
  // during the setState call — reading `approved` from inside a
  // `setQueue(prev => …)` closure and then `return approved`
  // always returned null, which is why the captured medication
  // detected "ADDED TO SESSION" but never made it into the session
  // store (addMedication was skipped by the caller's `if (!approved)`
  // guard).
  const queueRef = useRef<IncomingQueueItem[]>([]);

  const pollQuery = useQuery({
    queryKey: ['capture-poll', token, lastSeenAtRef.current],
    queryFn: () => (token ? pollCapture(token, lastSeenAtRef.current ?? undefined) : null),
    enabled: !!token && status !== 'expired' && status !== 'completed',
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const data = pollQuery.data;
    if (!data) return;
    setStatus(data.status);
    setClientName(data.client_name);
    if (data.new_items?.length) {
      setQueue((prev) => {
        const next = [...prev];
        for (const item of data.new_items) {
          if (seenIds.current.has(item.id)) continue;
          seenIds.current.add(item.id);
          next.unshift({ ...item, decision: 'pending' });
        }
        return next;
      });
      const newestAt = data.new_items.reduce(
        (acc, it) => (acc && acc > it.created_at ? acc : it.created_at),
        lastSeenAtRef.current,
      );
      lastSeenAtRef.current = newestAt;
    }
  }, [pollQuery.data]);

  // Keep queueRef in sync with queue state so approve() can read the
  // current item synchronously without depending on when React
  // flushes functional updaters.
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const start = useCallback(
    async (input: { client_name?: string; client_phone: string; send_sms?: boolean }) => {
      setIsStarting(true);
      setStartError(null);
      try {
        const resp = await startCapture(input);
        setToken(resp.token);
        setLink(resp.link);
        setStartedAt(resp.created_at);
        setExpiresAt(resp.expires_at);
        setStatus(resp.status);
        setClientName(input.client_name ?? null);
        setQueue([]);
        seenIds.current = new Set();
        lastSeenAtRef.current = null;
        setSmsError(resp.sms && 'error' in resp.sms ? resp.sms.error : null);
        return resp;
      } catch (err) {
        setStartError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setIsStarting(false);
      }
    },
    [],
  );

  const approve = useCallback((itemId: string): IncomingQueueItem | null => {
    const current = queueRef.current.find((q) => q.id === itemId);
    if (!current) return null;
    // Ignore double-taps on an already-decided item so a fast second
    // click can't add the same medication twice to the session store.
    if (current.decision !== 'pending') return null;
    const approved: IncomingQueueItem = { ...current, decision: 'approved' };
    setQueue((prev) => prev.map((q) => (q.id === itemId ? approved : q)));
    queueRef.current = queueRef.current.map((q) => (q.id === itemId ? approved : q));
    return approved;
  }, []);

  const reject = useCallback((itemId: string) => {
    setQueue((prev) =>
      prev.map((q) => (q.id === itemId ? { ...q, decision: 'rejected' } : q)),
    );
  }, []);

  const reset = useCallback(() => {
    setToken(null);
    setLink(null);
    setStartedAt(null);
    setExpiresAt(null);
    setSmsError(null);
    setClientName(null);
    setQueue([]);
    setStatus('inactive');
    seenIds.current = new Set();
    lastSeenAtRef.current = null;
  }, []);

  const pendingCount = queue.filter((q) => q.decision === 'pending').length;
  const approvedCount = queue.filter((q) => q.decision === 'approved').length;

  return {
    token,
    link,
    status,
    startedAt,
    expiresAt,
    smsError,
    clientName,
    lastPollAt: pollQuery.dataUpdatedAt || null,
    queue,
    pendingCount,
    approvedCount,
    isStarting,
    startError,
    start,
    approve,
    reject,
    reset,
  };
}
