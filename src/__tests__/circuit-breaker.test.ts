/**
 * Unit tests for circuit breaker pure functions.
 *
 * Tests fingerprint(), consecutiveTailRun(), and evaluateCircuitBreaker()
 * exported from engine.ts.
 */

import { describe, it, expect } from "vitest";
import {
  fingerprint,
  consecutiveTailRun,
  evaluateCircuitBreaker,
  type IterationSnapshot,
  type EjectionResult,
} from "../engine.js";
import type { CircuitBreakerConfig } from "../types.js";

// ── Default config for tests ────────────────────────────────────────

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  maxConsecutiveInfra: 2,
  maxConsecutiveContradictions: 3,
  maxConsecutiveIdenticalFailures: 3,
  maxConsecutiveTimeouts: 2,
  costCeilingUsd: 0,
};

/** Helper to build an IterationSnapshot with sensible defaults. */
function snap(overrides: Partial<IterationSnapshot> & { iteration: number }): IterationSnapshot {
  return {
    failureClass: "TEST",
    exitCode: 1,
    stderrFingerprint: "",
    contradiction: false,
    cumulativeCostUsd: 0,
    ...overrides,
  };
}

// =============================================================================
// fingerprint()
// =============================================================================

describe("fingerprint()", () => {
  it("returns empty string for empty input", () => {
    expect(fingerprint("")).toBe("");
  });

  it("normalizes to lowercase", () => {
    expect(fingerprint("ERROR: Module Not Found")).toBe("error: module not found");
  });

  it("takes only first 3 non-empty lines", () => {
    const input = "line1\n\nline2\nline3\nline4\nline5";
    expect(fingerprint(input)).toBe("line1|line2|line3");
  });

  it("strips PIDs (pid 12345 format)", () => {
    expect(fingerprint("process crashed pid 98765")).toBe("process crashed pid X");
  });

  it("strips PIDs ([12345] bracket format)", () => {
    expect(fingerprint("[54321] error occurred")).toBe("[X] error occurred");
  });

  it("does not strip short bracket numbers (2 digits)", () => {
    // [12] is too short to be a PID
    expect(fingerprint("[12] ok")).toBe("[12] ok");
  });

  it("strips ISO timestamps", () => {
    expect(fingerprint("2026-02-23T14:30:00.123 error")).toBe("TIMESTAMP error");
  });

  it("strips HH:MM:SS timestamps", () => {
    expect(fingerprint("at 14:30:00 the build failed")).toBe("at TIMESTAMP the build failed");
  });

  it("strips hex addresses", () => {
    expect(fingerprint("segfault at 0x7fff12ab34cd")).toBe("segfault at 0xHEX");
  });

  it("does not strip short hex values (3 chars or less)", () => {
    expect(fingerprint("exit 0x1")).toBe("exit 0x1");
  });

  it("is deterministic across multiple calls", () => {
    const input = "pid 999 crashed at 2026-01-01T00:00:00 addr 0xDEADBEEF";
    expect(fingerprint(input)).toBe(fingerprint(input));
  });

  it("produces the same fingerprint for errors differing only in PIDs and timestamps", () => {
    const a = "pid 111 failed at 2026-01-01T01:00:00 with error";
    const b = "pid 222 failed at 2026-02-15T23:59:59 with error";
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("skips blank lines", () => {
    const input = "\n  \n  error here\n  \n  more info\n";
    expect(fingerprint(input)).toBe("error here|more info");
  });
});

// =============================================================================
// consecutiveTailRun()
// =============================================================================

describe("consecutiveTailRun()", () => {
  it("returns 0 for empty array", () => {
    expect(consecutiveTailRun([], () => true)).toBe(0);
  });

  it("returns full length when all match", () => {
    expect(consecutiveTailRun([1, 2, 3], () => true)).toBe(3);
  });

  it("returns 0 when last element does not match", () => {
    expect(consecutiveTailRun([1, 2, 3], (n) => n < 3)).toBe(0);
  });

  it("counts only the tail run", () => {
    expect(consecutiveTailRun([1, 2, 2, 2], (n) => n === 2)).toBe(3);
  });

  it("handles single-element array", () => {
    expect(consecutiveTailRun([5], (n) => n === 5)).toBe(1);
    expect(consecutiveTailRun([5], (n) => n === 4)).toBe(0);
  });

  it("stops at first non-matching element from tail", () => {
    expect(consecutiveTailRun([true, false, true, true], (b) => b)).toBe(2);
  });
});

// =============================================================================
// evaluateCircuitBreaker()
// =============================================================================

describe("evaluateCircuitBreaker()", () => {
  it("returns null for empty history", () => {
    expect(evaluateCircuitBreaker([], DEFAULT_CB_CONFIG)).toBeNull();
  });

  it("returns null when disabled", () => {
    const config = { ...DEFAULT_CB_CONFIG, enabled: false };
    const history: IterationSnapshot[] = [
      snap({ iteration: 1, failureClass: "INFRA", stderrFingerprint: "err" }),
      snap({ iteration: 2, failureClass: "INFRA", stderrFingerprint: "err" }),
    ];
    expect(evaluateCircuitBreaker(history, config)).toBeNull();
  });

  // ── Rule 1: INFRA_STUCK ─────────────────────────────────────────────

  describe("INFRA_STUCK", () => {
    it("ejects after maxConsecutiveInfra identical INFRA failures", () => {
      const fp = "no binary for chromiumheadless";
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "INFRA", stderrFingerprint: fp }),
        snap({ iteration: 2, failureClass: "INFRA", stderrFingerprint: fp }),
      ];
      const result = evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("INFRA_STUCK");
    });

    it("does not eject when INFRA failures have different fingerprints", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "INFRA", stderrFingerprint: "error-a" }),
        snap({ iteration: 2, failureClass: "INFRA", stderrFingerprint: "error-b" }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });

    it("does not eject when count is below threshold", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "INFRA", stderrFingerprint: "err" }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });

    it("respects custom threshold", () => {
      // Raise both INFRA and identical-failure thresholds so STUCK_LOOP doesn't fire first
      const config = { ...DEFAULT_CB_CONFIG, maxConsecutiveInfra: 4, maxConsecutiveIdenticalFailures: 5 };
      const fp = "missing binary";
      const history = Array.from({ length: 3 }, (_, i) =>
        snap({ iteration: i + 1, failureClass: "INFRA", stderrFingerprint: fp })
      );
      // 3 < 4 threshold
      expect(evaluateCircuitBreaker(history, config)).toBeNull();

      // 4 = threshold
      history.push(snap({ iteration: 4, failureClass: "INFRA", stderrFingerprint: fp }));
      const result = evaluateCircuitBreaker(history, config);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("INFRA_STUCK");
    });
  });

  // ── Rule 2: CONTRADICTION_LOOP ──────────────────────────────────────

  describe("CONTRADICTION_LOOP", () => {
    it("ejects after maxConsecutiveContradictions", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, contradiction: true, stderrFingerprint: "a" }),
        snap({ iteration: 2, contradiction: true, stderrFingerprint: "b" }),
        snap({ iteration: 3, contradiction: true, stderrFingerprint: "c" }),
      ];
      const result = evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("CONTRADICTION_LOOP");
    });

    it("does not eject when below threshold", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, contradiction: true }),
        snap({ iteration: 2, contradiction: true }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });

    it("resets count when a non-contradiction occurs", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, contradiction: true }),
        snap({ iteration: 2, contradiction: true }),
        snap({ iteration: 3, contradiction: false }),
        snap({ iteration: 4, contradiction: true }),
        snap({ iteration: 5, contradiction: true }),
      ];
      // Only 2 consecutive at the tail, not 3
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });
  });

  // ── Rule 3: STUCK_LOOP ──────────────────────────────────────────────

  describe("STUCK_LOOP", () => {
    it("ejects after maxConsecutiveIdenticalFailures", () => {
      const fp = "test assertion failed|expected true|got false";
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "TEST", stderrFingerprint: fp }),
        snap({ iteration: 2, failureClass: "TEST", stderrFingerprint: fp }),
        snap({ iteration: 3, failureClass: "TEST", stderrFingerprint: fp }),
      ];
      const result = evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("STUCK_LOOP");
    });

    it("does not eject when fingerprints differ", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, stderrFingerprint: "error-1" }),
        snap({ iteration: 2, stderrFingerprint: "error-2" }),
        snap({ iteration: 3, stderrFingerprint: "error-3" }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });

    it("does not eject when fingerprint is empty", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, stderrFingerprint: "" }),
        snap({ iteration: 2, stderrFingerprint: "" }),
        snap({ iteration: 3, stderrFingerprint: "" }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });
  });

  // ── Rule 4: COST_CEILING ────────────────────────────────────────────

  describe("COST_CEILING", () => {
    it("ejects when cumulative cost exceeds ceiling", () => {
      const config = { ...DEFAULT_CB_CONFIG, costCeilingUsd: 10 };
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, cumulativeCostUsd: 4 }),
        snap({ iteration: 2, cumulativeCostUsd: 10.5 }),
      ];
      const result = evaluateCircuitBreaker(history, config);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("COST_CEILING");
    });

    it("does not eject when costCeilingUsd is 0 (disabled)", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, cumulativeCostUsd: 100 }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });

    it("ejects at exactly the ceiling", () => {
      const config = { ...DEFAULT_CB_CONFIG, costCeilingUsd: 5 };
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, cumulativeCostUsd: 5.00 }),
      ];
      const result = evaluateCircuitBreaker(history, config);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("COST_CEILING");
    });
  });

  // ── Rule 5: TIMEOUT_STUCK ──────────────────────────────────────────

  describe("TIMEOUT_STUCK", () => {
    it("ejects after maxConsecutiveTimeouts", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "TIMEOUT" }),
        snap({ iteration: 2, failureClass: "TIMEOUT" }),
      ];
      const result = evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("TIMEOUT_STUCK");
    });

    it("does not eject when below threshold", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "TIMEOUT" }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });

    it("resets when a non-timeout occurs", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "TIMEOUT" }),
        snap({ iteration: 2, failureClass: "TEST", stderrFingerprint: "x" }),
        snap({ iteration: 3, failureClass: "TIMEOUT" }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });
  });

  // ── Priority: INFRA_STUCK takes precedence over STUCK_LOOP ─────────

  describe("rule priority", () => {
    it("INFRA_STUCK fires before STUCK_LOOP for identical INFRA failures", () => {
      // With maxConsecutiveInfra=2 and maxConsecutiveIdenticalFailures=3,
      // 2 identical INFRA failures should fire INFRA_STUCK (rule 1) not STUCK_LOOP (rule 3)
      const fp = "command not found";
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "INFRA", stderrFingerprint: fp }),
        snap({ iteration: 2, failureClass: "INFRA", stderrFingerprint: fp }),
      ];
      const result = evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("INFRA_STUCK");
    });
  });

  // ── Mixed history ──────────────────────────────────────────────────

  describe("mixed histories", () => {
    it("does not eject on diverse failures", () => {
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "INFRA", stderrFingerprint: "a" }),
        snap({ iteration: 2, failureClass: "BUILD", stderrFingerprint: "b" }),
        snap({ iteration: 3, failureClass: "TEST", stderrFingerprint: "c" }),
        snap({ iteration: 4, failureClass: "TEST", stderrFingerprint: "d" }),
      ];
      expect(evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG)).toBeNull();
    });

    it("detects STUCK_LOOP even after initial diverse failures", () => {
      const fp = "same error every time";
      const history: IterationSnapshot[] = [
        snap({ iteration: 1, failureClass: "INFRA", stderrFingerprint: "different" }),
        snap({ iteration: 2, failureClass: "TEST", stderrFingerprint: fp }),
        snap({ iteration: 3, failureClass: "TEST", stderrFingerprint: fp }),
        snap({ iteration: 4, failureClass: "TEST", stderrFingerprint: fp }),
      ];
      const result = evaluateCircuitBreaker(history, DEFAULT_CB_CONFIG);
      expect(result).not.toBeNull();
      expect(result!.rule).toBe("STUCK_LOOP");
    });
  });
});
