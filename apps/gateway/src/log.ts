export function log(message: string, context?: Record<string, unknown>): void {
  if (context) {
    console.log(`[gateway] ${message}`, context);
    return;
  }

  console.log(`[gateway] ${message}`);
}
