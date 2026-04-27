import {
  compact,
  currentRouteStatus,
  handshakeTrace,
  openOrReuseHandshake,
  requireOpenHandshake,
  setPhase,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";

export async function openRouteStep({ config, ctx }) {
  setPhase("step-open-route");
  const { connectionHandshake, channelHandshake } = await openOrReuseHandshake(config, ctx);
  const routeStatus = await currentRouteStatus(config, ctx);
  return writeTracePatch(
    config,
    ctx,
    {
      handshake: {
        ...handshakeTrace(config, connectionHandshake, channelHandshake),
        ready: routeStatus.ready,
        sourceRouteOpen: routeStatus.sourceRouteOpen,
        destinationRouteOpen: routeStatus.destinationRouteOpen,
      },
    },
    {
      phase: "route-ready",
      label: "Opened IBC connection and channel",
      summary:
        `Connection ${routeStatus.connection.sourceStateName}/${routeStatus.connection.destinationStateName}, ` +
        `channel ${routeStatus.channel.sourceStateName}/${routeStatus.channel.destinationStateName}.`,
    }
  );
}

export { compact, requireOpenHandshake };
