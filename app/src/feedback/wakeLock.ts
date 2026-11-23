/** Keeps the screen on during a session; iOS suspends Bluetooth when it locks. */
export interface ScreenLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Screen Wake Lock API. The browser drops the lock whenever the page is
 * hidden, so it is re-acquired when the page becomes visible again.
 */
export class BrowserScreenLock implements ScreenLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  constructor(doc: Document = document) {
    doc.addEventListener('visibilitychange', () => {
      if (this.wanted && doc.visibilityState === 'visible') void this.request();
    });
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    await this.request();
  }

  async release(): Promise<void> {
    this.wanted = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    await sentinel?.release();
  }

  private async request(): Promise<void> {
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Denied (low battery, unsupported browser): the session still works
      // as long as the user keeps the screen on.
    }
  }
}

export const NO_SCREEN_LOCK: ScreenLock = {
  acquire: () => Promise.resolve(),
  release: () => Promise.resolve(),
};
