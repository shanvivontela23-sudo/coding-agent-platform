export type IncrementalStreamEvidence = {
  readonly dataChunks: number;
  readonly firstChunkAtMs: number;
  readonly secondChunkAtMs: number;
  readonly terminalAtMs: number;
};

export function gatewayUrlFromHostname(hostname: string): string {
  const value = hostname.trim();
  if (!value || value.includes("://") || value.includes("/") || value.includes("?") || value.includes("#") || /\s/.test(value)) {
    throw new Error("GATEWAY_HOSTNAME must be a hostname only, without scheme, path, query, or fragment");
  }
  const url = new URL(`https://${value}`);
  if (url.hostname !== value && url.hostname !== value.toLowerCase()) {
    throw new Error("GATEWAY_HOSTNAME must be a hostname only");
  }
  return `https://${url.hostname}${url.port ? `:${url.port}` : ""}`;
}

function containsTerminalEvent(text: string): boolean {
  return /(?:^|\n)event:\s*message_stop\s*(?:\n|$)/.test(text);
}

export async function assertIncrementalAnthropicStream(
  response: Response,
  clock: () => number = () => performance.now(),
): Promise<IncrementalStreamEvidence> {
  if (!response.ok) throw new Error(`Anthropic tunnel stream returned HTTP ${response.status}`);
  if (!response.body) throw new Error("Anthropic tunnel stream returned no response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let dataChunks = 0;
  let firstChunkAtMs = -1;
  let secondChunkAtMs = -1;
  let terminalAtMs = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const arrivedAt = clock();
    const chunkText = decoder.decode(value, { stream: true });
    if (!chunkText) continue;
    text += chunkText;

    if (!containsTerminalEvent(chunkText)) {
      dataChunks += 1;
      if (dataChunks === 1) firstChunkAtMs = arrivedAt;
      if (dataChunks === 2) secondChunkAtMs = arrivedAt;
    }
    if (containsTerminalEvent(text)) {
      terminalAtMs = arrivedAt;
      break;
    }
  }

  if (dataChunks < 2) throw new Error("tunnel buffered the Anthropic stream: fewer than two data chunks arrived before message_stop");
  if (!(secondChunkAtMs > firstChunkAtMs)) throw new Error("tunnel stream chunks did not arrive at distinct read times");
  if (terminalAtMs < secondChunkAtMs) throw new Error("Anthropic message_stop arrived before two incremental chunks were observed");
  return { dataChunks, firstChunkAtMs, secondChunkAtMs, terminalAtMs };
}
