import { createCorsProxy, type ProxyEnvironment } from "./src/proxy.ts";

// Spacefast's standalone worker signature. No Node APIs or runtime packages.
export default {
  fetch(request: Request, env: ProxyEnvironment): Promise<Response> {
    return createCorsProxy({ env })(request);
  },
};
