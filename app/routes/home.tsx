import { Navigate } from "react-router";

/** The app opens on the schedule; there's no separate dashboard. */
export default function Home() {
  return <Navigate to="/meets" replace />;
}
