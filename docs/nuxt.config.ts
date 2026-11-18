type Node = unknown[] | { type?: string; value?: unknown[] };

/* Twoslash blocks hide their setup lines above `// ---cut---`. Keep them out of the copy button too. */
function stripCutFromCopy(node: unknown) {
  if (!Array.isArray(node)) return;
  const [tag, props] = node as [string, Record<string, unknown> | undefined];
  if (
    tag === "pre" &&
    props &&
    typeof props.code === "string" &&
    props.code.includes("// ---cut---")
  ) {
    const code = props.code;
    props.code = code
      .slice(code.indexOf("// ---cut---") + "// ---cut---".length)
      .replace(/^\s*\n/, "");
  }
  for (const child of node.slice(2)) stripCutFromCopy(child);
}

export default defineNuxtConfig({
  extends: ["./layer"],
  hooks: {
    "content:file:afterParse"(ctx) {
      const body = (ctx.content as { body?: Node }).body;
      const nodes = Array.isArray(body) ? body : (body?.value ?? []);
      for (const n of nodes as unknown[]) stripCutFromCopy(n);
    },
  },
});
