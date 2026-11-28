/**
 * `@stitchmux/client/socket`: the typed control client over the local daemon's Unix socket, for Bun
 * and Node. It finds the socket from this machine's configuration, so it reads the home directory,
 * the environment and the machine's config file — which is why it is its own entry point: the package
 * root carries the contract, the schemas and the injected-transport client and runs in a browser.
 */
export {
  type ControlClientOptions,
  ControlClientOptionsSchema,
  createControlClient,
  createControlProxy,
} from './control/transport/client.ts';
