/** Student entry point: no development capabilities, even in a test host. */
import type { ExtensionContext } from "vscode";
import { activateHost } from "./extension-host";
export async function activate(context: ExtensionContext): Promise<void> {
  await activateHost(context);
}
