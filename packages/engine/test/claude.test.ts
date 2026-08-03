import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOLS,
  sanitizeAddDirs,
  sanitizeExtraArgs,
  sanitizeExtraTools,
} from "../src/executors/claude.js";

describe("ALLOWED_TOOLS（2026-08-03 権限拡張）", () => {
  it("Bash を含むフルセットを既定で許可する", () => {
    for (const tool of ["Read", "Write", "Edit", "Bash", "Task", "WebSearch", "WebFetch"]) {
      expect(ALLOWED_TOOLS).toContain(tool);
    }
  });
});

describe("sanitizeExtraArgs", () => {
  it("--dangerously-skip-permissions と --allowedTools 系は大文字小文字を問わず落とす", () => {
    expect(
      sanitizeExtraArgs([
        "--dangerously-skip-permissions",
        "--DANGEROUSLY-SKIP-PERMISSIONS",
        "--allowedTools",
        "--allowed-tools",
        "--verbose",
      ]),
    ).toEqual(["--verbose"]);
  });
});

describe("sanitizeAddDirs", () => {
  it('"-" 始まり（フラグ混入経路）を落とし、パスだけ通す', () => {
    expect(
      sanitizeAddDirs(["/home/ubuntu", "--dangerously-skip-permissions", "D:\\VSCodeProject"]),
    ).toEqual(["/home/ubuntu", "D:\\VSCodeProject"]);
  });
});

describe("sanitizeExtraTools", () => {
  it('"-" 始まり（フラグ混入経路）を落とし、ツール名だけ通す', () => {
    expect(
      sanitizeExtraTools(["mcp__foo__*", "-p", "--dangerously-skip-permissions", "Bash(ssh:*)"]),
    ).toEqual(["mcp__foo__*", "Bash(ssh:*)"]);
  });
});
