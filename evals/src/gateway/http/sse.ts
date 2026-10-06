export type SseEvent = {
  readonly event: string;
  readonly data: string;
};

export class SseEventParser {
  private readonly decoder = new TextDecoder();
  private lineBuffer = "";
  private eventName = "message";
  private dataLines: string[] = [];

  push(chunk: Uint8Array): readonly SseEvent[] {
    this.lineBuffer += this.decoder.decode(chunk, { stream: true });
    return this.drainLines(false);
  }

  finish(): readonly SseEvent[] {
    this.lineBuffer += this.decoder.decode();
    return this.drainLines(true);
  }

  private drainLines(flush: boolean): readonly SseEvent[] {
    const events: SseEvent[] = [];
    while (true) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.acceptLine(line, events);
    }

    if (flush && this.lineBuffer.length > 0) {
      let line = this.lineBuffer;
      this.lineBuffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.acceptLine(line, events);
    }
    if (flush) this.emit(events);
    return events;
  }

  private acceptLine(line: string, events: SseEvent[]): void {
    if (line.length === 0) {
      this.emit(events);
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      this.eventName = value || "message";
    } else if (field === "data") {
      this.dataLines.push(value);
    }
  }

  private emit(events: SseEvent[]): void {
    if (this.dataLines.length > 0) {
      events.push({ event: this.eventName, data: this.dataLines.join("\n") });
    }
    this.eventName = "message";
    this.dataLines = [];
  }
}
