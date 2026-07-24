import { describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli.js";

describe("buildProgram", () => {
  it("registers expected top-level commands", () => {
    const commandNames = buildProgram().commands.map((command) => command.name()).sort();

    expect(commandNames).toEqual([
      "auth",
      "credit",
      "download",
      "history",
      "image",
      "models",
      "task",
      "video",
    ]);
  });
});
