import {
  createPlanewardAppForWindow,
  type CreatePlanewardAppOptions,
  type PlanewardApp,
} from "./client";

export type { CreatePlanewardAppOptions, PlanewardApp } from "./client";
export {
  APP_MESSAGE,
  APP_SDK_PROTOCOL_VERSION,
  type AppContext,
  type AppErrorMessage,
  type AppReadyMessage,
  type AppTheme,
  type AppThemeMessage,
  type AppTokenMessage,
  type AppTokenRequestMessage,
  type AppToHostMessage,
  type AppView,
  type AppViewerRole,
  type HostToAppMessage,
} from "./protocol";

/**
 * Start the iframe handshake with the Planeward host. Call it in the browser
 * (for example inside `useEffect`); importing this module is SSR-safe.
 */
export function createPlanewardApp(
  options: CreatePlanewardAppOptions = {}
): PlanewardApp {
  if (typeof window === "undefined") {
    throw new Error(
      "createPlanewardApp() must run in the browser, not during server rendering."
    );
  }
  // Not framed: fail `ready` immediately instead of waiting for the timeout.
  const timeoutMs = window.parent === window ? 0 : options.timeoutMs;
  return createPlanewardAppForWindow(window, { ...options, timeoutMs });
}
