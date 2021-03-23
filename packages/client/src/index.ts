import Debug from "debug";
import { stringify } from "flatted";
import WebSocket from "isomorphic-ws";
import Mocha from "mocha";

type EventMessage = {
  eventName: string;
  args: unknown[];
}

type DisconnectedParams = {
  code: number;
  reason: string;
}

export type RunCallback = (runner: Mocha.Runner) => void;

export interface InstrumentedMocha extends Mocha {
  originalRun: (fn?: (failures: number) => void) => Mocha.Runner;
  onRun?: RunCallback;
}

const debug = Debug("mocha-remote:client");

export interface IMochaRemoteClientConfig {
  autoConnect: boolean;
  /** Fail silently and perform automatic retrying when connecting to the server */
  autoRetry: boolean;
  /** If retrying connecting, delay retrys by this amount of milliseconds */
  retryDelay: number;
  /** The websocket URL of the server, ex: ws://localhost:8090 */
  url: string;
  /** The ID which the server expects */
  id?: string;
  /** Called when the client gets connected to the server */
  onConnected?: (ws: WebSocket) => void;
  /** Called when the client looses connection to the server */
  onDisconnected?: (params: DisconnectedParams) => void;
  /** Called when the client has a new instrumented mocha instance */
  onInstrumented?: (mocha: Mocha) => void;
  /** Called when the server has decided to start running */
  onRunning?: (runner: Mocha.Runner) => void;
  /** Called when the client needs a new Mocha instance */
  createMocha: (config: IMochaRemoteClientConfig) => Mocha;
  /** These options are passed to the Mocha constructor when creating a new instance */
  mochaOptions: Mocha.MochaOptions;
}

const MOCHA_EVENT_NAMES = [
  "start", // `start`  execution started
  "end", // `end`  execution complete
  "suite", // `suite`  (suite) test suite execution started
  "suite end", // (suite) all tests (and sub-suites) have finished
  "test", // (test) test execution started
  "test end", // (test) test completed
  "hook", // (hook) hook execution started
  "hook end", // (hook) hook complete
  "pass", // (test) test passed
  "fail", // (test, err) test failed
  "pending" // (test) test pending
];

export class MochaRemoteClient {
  public static Mocha = Mocha;
  public static DEFAULT_CONFIG: IMochaRemoteClientConfig = {
    autoConnect: true,
    autoRetry: true,
    createMocha: config => new Mocha(config.mochaOptions),
    id: "default",
    mochaOptions: {},
    retryDelay: 500,
    url: "ws://localhost:8090"
  };

  private config: IMochaRemoteClientConfig;
  private ws?: WebSocket;
  private instrumentedMocha?: InstrumentedMocha;
  private retryTimeout?: number;

  constructor(config: Partial<IMochaRemoteClientConfig> = {}) {
    this.config = { ...MochaRemoteClient.DEFAULT_CONFIG, ...config };
    if (typeof WebSocket === "undefined") {
      throw new Error("mocha-remote-client expects a global WebSocket");
    } else if (this.config.autoConnect) {
      this.connect();
    }
  }

