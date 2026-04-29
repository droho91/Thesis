import {
  compact,
  handshakeTrace,
  openOrReuseHandshake,
  requireOpenHandshake,
  robustCurrentRouteStatus,
  setPhase,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";

export async function openRouteStep({ config, ctx }) {
  setPhase("step-open-route-check");
  const { connectionHandshake, channelHandshake } = await openOrReuseHandshake(config, ctx);
  setPhase("step-open-route-status");
  const routeStatus = await robustCurrentRouteStatus(config, ctx);
  return writeTracePatch(
    config,
    ctx,
    {
      handshake: {
        ...handshakeTrace(config, connectionHandshake, channelHandshake),
        ready: routeStatus.ready,
        degraded: routeStatus.degraded || false,
        readError: routeStatus.readError,
        sourceRouteOpen: routeStatus.sourceRouteOpen,
        destinationRouteOpen: routeStatus.destinationRouteOpen,
      },
    },
    {
      phase: "route-ready",
      label: "Opened IBC connection and channel",
      summary:
        routeStatus.degraded
          ? `Handshake opened/reused; route status read is degraded because Besu returned: ${routeStatus.readError}.`
          : `Connection ${routeStatus.connection.sourceStateName}/${routeStatus.connection.destinationStateName}, ` +
            `channel ${routeStatus.channel.sourceStateName}/${routeStatus.channel.destinationStateName}.`,
    }
  );
}

export { compact, requireOpenHandshake };
