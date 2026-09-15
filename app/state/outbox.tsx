import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRevalidator } from "react-router";
import {
  dismissError,
  enqueue,
  snapshot,
  startOutbox,
  subscribe,
  type OutboxState,
  type Write,
} from "~/lib/outbox";

/**
 * The queue, as the screens see it.
 *
 * Two jobs. Screens call `send` instead of posting, and read `pending` to
 * overlay what hasn't landed yet. The header reads the counts, which is the
 * honest version of the status chip that used to be there: a number of things
 * this device still owes the server, rather than a background engine's mood.
 *
 * A revalidation follows the queue emptying, so loader data becomes the truth
 * again and the optimistic overlay has nothing left to add.
 */
interface OutboxContext extends OutboxState {
  send: (write: Write) => void;
  dismiss: () => void;
}

const Context = createContext<OutboxContext | null>(null);

export function OutboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OutboxState>(() => snapshot());
  const revalidator = useRevalidator();

  useEffect(() => subscribe(setState), []);
  useEffect(() => startOutbox(), []);

  // When the last write lands, take the server's word for everything.
  //
  // The *transition* to empty, not the state of being empty — which is what a
  // page with nothing queued is from its first render, so keying on the state
  // alone meant every load spent a second round-trip re-fetching what it had
  // just been served.
  const empty = state.pending.length === 0;
  const wasEmpty = useRef(empty);
  useEffect(() => {
    if (empty && !wasEmpty.current) revalidator.revalidate();
    wasEmpty.current = empty;
    // Revalidating is the effect; the revalidator identity is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty]);

  const value = useMemo<OutboxContext>(
    () => ({
      ...state,
      send: useCallbackSend,
      dismiss: dismissError,
    }),
    [state],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

const useCallbackSend = (write: Write) => enqueue(write);

export function useOutbox(): OutboxContext {
  const value = useContext(Context);
  if (!value) throw new Error("useOutbox used outside OutboxProvider");
  return value;
}

/** Just the queue, for the pending overlay. */
export function usePending() {
  return useOutbox().pending;
}

/** Convenience for screens that only write. */
export function useSend(): (write: Write) => void {
  const { send } = useOutbox();
  return useCallback((write: Write) => send(write), [send]);
}