  public connect(fn?: () => void): void {
    if (this.ws) {
      throw new Error("Already connected");
    }
    // Prevent a timeout from reconnecting
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
    }
    debug(`Connecting to ${this.config.url}`);
    this.ws = new WebSocket(this.config.url, `mocha-remote-${this.config.id}`);
    this.ws.addEventListener("close", this.onClose);
    this.ws.addEventListener("error", this.onError as any);
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("open", e => {
      debug(`Connected to ${this.config.url}`);
      if (this.config.onConnected) {
        this.config.onConnected(e.target as WebSocket);
      }
      if (fn) {
        fn();
      }
    });
  }

  public disconnect(): void {
    // Prevent a timeout from reconnecting
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
    }
    if (this.ws) {
      debug(`Disconnecting from server`);
      // Stop listening for the closing events to prevent reconnecting
      this.ws.removeEventListener("close", this.onClose);
      this.ws.removeEventListener("error", this.onError as any);
      this.ws.removeEventListener("message", this.onMessage);
      this.ws.close();
      // Forget about the WebSocket
      delete this.ws;
    } else {
      debug(`Disconnecting from server`);
    }
  }

  public instrument(mocha: Mocha): InstrumentedMocha {
    const instrumentedMocha = mocha as InstrumentedMocha;
    // Hang on to this instance
    this.instrumentedMocha = instrumentedMocha;
    // Monkey patch the run method
    instrumentedMocha.originalRun = mocha.run;
    instrumentedMocha.run = () => {
      throw new Error(
        "This Mocha instance is instrumented by mocha-remote-client, use the server to run tests"
      );
    };
    // The reporter method might require files that do not exist when required from a bundle
    instrumentedMocha.reporter = () => {
      // eslint-disable-next-line no-console
      console.warn(
        "This Mocha instance is instrumented by mocha-remote-client, setting a reporter has no effect"
      );
      return instrumentedMocha;
    };
    // Notify that a Mocha instance is now instrumented
    if (this.config.onInstrumented) {
      this.config.onInstrumented(instrumentedMocha);
    }
    // Add this to the list of instrumented mochas
    return instrumentedMocha;
  }

  public run(mocha: InstrumentedMocha): Mocha.Runner {
    // Monkey patch the reporter to a method before running
    const reporter = this.createReporter();
    (mocha as any)._reporter = reporter;
    // Call the original run method
    const runner = mocha.originalRun();
    // Signal that the mocha instance is now running
    if (this.config.onRunning) {
      this.config.onRunning(runner);
    }
    // Return the runner
    return runner;
  }

  public getMocha(): InstrumentedMocha {
    if (this.instrumentedMocha) {
      // Use the latest instrumented mocha instance - if it exists
      return this.instrumentedMocha;
    } else {
      // Create a new Mocha instance
      const mocha = this.config.createMocha(this.config);
      return this.instrument(mocha);
    }
  }

  private send(eventName: string, ...args: unknown[]) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const preparedArgs = this.prepareArgs(args);
      const data = stringify({ eventName, args: preparedArgs });
      debug(`Sending a '${eventName}' message`);
      this.ws.send(data);
    } else {
      throw new Error(`Cannot send ${eventName} WebSocket is closed`);
    }
  }

  private prepareArgs(args: any[]) {
    return args.map(arg => {
      // Stringifing an Error doesn't extract the message or stacktrace
      // @see https://stackoverflow.com/a/18391400/503899
      if (arg instanceof Error) {
        const result: { [k: string]: unknown } = {};
        Object.getOwnPropertyNames(arg).forEach(key => {
          result[key] = (arg as any)[key];
        });
        return result;
      } else {
        return arg;
      }
    });
  }

  private onClose = ({ code, reason }: DisconnectedParams) => {
    debug(`Connection closed: ${reason || "No reason"} (code=${code})`);
    // Forget about the client
    delete this.ws;
    // Try reconnecting
    if (code !== 1000 && this.config.autoRetry) {
      // Try to reconnect
      debug(`Re-connecting in ${this.config.retryDelay}ms`);
      this.retryTimeout = (setTimeout(() => {
        this.connect();
      }, this.config.retryDelay) as unknown) as number;
    }
    if (this.config.onDisconnected) {
      this.config.onDisconnected({ code, reason });
    }
  };

  private onError = ({ error }: { error: Error }) => {
    debug(
      `WebSocket error: ${
        error ? error.message || "No message" : "No specific error"
      }`
    );
  };

  private onMessage = (event: { data: string }) => {
    const data = JSON.parse(event.data) as EventMessage;
    debug(`Received a '${data.eventName}' message`);
    if (data.eventName === "run") {
      // TODO: Receive runtime options from the server and set these on the instrumented mocha instance before running
      const mocha = this.getMocha();
      delete this.instrumentedMocha;
      this.run(mocha);
    }
  };

  private createReporter(): typeof Mocha.reporters.Base {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const client = this;
    return class extends Mocha.reporters.Base {
      constructor(runner: Mocha.Runner) {
        super(runner);
        // Loop the names and add listeners for all of them
        MOCHA_EVENT_NAMES.forEach(eventName => {
          runner.addListener(eventName, client.send.bind(client, eventName));
        });
      }
    };
  }
}
