const BENCHMARK_DEFINITION =
  "Full proof-and-acknowledgement cycle after source transaction inclusion";
const BENCHMARK_ACCEPTANCE_PROFILE =
  "Local Docker QBFT profile: 2s block period, checkpoint confirmation depth 2 after QBFT inclusion, source checkpoint, destination proof execution, destination checkpoint, and source acknowledgement.";

export function summarizeBenchmark(samples, { requiredSamples, targetP95Ms }) {
  requirePositiveInteger(requiredSamples, "Benchmark requiredSamples");
  requirePositiveInteger(targetP95Ms, "Benchmark targetP95Ms");
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("Benchmark samples must be a non-empty array.");
  }

  for (const [index, sample] of samples.entries()) {
    if (sample === null || typeof sample !== "object" || Array.isArray(sample)) {
      throw new Error(`Benchmark sample ${index} must be an object.`);
    }
    requireDuration(sample.sourceInclusionMs, `Benchmark sample ${index} sourceInclusionMs`);
    requireDuration(
      sample.postSourceInclusionToCompletionMs,
      `Benchmark sample ${index} postSourceInclusionToCompletionMs`,
    );
    requireDuration(sample.endToEndMs, `Benchmark sample ${index} endToEndMs`);
    if (
      sample.endToEndMs
      !== sample.sourceInclusionMs + sample.postSourceInclusionToCompletionMs
    ) {
      throw new Error(`Benchmark sample ${index} durations are internally inconsistent.`);
    }
  }

  const endToEnd = sortedDurations(samples.map((sample) => sample.endToEndMs));
  const sourceInclusion = sortedDurations(samples.map((sample) => sample.sourceInclusionMs));
  const postSourceInclusionToCompletion = sortedDurations(
    samples.map((sample) => sample.postSourceInclusionToCompletionMs),
  );
  const enoughSamples = samples.length >= requiredSamples;
  const meetsLatency = percentile(postSourceInclusionToCompletion, 0.95) <= targetP95Ms;

  return {
    status: !enoughSamples ? "insufficient-samples" : meetsLatency ? "passed" : "target-not-met",
    definition: BENCHMARK_DEFINITION,
    acceptanceProfile: BENCHMARK_ACCEPTANCE_PROFILE,
    sampleCount: endToEnd.length,
    requiredSamples,
    targetP95Ms,
    samples,
    sourceInclusion: summarizeDurations(sourceInclusion),
    postSourceInclusionToCompletion: summarizeDurations(postSourceInclusionToCompletion),
    endToEnd: summarizeDurations(endToEnd),
  };
}

export function summarizeDurations(sortedValues) {
  assertSortedDurations(sortedValues);
  return {
    minMs: sortedValues[0],
    maxMs: sortedValues.at(-1),
    meanMs: Math.round(
      sortedValues.reduce((sum, value) => sum + value, 0) / sortedValues.length,
    ),
    p50Ms: percentile(sortedValues, 0.5),
    p95Ms: percentile(sortedValues, 0.95),
  };
}

export function percentile(sortedValues, quantile) {
  assertSortedDurations(sortedValues);
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error("Benchmark percentile quantile must be greater than zero and at most one.");
  }
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1)];
}

function sortedDurations(values) {
  return values.toSorted((left, right) => left - right);
}

function assertSortedDurations(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Benchmark duration series must be a non-empty array.");
  }
  for (let index = 0; index < values.length; index += 1) {
    requireDuration(values[index], `Benchmark duration at index ${index}`);
    if (index > 0 && values[index - 1] > values[index]) {
      throw new Error("Benchmark duration series must be sorted in ascending order.");
    }
  }
}

function requireDuration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}
