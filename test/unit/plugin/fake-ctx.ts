import type {
  Callback,
  ContextEvent,
  ExecuteAfterEvent,
  HostPorts,
  HttpRequestEvent,
  Registration,
} from "../../../src/plugin/ports";

/** Event payload per hook kind handled by the fake host. */
export interface FakeEventMap {
  context: ContextEvent;
  executeAfter: ExecuteAfterEvent;
  httpRequest: HttpRequestEvent;
}
export type FakeHookKind = keyof FakeEventMap;

export interface FakeLogEntry {
  level: "warn" | "error";
  message: string;
}

interface Entry<E> {
  readonly cb: Callback<E>;
}

type EntryLists = { [K in FakeHookKind]: Array<Entry<FakeEventMap[K]>> };

export interface FakeHost {
  /** Ports handed to the plugin under test. */
  readonly ports: HostPorts;
  /** Runs the registered callbacks of each kind in registration order, awaiting each; resolves to the same event. */
  readonly fire: {
    context(event: ContextEvent): Promise<ContextEvent>;
    executeAfter(event: ExecuteAfterEvent): Promise<ExecuteAfterEvent>;
    httpRequest(event: HttpRequestEvent): Promise<HttpRequestEvent>;
  };
  /** Everything written through `ports.log`, in order. */
  readonly logs: FakeLogEntry[];
  /** Number of currently active (not disposed) registrations across all kinds. */
  readonly registrations: number;
  /** Registers a neighbour callback (e.g. another plugin) sharing the same ordered list. */
  register<K extends FakeHookKind>(kind: K, cb: Callback<FakeEventMap[K]>): Registration;
}

export function createFakeHost(): FakeHost {
  const lists: EntryLists = { context: [], executeAfter: [], httpRequest: [] };
  const logs: FakeLogEntry[] = [];

  function register<K extends FakeHookKind>(kind: K, cb: Callback<FakeEventMap[K]>): Registration {
    const list: Array<Entry<FakeEventMap[K]>> = lists[kind];
    const entry: Entry<FakeEventMap[K]> = { cb };
    list.push(entry);
    return {
      dispose: async (): Promise<void> => {
        const index = list.indexOf(entry);
        if (index !== -1) list.splice(index, 1);
      },
    };
  }

  async function fire<K extends FakeHookKind>(kind: K, event: FakeEventMap[K]): Promise<FakeEventMap[K]> {
    const list: Array<Entry<FakeEventMap[K]>> = lists[kind];
    for (const entry of [...list]) {
      await entry.cb(event);
    }
    return event;
  }

  const ports: HostPorts = {
    onContext: async (cb) => register("context", cb),
    onExecuteAfter: async (cb) => register("executeAfter", cb),
    onHttpRequest: async (cb) => register("httpRequest", cb),
    log: (level, message) => {
      logs.push({ level, message });
    },
  };

  return {
    ports,
    fire: {
      context: (event) => fire("context", event),
      executeAfter: (event) => fire("executeAfter", event),
      httpRequest: (event) => fire("httpRequest", event),
    },
    logs,
    get registrations(): number {
      return lists.context.length + lists.executeAfter.length + lists.httpRequest.length;
    },
    register,
  };
}
