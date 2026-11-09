import { spawnSync } from "node:child_process";

import { describe, expect, test } from "vitest";

describe("Proxy diagnostics", () => {
  test("does not expose proxy passwords with dependency debug logging enabled", () => {
    const marker = "SYNTHETIC_PROXY_PASSWORD";
    const script = `const {relayProxyAgent}=await import(${JSON.stringify(new URL("../src/remote/proxy-network.ts", import.meta.url).href)});const agent=relayProxyAgent('ws://127.0.0.1:9/',new AbortController().signal);console.log(Boolean(agent.proxyHeaders['Proxy-Authorization']));agent.destroy();`;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          DEBUG: "https-proxy-agent",
          HTTP_PROXY: `http://user:${marker}@127.0.0.1:12345/`,
          NO_PROXY: "",
          http_proxy: "",
          no_proxy: "",
          npm_config_no_proxy: "",
          npm_config_proxy: "",
        },
        timeout: 3000,
      }
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Creating new HttpsProxyAgent instance");
    expect(result.stderr).not.toContain(marker);
    expect(result.stderr).not.toContain(
      Buffer.from(`user:${marker}`).toString("base64")
    );
    expect(result.stdout.trim()).toBe("true");
  });
});
