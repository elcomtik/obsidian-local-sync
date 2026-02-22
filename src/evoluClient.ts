
import { createEvolu, SimpleName } from "@evolu/common";
import { evoluWebDeps } from "@evolu/web";
import { Schema } from "./schema";

export function createEvoluClient(appName: string, relayUrl: string) {
  return createEvolu(evoluWebDeps)(Schema, {
    name: SimpleName.orThrow(appName),
    transports: [{ type: "WebSocket", url: relayUrl }]
  });
}
