import { expandAdversarialStrategies } from "../../src/cognitive/adversarial.js";

describe("adversarial strategy selection", () => {
  it("treats the direct MCP omnibus strategy all as all threat scanners", () => {
    expect(expandAdversarialStrategies("all")).toEqual([
      "privilege_escalation",
      "data_leak_path",
      "injection_surface",
      "missing_validation",
      "broken_access_control",
    ]);
  });
});
