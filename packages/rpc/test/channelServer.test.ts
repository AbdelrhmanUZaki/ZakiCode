import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannelClient,
  ChannelServer,
  DisposableStore,
  Emitter,
  Event,
  ProxyChannel,
  createQueuePair,
} from "../src/index.js";

const flush = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface PingService {
  onPing: Event<string>;
  ping(): Promise<string>;
}

/** Client-side view for dynamic events that may not exist on the server. */
type DynamicEventAccessor = Record<string, (arg?: unknown) => Event<unknown>>;

function setup(timeoutDelay = 1000) {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const disposables = new DisposableStore();
  const _onPing = new Emitter<string>();
  const service: PingService = {
    onPing: _onPing.event,
    ping: async () => "pong",
  };
  const server = new ChannelServer(serverProtocol, "test", timeoutDelay);
  server.registerChannel("pingService", ProxyChannel.fromService(service, disposables));
  const client = new ChannelClient(clientProtocol);
  return { server, client, _onPing, disposables };
}

test("event-listen for a missing event must not terminate the server", async (t) => {
  const errorMock = t.mock.method(console, "error", () => undefined);
  const { server, client, disposables } = setup();
  await Event.toPromise(client.onDidInitialize);
  const calls = ProxyChannel.toService<PingService>(client.getChannel("pingService"));
  const dynamic = ProxyChannel.toService<DynamicEventAccessor>(client.getChannel("pingService"));

  // Mirrors the 2026-09-25 incident: the desktop host subscribed to the dynamic
  // onDynamicBrowserRelayRequest event of an older deployed server bundle. The
  // server-side throw used to escape onRawMessage uncaught and kill the process.
  const subscription = dynamic.onDynamicMissingThing()(() => undefined);
  await flush();

  assert.ok(
    errorMock.mock.calls.some((call) =>
      call.arguments.join(" ").includes('event listen failed on channel "pingService"'),
    ),
    "server should log the failed event listen",
  );
  assert.equal(await calls.ping(), "pong", "server must keep answering calls");

  subscription.dispose();
  client.dispose();
  server.dispose();
  disposables.dispose();
});

test("failed event subscription sends no wire response to the client", async () => {
  const { server, client, disposables } = setup();
  await Event.toPromise(client.onDidInitialize);
  const dynamic = ProxyChannel.toService<DynamicEventAccessor>(client.getChannel("pingService"));

  // An error frame would be misread as event data (event ids share the promise
  // id namespace and the client handler is type-blind), so silence is the rule.
  let received: unknown = "unset";
  const subscription = dynamic.onDynamicMissingThing()((data) => {
    received = data;
  });
  await flush(50);

  assert.equal(received, "unset");

  subscription.dispose();
  client.dispose();
  server.dispose();
  disposables.dispose();
});

test("existing events still fire end-to-end", async () => {
  const { client, _onPing, server, disposables } = setup();
  await Event.toPromise(client.onDidInitialize);
  const calls = ProxyChannel.toService<PingService>(client.getChannel("pingService"));

  const received = Event.toPromise(calls.onPing);
  await flush();
  _onPing.fire("hello");

  assert.equal(await received, "hello");

  client.dispose();
  server.dispose();
  disposables.dispose();
});

test("unknown channel promise rejects after timeout and the server survives", async () => {
  const { client, server, disposables } = setup(100);
  await Event.toPromise(client.onDidInitialize);
  const missing = ProxyChannel.toService<PingService>(client.getChannel("nopeService"));
  const live = ProxyChannel.toService<PingService>(client.getChannel("pingService"));

  await assert.rejects(() => missing.ping());
  assert.equal(await live.ping(), "pong");

  client.dispose();
  server.dispose();
  disposables.dispose();
});

test("unknown channel event listen stays silent and the server survives", async () => {
  const { client, server, disposables } = setup(100);
  await Event.toPromise(client.onDidInitialize);
  const dynamicMissing = ProxyChannel.toService<DynamicEventAccessor>(
    client.getChannel("nopeService"),
  );
  const live = ProxyChannel.toService<PingService>(client.getChannel("pingService"));

  let received: unknown = "unset";
  const subscription = dynamicMissing.onDynamicAnything()((data) => {
    received = data;
  });
  await flush(150);

  assert.equal(received, "unset");
  assert.equal(await live.ping(), "pong");

  subscription.dispose();
  client.dispose();
  server.dispose();
  disposables.dispose();
});
