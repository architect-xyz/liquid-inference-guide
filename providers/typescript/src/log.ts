export type LogFields = Record<string, unknown>;

export type Logger = (event: string, fields?: LogFields) => void;

export const stdoutLogger: Logger = (event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
};

export const silentLogger: Logger = () => {};
