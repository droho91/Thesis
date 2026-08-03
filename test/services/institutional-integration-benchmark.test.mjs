import assert from "node:assert/strict";
import test from "node:test";
import {
  percentile,
  summarizeBenchmark,
  summarizeDurations,
} from "../../scripts/verification/institutional-integration/benchmark.mjs";

const samples = [
  benchmarkSample("message-a", 3, 7),
  benchmarkSample("message-b", 10, 20),
  benchmarkSample("message-c", 8, 12),
];

test("benchmark summary preserves the integration report schema and nearest-rank statistics", () => {
  const summary = summarizeBenchmark(samples, { requiredSamples: 3, targetP95Ms: 20 });

  assert.deepEqual(Object.keys(summary), [
    "status",
    "definition",
    "acceptanceProfile",
    "sampleCount",
    "requiredSamples",
    "targetP95Ms",
    "samples",
    "sourceInclusion",
    "postSourceInclusionToCompletion",
    "endToEnd",
  ]);
  assert.equal(summary.status, "passed");
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.requiredSamples, 3);
  assert.equal(summary.targetP95Ms, 20);
  assert.equal(summary.samples, samples);
  assert.deepEqual(summary.sourceInclusion, {
    minMs: 3,
    maxMs: 10,
    meanMs: 7,
    p50Ms: 8,
    p95Ms: 10,
  });
  assert.deepEqual(summary.postSourceInclusionToCompletion, {
    minMs: 7,
    maxMs: 20,
    meanMs: 13,
    p50Ms: 12,
    p95Ms: 20,
  });
  assert.deepEqual(summary.endToEnd, {
    minMs: 10,
    maxMs: 30,
    meanMs: 20,
    p50Ms: 20,
    p95Ms: 30,
  });
});

test("benchmark status keeps insufficient-sample precedence and the p95 acceptance boundary", () => {
  assert.equal(
    summarizeBenchmark(samples, { requiredSamples: 4, targetP95Ms: 19 }).status,
    "insufficient-samples",
  );
  assert.equal(
    summarizeBenchmark(samples, { requiredSamples: 3, targetP95Ms: 19 }).status,
    "target-not-met",
  );
  assert.equal(
    summarizeBenchmark(samples, { requiredSamples: 3, targetP95Ms: 20 }).status,
    "passed",
  );
});

test("benchmark helpers fail closed for malformed or internally inconsistent samples", () => {
  assert.throws(
    () => summarizeBenchmark([], { requiredSamples: 1, targetP95Ms: 1 }),
    /non-empty array/,
  );
  for (const invalid of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = [benchmarkSample("bad", 1, 2)];
    malformed[0].sourceInclusionMs = invalid;
    assert.throws(
      () => summarizeBenchmark(malformed, { requiredSamples: 1, targetP95Ms: 10 }),
      /sourceInclusionMs/,
    );
  }

  const inconsistent = [benchmarkSample("inconsistent", 4, 5)];
  inconsistent[0].endToEndMs = 10;
  assert.throws(
    () => summarizeBenchmark(inconsistent, { requiredSamples: 1, targetP95Ms: 10 }),
    /internally inconsistent/,
  );
  assert.throws(
    () => summarizeBenchmark(samples, { requiredSamples: 0, targetP95Ms: 20 }),
    /requiredSamples/,
  );
  assert.throws(
    () => summarizeBenchmark(samples, { requiredSamples: 3, targetP95Ms: Infinity }),
    /targetP95Ms/,
  );
});

test("duration and percentile boundaries reject empty, unsorted and invalid series", () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
  assert.deepEqual(summarizeDurations([0]), {
    minMs: 0,
    maxMs: 0,
    meanMs: 0,
    p50Ms: 0,
    p95Ms: 0,
  });

  assert.throws(() => percentile([], 0.95), /non-empty array/);
  assert.throws(() => percentile([20, 10], 0.95), /sorted in ascending order/);
  assert.throws(() => percentile([10], 0), /quantile/);
  assert.throws(() => percentile([10], 1.01), /quantile/);
  assert.throws(() => summarizeDurations([10, NaN]), /non-negative safe integer/);
});

function benchmarkSample(messageId, sourceInclusionMs, postSourceInclusionToCompletionMs) {
  return {
    messageId,
    sourceInclusionMs,
    postSourceInclusionToCompletionMs,
    endToEndMs: sourceInclusionMs + postSourceInclusionToCompletionMs,
  };
}
