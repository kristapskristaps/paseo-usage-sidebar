import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readSelectionState, writeSelectionState } from "./server/selection/state";
import { readSelection, writeSelection } from "./shared/selection/contract";
import { readSettingsState, writeSettingsState } from "./server/settings/state";
import { readSettings, writeSettings } from "./shared/usage/settings";
import { readUsage } from "./server/usage/read";
import { listUsage } from "./shared/usage/contract";

/**
 * Server entry: usage, settings, and pin RPC handlers. Everything here needs
 * either Node (local files) or the daemon-side Paseo API.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(listUsage, readUsage);
  server.handle(readSelection, () => readSelectionState());
  server.handle(writeSelection, (input) => writeSelectionState(input));
  server.handle(readSettings, () => readSettingsState());
  server.handle(writeSettings, (input) => writeSettingsState(input));
  return () => {};
}
