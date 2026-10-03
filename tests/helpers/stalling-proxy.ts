import net from "node:net";

export interface StallingProxy {
  port: number;
  readonly connectionCount: number;
  stall(): void;
  resume(): void;
  close(): Promise<void>;
}

/**
 * TCP proxy in front of a relay port that can stop forwarding data in both directions while
 * keeping the sockets open, which is what a sleeping Mac or a dropped NAT entry looks like to
 * the agent: no `close`, no error, no responses.
 */
export async function startStallingProxy(targetPort: number): Promise<StallingProxy> {
  let stalled = false;
  let connectionCount = 0;
  const pairs: { client: net.Socket; upstream: net.Socket }[] = [];

  const server = net.createServer((client) => {
    connectionCount += 1;
    const upstream = net.connect(targetPort, "127.0.0.1");
    pairs.push({ client, upstream });
    client.on("data", (chunk) => {
      if (!stalled) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!stalled) client.write(chunk);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    get connectionCount(): number {
      return connectionCount;
    },
    stall: () => {
      stalled = true;
    },
    resume: () => {
      stalled = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const pair of pairs) {
          pair.client.destroy();
          pair.upstream.destroy();
        }
        server.close(() => resolve());
      }),
  };
}
