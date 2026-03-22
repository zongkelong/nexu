export function renderFallbackTemplate(
  template: string,
  params: Record<string, string>,
): string {
  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return typeof value === "string" ? value : "";
  });
}
