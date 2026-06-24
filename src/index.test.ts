import { describe, expect, it, vi } from "vitest";

import { main, startupMessage } from "./index.js";

describe("main", () => {
  it("logs a single synthetic startup line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(startupMessage);
    logSpy.mockRestore();
  });
});
