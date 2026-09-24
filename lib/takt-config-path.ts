import { homedir } from "node:os";
import { join } from "node:path";

export function configRoot(env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === "win32"
    ? env.APPDATA || join(homedir(), "AppData", "Roaming")
    : env.XDG_CONFIG_HOME || join(homedir(), ".config");
}
