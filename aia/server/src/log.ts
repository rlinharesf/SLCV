export function log(scope: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${ts} [${scope}]`, ...args);
}

export function warn(scope: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.warn(`${ts} [${scope}] AVISO`, ...args);
}
