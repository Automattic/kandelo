/** Serialize discovery for an agent without repeating the browser's document URL. */
export function compactToolCatalog(
  document: { generationId: string; title: string; url: string },
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: unknown; annotations?: unknown }>,
) {
  return {
    documents: [{ id: document.generationId, title: document.title, url: document.url }],
    tools: tools.filter(tool => tool.name.startsWith('kandelo_')).map(tool => ({
      documentId: document.generationId,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  };
}
