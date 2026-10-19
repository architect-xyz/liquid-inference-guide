import type { AddressInfo } from "node:net";
import type { Settings } from "./config.js";
import { DispatchServer } from "./dispatch.js";
import { Journal } from "./journal.js";
import type { Logger } from "./log.js";
import { SessionClient } from "./session.js";

/** The session client and the dispatch server of one deployment, started and stopped together. */
export class Provider {
  readonly session: SessionClient;
  private readonly journal: Journal;
  private readonly server: DispatchServer;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly settings: Settings,
    private readonly log: Logger,
  ) {
    this.journal = new Journal(settings.journalPath);
    this.session = new SessionClient(settings, log);
    this.server = new DispatchServer(settings, this.session, this.journal, log);
  }

  /** Listens for dispatches first, so no award can arrive before there is an endpoint. */
  async start(): Promise<AddressInfo> {
    const address = await this.server.listen();
    this.log("dispatch_bound", { host: address.address, port: address.port });
    this.session.start();
    return address;
  }

  /**
   * Withdraws the quotes and closes the session, then finishes the dispatches
   * in progress. Calling it again returns the same promise.
   */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    await this.session.stop();
    await this.server.close(this.settings.shutdownTimeoutMs);
    this.journal.close();
  }
}
