import { Link, Outlet, useParams } from "react-router";
import { EmptyState } from "~/components/ui";
import { useAppStore } from "~/state/app-store";

/**
 * Guards every screen under /meets/:meetId. Children can rely on the meet
 * existing rather than each null-checking it.
 */
export default function MeetLayout() {
  const { meets } = useAppStore();
  const { meetId } = useParams();
  const meet = meets.find((m) => m.id === meetId);

  if (!meet) {
    return (
      <EmptyState title="That meet isn't on this device">
        It may have been deleted, or belong to another device.{" "}
        <Link to="/meets" className="font-semibold text-blue-600 underline">
          Back to meets
        </Link>
        .
      </EmptyState>
    );
  }

  return <Outlet />;
}
