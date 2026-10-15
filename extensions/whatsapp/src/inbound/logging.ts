import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";

export function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (enabled) {
    defaultRuntime.log(message);
  }
}
