import { internalCollectorRuntime } from "./provider.js";

export function getCollectorStatus() {
  return internalCollectorRuntime.getCollectorStatus();
}

export async function runCollectorTick(options = {}) {
  return internalCollectorRuntime.runCollectorTick(options);
}
