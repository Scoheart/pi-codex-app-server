import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";

import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { initializeHttpNetworking } from "../src/remote/proxy-network.js";

describe("HTTP proxy environment", () => {
  test("standalone HTTP requests honor the proxy environment", async () => {
    const origin = createServer((_request, response) =>
      response.end("via-origin")
    );
    let proxied = 0;
    const proxy = createServer((_request, response) => {
      proxied += 1;
      response.end("via-proxy");
    });
    proxy.on("connect", (request, socket, head) => {
      proxied += 1;
      const address = new URL(`http://${request.url}`);
      const upstream = connect(Number(address.port), address.hostname, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) {
          upstream.write(head);
        }
        socket.pipe(upstream).pipe(socket);
      });
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    });
    const address = z.object({ port: z.number() });
    origin.listen(0, "127.0.0.1");
    proxy.listen(0, "127.0.0.1");
    await Promise.all([once(origin, "listening"), once(proxy, "listening")]);
    const beforeFetch = globalThis.fetch;
    const beforeDispatcher = getGlobalDispatcher();
    for (const key of [
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
      "npm_config_proxy",
      "npm_config_no_proxy",
    ]) {
      vi.stubEnv(key, "");
      Reflect.deleteProperty(process.env, key);
    }
    vi.stubEnv(
      "HTTP_PROXY",
      `http://127.0.0.1:${address.parse(proxy.address()).port}`
    );
    vi.stubEnv("NO_PROXY", "");
    initializeHttpNetworking();
    const dispatcher = getGlobalDispatcher();
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.parse(origin.address()).port}`,
        { signal: AbortSignal.timeout(3000) }
      );
      await expect(response.text()).resolves.toMatch(/^via-(?:origin|proxy)$/u);
      expect(proxied).toBe(1);
    } finally {
      await dispatcher.close();
      setGlobalDispatcher(beforeDispatcher);
      globalThis.fetch = beforeFetch;
      vi.unstubAllEnvs();
      const closed = Promise.all([once(origin, "close"), once(proxy, "close")]);
      origin.close();
      proxy.close();
      await closed;
    }
  });
});
