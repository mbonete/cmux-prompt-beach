import { ApiError, type SwitchboardClient } from '../data/client';
import type { Action, Conversation } from '../data/types';
import type { Toasts } from '../ui/toasts';

// Every action goes through here: one place for the busy state on the button,
// the confirmation toast and the error message the server sends back.

export class Actions {
  constructor(
    private readonly client: SwitchboardClient,
    private readonly toasts: Toasts,
  ) {}

  get connected() {
    return this.client.connected;
  }

  /** Runs an action; returns true when the server accepted it. */
  async run(action: Action, ok: string | null, btn?: HTMLButtonElement | null): Promise<boolean> {
    if (!this.client.connected) {
      this.toasts.show({ tone: 'error', icon: 'warning', text: 'Not connected to the Switchboard server.' });
      return false;
    }
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    }
    try {
      const res = await this.client.act(action);
      if (ok || res.note) this.toasts.show({ tone: 'info', icon: 'check', text: ok ?? 'Done', detail: res.note });
      return true;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'The server could not be reached.';
      this.toasts.show({ tone: 'error', icon: 'warning', text: msg });
      return false;
    } finally {
      if (btn?.isConnected) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
  }

  conversation(surfaceId: string): Promise<Conversation> {
    return this.client.conversation(surfaceId);
  }
}
