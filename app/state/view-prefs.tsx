import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { loadLaneLayout, saveLaneLayout } from "~/lib/storage";
import type { LaneLayout } from "~/types/meet";

/**
 * How this device likes to look at things, as opposed to what's true about a
 * meet. Lives here rather than in the meet document so it survives to the next
 * meet and doesn't sync — one coach's layout isn't another's.
 *
 * The controls for these sit in the header, centred, so they cost no vertical
 * space on the screens that need every pixel.
 */
interface ViewPrefs {
  laneLayout: LaneLayout;
  setLaneLayout: (layout: LaneLayout) => void;
}

const ViewPrefsContext = createContext<ViewPrefs | null>(null);

export function ViewPrefsProvider({ children }: { children: ReactNode }) {
  // Starts at the default and adopts the stored value once mounted: the
  // server can't read localStorage, and guessing would mismatch on hydration.
  const [laneLayout, setLayout] = useState<LaneLayout>("grid");

  useEffect(() => {
    setLayout(loadLaneLayout());
  }, []);

  const value = useMemo<ViewPrefs>(
    () => ({
      laneLayout,
      setLaneLayout: (next) => {
        setLayout(next);
        saveLaneLayout(next);
      },
    }),
    [laneLayout],
  );

  return (
    <ViewPrefsContext.Provider value={value}>
      {children}
    </ViewPrefsContext.Provider>
  );
}

export function useViewPrefs(): ViewPrefs {
  const value = useContext(ViewPrefsContext);
  if (!value) throw new Error("useViewPrefs used outside ViewPrefsProvider");
  return value;
}
