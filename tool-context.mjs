export function withToolContext(handler, readContext) {
  return async (args, extra) => {
    let result;
    try {
      result = await handler(args, extra);
    } catch (error) {
      result = {
        isError: true,
        content: [{ type: "text", text: String(error?.message ?? error) }],
        structuredContent: { error: String(error?.message ?? error) },
      };
    }

    let state;
    let contextAvailable = true;
    try {
      state = await readContext();
    } catch {
      contextAvailable = false;
    }
    const observedAt = new Date().toISOString();
    const context = {
      current_time: state?.current_time ?? { iso: observedAt },
      focus_status: state?.focus_status ?? null,
      todos: state?.todos ?? [],
      ...state,
      observed_at: observedAt,
      ...(!contextAvailable ? { context_available: false } : {}),
    };

    const rawContent = Array.isArray(result?.content)
      ? result.content
      : [{ type: "text", text: JSON.stringify(result ?? null, null, 1) }];

    const baseText = rawContent
      .map((c) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .filter(Boolean)
      .join("\n\n");

    const lokaContextText = `loka_context:\n${JSON.stringify(context, null, 1)}`;
    const combinedText = baseText.length > 0 ? `${baseText}\n\n${lokaContextText}` : lokaContextText;

    let toolStructured = result?.structuredContent;
    if (!toolStructured && rawContent[0]?.text) {
      try {
        const parsed = JSON.parse(rawContent[0].text);
        if (parsed && typeof parsed === "object") {
          toolStructured = Array.isArray(parsed) ? { result: parsed } : { ...parsed };
        } else {
          toolStructured = { result: parsed };
        }
      } catch {
        toolStructured = { text: rawContent[0].text };
      }
    }

    const structuredContent = {
      ...(toolStructured ?? {}),
      loka_context: context,
    };

    return {
      ...result,
      content: [{ type: "text", text: combinedText }],
      structuredContent,
    };
  };
}
