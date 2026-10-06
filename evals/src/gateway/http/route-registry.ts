import type { HarnessHttpConfig, HarnessRouteSpec } from "./types.js";

export function getHarnessRoute(
  method: string,
  path: string,
  config: HarnessHttpConfig,
): HarnessRouteSpec | null {
  const normalizedMethod = method.toUpperCase();
  return (
    config.routes.find(
      (route) => route.method === normalizedMethod && route.path === path,
    ) ?? null
  );
}
