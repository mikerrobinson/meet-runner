import { createRequestHandler } from "react-router";

export { MeetDurableObject } from "~/lib/meet-do.server";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const BASE_PATH = "/";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isProduction = import.meta.env.MODE === "production";

    // Only apply custom routing in production (Cloudflare Workers)
    if (isProduction) {
      // Redirect base path without trailing slash
      if (url.pathname === BASE_PATH) {
        return Response.redirect(`${url.origin}${BASE_PATH}/`, 301);
      }

      // Only GET/HEAD can name a static asset, and only those are safe to
      // probe: building a Request from another Request hands off the body
      // stream and marks the original as used. React Router rebuilds the
      // request downstream, so a probed POST/PUT would arrive with a spent
      // body and blow up inside the router.
      const couldBeAsset =
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname.startsWith(BASE_PATH) &&
        !url.pathname.startsWith(`${BASE_PATH}/api/`);

      if (couldBeAsset && env.ASSETS) {
        const assetPath = url.pathname.slice(BASE_PATH.length) || "/";
        const assetUrl = new URL(assetPath, url.origin);
        const assetResponse = await env.ASSETS.fetch(
          new Request(assetUrl, request),
        );
        if (assetResponse.status !== 404) {
          return assetResponse;
        }
      }
    }

    // Fall back to React Router for non-asset requests
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;
