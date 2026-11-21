import type { Action, Conversation, Snapshot, Tick } from './types';

// The live link to server.mjs: the SSE stream (snapshots and ticks), actions,
// and the conversation endpoint. The token comes from the page's meta tag.

const TOKEN_PLACEHOLDER = '__SWITCHBOARD_TOKEN__';

export interface Live {
  onSnapshot: (s: Snapshot) => void;
  onTick: (t: Tick) => void;
  onStatus: (s: 'connecting' | 'live' | 'retrying' | 'restarted') => void;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class SwitchboardClient {
  private readonly token: string;
  private source: EventSource | null = null;

  constructor() {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="switchboard-token"]');
    const t = meta?.content ?? '';
    this.token = t && t !== TOKEN_PLACEHOLDER ? t : '';
  }

  /** False in `vite` dev mode, where no server filled in the token. */
  get connected() {
    return this.token !== '';
  }

  connect(live: Live) {
    if (!this.token) return;
    live.onStatus('connecting');
    const es = new EventSource(`/api/stream?token=${encodeURIComponent(this.token)}`);
    this.source = es;
    es.addEventListener('open', () => live.onStatus('live'));
    es.addEventListener('snapshot', (e) => live.onSnapshot(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('tick', (e) => live.onTick(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('error', async () => {
      // A restarted server has a new token: the stream is refused for good, so reload.
      const res = await fetch('/', { method: 'HEAD', cache: 'no-store' }).catch(() => null);
      if (res?.ok && es.readyState === EventSource.CLOSED) live.onStatus('restarted');
      else live.onStatus('retrying');
    });
  }

  close() {
    this.source?.close();
    this.source = null;
  }

  async act(action: Action): Promise<{ ok: true; note?: string }> {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Switchboard-Token': this.token },
      body: JSON.stringify(action),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error || `The server said ${res.status}.`, res.status);
    return body;
  }

  async conversation(surfaceId: string): Promise<Conversation> {
    const res = await fetch(`/api/conversation?surfaceId=${encodeURIComponent(surfaceId)}`, {
      headers: { 'X-Switchboard-Token': this.token },
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error || `The server said ${res.status}.`, res.status);
    return body;
  }
}
