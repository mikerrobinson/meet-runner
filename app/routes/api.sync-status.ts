import type { Route } from "./+types/api.sync-status";
import { errorResponse, json, requireAuth, type SyncEnv } from "~/lib/api.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  try {
    requireAuth(request, env);
  } catch {
    return json({ enabled: false, reason: "A sync token is required" });
  }

  if (!env.DB) {
    return json({
      enabled: false,
      reason: "no D1 database bound (expected a binding named DB)",
    });
  }

  try {
    return json({ enabled: true });
  } catch (error) {
    return errorResponse(error);
  }
}
