import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  basename: "/projects/meet-runner/",

  /**
   * Ship the whole route manifest with the document.
   *
   * By default React Router discovers routes lazily: the first navigation to
   * any new *pathname* fetches a patch of the manifest for it. That is a good
   * trade for a large site and the wrong one here, twice over. A timer walking
   * heat to heat visits a new pathname every heat — `/timer/7/1/3`,
   * `/timer/8/1/3` — so every one of them cost a request; and out of signal
   * that request fails and takes the navigation down with it, which is the
   * whole reason the timing screens hold their meet in memory.
   *
   * This app has a couple of dozen routes and the manifest is a few KB. It
   * goes down once with the page, and after that moving around the app asks
   * the network for nothing it doesn't need.
   */
  routeDiscovery: { mode: "initial" },
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
