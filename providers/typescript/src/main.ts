import { ConfigError, settingsFromEnv } from "./config.js";
import { stdoutLogger } from "./log.js";
import { Provider } from "./provider.js";

const VERSION = "0.2.0";

function main(): void {
  let provider: Provider;
  try {
    provider = new Provider(settingsFromEnv(process.env), stdoutLogger);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
  stdoutLogger("reference_version", { version: VERSION });

  let signalled = false;
  const shutdown = (signal: string): void => {
    if (signalled) return;
    signalled = true;
    stdoutLogger("shutdown", { signal });
    provider.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  provider.start().catch((error: unknown) => {
    stdoutLogger("start_failed", { error: error instanceof Error ? error.message : "unknown" });
    process.exit(1);
  });
}

main();
