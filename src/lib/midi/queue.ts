interface QueueItem {
  data: Uint8Array;
  description?: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class MidiTransmissionQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private delayMs = 30; // 30ms delay between successive SysEx packets
  private sendFn: ((data: Uint8Array) => void | Promise<void>) | null = null;

  constructor(delayMs = 30) {
    this.delayMs = delayMs;
  }

  public setSendHandler(fn: ((data: Uint8Array) => void | Promise<void>) | null) {
    this.sendFn = fn;
  }

  public enqueue(data: Uint8Array, description?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, description, resolve, reject });
      this.process();
    });
  }

  public clear(): void {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        item.reject(new Error('Queue cleared'));
      }
    }
  }

  public async waitForDrain(): Promise<void> {
    while (this.queue.length > 0 || this.isProcessing) {
      await new Promise((res) => setTimeout(res, 15));
    }
  }

  private async process(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const current = this.queue.shift();
      if (!current) break;

      try {
        if (this.sendFn) {
          await this.sendFn(current.data);
        }
        current.resolve();
      } catch (err: any) {
        console.error('[MidiQueue] Error sending MIDI message:', err);
        current.reject(err instanceof Error ? err : new Error(String(err)));
      }

      // Enforce the 30ms throttling rate limit between successive SysEx calls
      if (this.delayMs > 0) {
        await new Promise((res) => setTimeout(res, this.delayMs));
      }
    }

    this.isProcessing = false;
  }
}
