import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiSummarizer } from "../src/clients/openai";

// Capture the model field sent to the OpenAI API by stubbing global fetch.
function stubFetch(): { modelOf: () => string } {
  let lastModel = "";
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    lastModel = body.model;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return { modelOf: () => lastModel };
}

describe("OpenAiSummarizer model selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the configured OPENAI_MODEL", async () => {
    const cap = stubFetch();
    await new OpenAiSummarizer("k", "gpt-5.6-terra").summarize("I", []);
    expect(cap.modelOf()).toBe("gpt-5.6-terra");
  });

  it("falls back to gpt-4o-mini when the model is unset", async () => {
    const cap = stubFetch();
    await new OpenAiSummarizer("k", undefined).summarize("I", []);
    expect(cap.modelOf()).toBe("gpt-4o-mini");
  });

  it("falls back when the model var is blank/whitespace", async () => {
    const cap = stubFetch();
    await new OpenAiSummarizer("k", "   ").summarize("I", []);
    expect(cap.modelOf()).toBe("gpt-4o-mini");
  });

  it("also threads the model into post-mortem drafting", async () => {
    const cap = stubFetch();
    await new OpenAiSummarizer("k", "gpt-5.6-terra").draftPostmortem("I", []);
    expect(cap.modelOf()).toBe("gpt-5.6-terra");
  });
});
