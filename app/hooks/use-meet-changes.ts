import { useEffect, useRef } from "react";
import { apiUrl } from "~/lib/http";

const RECONNECT_MS = [1000, 3000, 8000, 20_000];

function wsUrl(meetId: string): string {
  const url = new URL(apiUrl(`/api/meets/${encodeURIComponent(meetId)}/live`), location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * "Something changed on this meet" — nothing more.
 *
 * For a screen that already has its own well-shaped way of reading the meet
 * (the timer's `fetchSnapshot`, purpose-built for a phone behind one lane)
 * and just needs to know *when* to call it again, rather than a cached copy
 * of the DO's own tables to merge broadcasts into — that's `useMeetLive`.
 * This is what replaces a blind poll: connect, and call `onChange` whenever
 * the socket (re)opens or a broadcast arrives, on the theory that a message
 * missed while reconnecting is exactly what the next read catches anyway.
 */
export function useMeetChanges(
  meetId: string | undefined,
  onChange: () => void,
): void {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    if (!meetId) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl(meetId));
      ws.addEventListener("open", () => {
        attempt = 0;
        latest.current();
      });
      ws.addEventListener("message", () => latest.current());
      ws.addEventListener("close", () => {
        if (closed) return;
        const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
        attempt += 1;
        reconnectTimer = setTimeout(open, delay);
      });
      ws.addEventListener("error", () => ws?.close());
    };
    open();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [meetId]);
}
