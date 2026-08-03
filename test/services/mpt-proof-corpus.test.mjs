import assert from "node:assert/strict";
import test from "node:test";

import { verifyPinnedMptCorpus } from "../../scripts/verification/verify-mpt-proof-corpus.mjs";

test("pinned client-compatible MPT corpus is reproducible and structurally complete", async () => {
  const result = await verifyPinnedMptCorpus();
  assert.equal(result.genericVectors, 5);
  assert.equal(result.storageVectors, 3);
  assert.equal(result.classification, "deterministic-test-assurance-fixture");
  assert.equal(result.evidenceEligible, false);
  assert.deepEqual(result.validatedLiveClients, []);
  assert.ok(result.topology.branch > 0);
  assert.ok(result.topology.extension > 0);
  assert.ok(result.topology.leaf > 0);
  assert.ok(result.topology.inlineNodeReference > 0);
  assert.ok(result.topology.hashedNodeReference > 0);
});
