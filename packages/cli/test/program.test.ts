import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";

describe("CLI program", () => {
  it("exposes a stable name and description", () => {
    const program = createProgram();

    expect(program.name()).toBe("agenthawk");
    expect(program.description()).toContain("dependency admission control");
  });
});
