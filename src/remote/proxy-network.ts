import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { z } from "zod";

export const initializeHttpNetworking = (): void => {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    install();
  } catch {
    throw new Error("Could not initialize proxy networking");
  }
};

export const relayProxyAgent = (
  websocketUrl: string,
  signal: AbortSignal
): HttpsProxyAgent<string> | undefined => {
  const target = new URL(websocketUrl);
  target.protocol = target.protocol === "wss:" ? "https:" : "http:";
  const proxy = getProxyForUrl(target.toString());
  if (!proxy) {
    return undefined;
  }
  const parsed = z.url().safeParse(proxy);
  if (!parsed.success) {
    throw new Error("Invalid relay proxy URL");
  }
  const { protocol } = new URL(parsed.data);
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("Relay proxy must use HTTP or HTTPS");
  }
  const proxyUrl = new URL(parsed.data);
  const authorization =
    proxyUrl.username || proxyUrl.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}`
      : undefined;
  proxyUrl.username = "";
  proxyUrl.password = "";
  proxyUrl.pathname = "/";
  proxyUrl.search = "";
  proxyUrl.hash = "";
  const headers = authorization ? { "Proxy-Authorization": authorization } : {};
  return new HttpsProxyAgent(proxyUrl, { headers, signal });
};
