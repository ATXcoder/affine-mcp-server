function cloneJsonValue<T>(data: T): T {
  if (data === undefined) {
    return data;
  }
  return JSON.parse(JSON.stringify(data)) as T;
}

export function text(data: unknown) {
  if (typeof data === "string") {
    return {
      content: [{ type: "text" as const, text: data }],
      structuredContent: { text: data },
    };
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const structuredContent = cloneJsonValue(data);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }

  if (Array.isArray(data)) {
    const items = cloneJsonValue(data);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(items) }],
      structuredContent: { items },
    };
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: { value: cloneJsonValue(data) },
  };
}

export type ToolErrorOptions = {
  code?: string;
  retryable?: boolean;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown tool error";
}

/** Return a machine-readable MCP failure while preserving the legacy error string. */
export function toolError(error: unknown, options: ToolErrorOptions = {}) {
  const result = text({
    ...(options.data || {}),
    ok: false,
    error: errorMessage(error),
    code: options.code || "tool_error",
    retryable: options.retryable ?? false,
    ...(options.details ? { details: cloneJsonValue(options.details) } : {}),
  });
  return {
    ...result,
    isError: true,
  };
}

/**
 * Return binary content as MCP `image` content when the MIME type is an
 * image (renders inline in most clients), or as an embedded `resource`
 * (base64 `blob`) otherwise. `meta` is metadata-only — the byte payload
 * itself lives in the content block, not structuredContent.
 */
export function blob(params: {
  data: string;
  mimeType: string;
  uri: string;
  meta: Record<string, unknown>;
}) {
  const isImage = /^image\//i.test(params.mimeType);
  const content = isImage
    ? [{ type: "image" as const, data: params.data, mimeType: params.mimeType }]
    : [{
      type: "resource" as const,
      resource: { uri: params.uri, mimeType: params.mimeType, blob: params.data },
    }];
  return {
    content,
    structuredContent: cloneJsonValue(params.meta),
  };
}

export function receipt(kind: string, data: Record<string, unknown>) {
  const ok = typeof data.ok === "boolean"
    ? data.ok
    : typeof data.success === "boolean"
      ? data.success
      : data.status === "failed"
        ? false
        : true;
  const result = text({
    kind,
    ...data,
    ok,
  });
  return ok ? result : { ...result, isError: true };
}
