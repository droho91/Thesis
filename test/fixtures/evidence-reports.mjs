import {
  buildAcceptedProofObservation,
  buildLiveClientProofValidation,
} from "../../scripts/verification/live-client-proof-evidence.mjs";

export function createPassingEvidenceReports(profile) {
  const { effective } = profile;
  const attestors = [1, 2, 3, 4].map(address);
  const contractNames = {
    A: [
      "checkpointClient", "gateway", "identityRegistry", "policyEngine", "canonicalToken",
      "escrowVault", "restitutionVault", "collateralApp", "governance",
    ],
    B: [
      "checkpointClient", "gateway", "identityRegistry", "policyEngine", "voucherToken",
      "debtToken", "oracle", "lendingPool", "restitutionVault", "collateralApp", "governance",
    ],
  };
  let contractIdentity = 20;
  const chains = Object.fromEntries(["A", "B"].map((chainKey) => [chainKey, {
    chainId: String(effective.besu.chainIds[chainKey]),
    rpc: effective.besu.rpc[chainKey],
    deploymentBlock: 10,
    contracts: Object.fromEntries(contractNames[chainKey].map((name) => {
      const identity = contractIdentity++;
      return [name, { address: address(identity), transactionHash: hex32(identity), deploymentBlock: 10 }];
    })),
  }]));
  const samples = Array.from({ length: effective.benchmark.messages }, (_, index) => {
    const sourceInclusionMs = 1_000 + index;
    const postSourceInclusionToCompletionMs = 2_000 + index;
    return {
      direction: "A-to-B",
      label: `benchmark-${index + 1}`,
      messageId: hex32(1_000 + index),
      amount: "10",
      sourceTransaction: hex32(2_000 + index),
      sourceBlock: 100 + index,
      destinationBalanceDelta: "10",
      sourceIncludedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      sourceInclusionMs,
      postSourceInclusionToCompletionMs,
      endToEndMs: sourceInclusionMs + postSourceInclusionToCompletionMs,
      relayTransactions: {
        source: hex32(2_000 + index),
        receive: hex32(3_000 + index),
        acknowledge: hex32(4_000 + index),
      },
      destinationChainId: String(effective.besu.chainIds.B),
    };
  });
  const sourceInclusion = samples.map((sample) => sample.sourceInclusionMs);
  const postSourceInclusionToCompletion = samples.map((sample) => sample.postSourceInclusionToCompletionMs);
  const endToEnd = samples.map((sample) => sample.endToEndMs);
  const clientVersion = "besu/v24.10.0/linux-x86_64/openjdk-java-21";
  const liveClientProofValidation = buildLiveClientProofValidation({
    chainSnapshots: [
      { chainId: String(effective.besu.chainIds.A), clientVersion },
      { chainId: String(effective.besu.chainIds.B), clientVersion },
    ],
    proofObservations: [
      proofObservation(
        "message-commitment-membership", effective.besu.chainIds.A, effective.besu.chainIds.B,
        chains.A.contracts.gateway.address, 1,
      ),
      proofObservation(
        "acknowledgement-membership", effective.besu.chainIds.A, effective.besu.chainIds.B,
        chains.A.contracts.gateway.address, 2,
      ),
      proofObservation(
        "message-commitment-membership", effective.besu.chainIds.B, effective.besu.chainIds.A,
        chains.B.contracts.gateway.address, 3,
      ),
      proofObservation(
        "acknowledgement-membership", effective.besu.chainIds.B, effective.besu.chainIds.A,
        chains.B.contracts.gateway.address, 4,
      ),
    ],
  });

  return {
    deployment: {
      version: "institutional-deployment-v2",
      status: "ready",
      artifactFingerprint: hex32(1),
      securityProfile: {
        governanceMode: "timelock-enforced",
        finalityDepth: effective.protocol.finalityDepth,
        maxCheckpointSubmissionAgeSeconds: String(effective.protocol.maxCheckpointSubmissionAgeSeconds),
        maxClockDriftSeconds: String(effective.protocol.maxClockDriftSeconds),
        governanceDelaySeconds: String(effective.protocol.governanceDelaySeconds),
        attestorThreshold: 3,
        attestors,
      },
      accounts: {
        A: { owner: address(5), user: address(6), relayer: address(7) },
        B: { owner: address(8), user: address(9), relayer: address(10) },
      },
      chains,
    },
    fault: {
      version: "besu-qbft-validator-availability-report-v2",
      status: "passed",
      testModel: "single-validator crash/unavailability; no Byzantine behavior is injected",
      validatorCount: effective.besu.validatorsPerChain,
      toleratedFaults: effective.besu.toleratedFaultsPerChain,
      validatorUnavailable: [
        { network: "chainA", validator: address(101), container: "chain-a-validator-4" },
        { network: "chainB", validator: address(201), container: "chain-b-validator-4" },
      ],
      duringUnavailability: faultSnapshots(2, 100),
      afterRecovery: faultSnapshots(3, 102),
    },
    integration: {
      version: "institutional-integration-report-v3",
      status: "passed",
      tests: {
        lockMint: {
          status: "passed",
          messageId: samples[0].messageId,
          sourceTransaction: samples[0].sourceTransaction,
          voucherDelta: samples[0].destinationBalanceDelta,
        },
        lending: {
          status: "passed",
          collateralAmount: "600",
          borrowedAmount: "200",
          depositTransaction: hex32(503),
          borrowTransaction: hex32(504),
          healthFactorE18: "2000000000000000000",
        },
        burnUnlock: {
          status: "passed",
          messageId: hex32(505),
          sourceTransaction: hex32(506),
          canonicalBalanceDelta: "200",
          endToEndMs: 3_000,
        },
        quorumOutage: {
          status: "passed",
          messageId: hex32(507),
          threshold: 3,
          unavailableAttestors: 2,
          destinationDeltaWithoutQuorum: "0",
          destinationDeltaAfterRecovery: "5",
        },
        engineReloadRecovery: {
          status: "passed",
          messageId: hex32(508),
          reloadState: "source_checkpointed",
          destinationDelta: "7",
          duplicateDeltaAfterRepeatedTicks: "0",
        },
      },
      environment: {
        chainA: {
          chainId: String(effective.besu.chainIds.A), rpc: effective.besu.rpc.A, blockNumber: 100, clientVersion,
        },
        chainB: {
          chainId: String(effective.besu.chainIds.B), rpc: effective.besu.rpc.B, blockNumber: 100, clientVersion,
        },
        chainAAfter: {
          chainId: String(effective.besu.chainIds.A), rpc: effective.besu.rpc.A, blockNumber: 120, clientVersion,
        },
        chainBAfter: {
          chainId: String(effective.besu.chainIds.B), rpc: effective.besu.rpc.B, blockNumber: 120, clientVersion,
        },
        validatorTopology: {
          validatorCountPerChain: effective.besu.validatorsPerChain,
          toleratedFaults: effective.besu.toleratedFaultsPerChain,
          dockerImage: effective.besu.dockerImage,
        },
        validatorAvailabilityTest: { status: "passed" },
      },
      liveClientProofValidation,
      benchmark: {
        status: "passed",
        sampleCount: effective.benchmark.messages,
        requiredSamples: effective.benchmark.requiredSamples,
        targetP95Ms: effective.benchmark.targetP95Ms,
        samples,
        sourceInclusion: durationSummary(sourceInclusion),
        postSourceInclusionToCompletion: durationSummary(postSourceInclusionToCompletion),
        endToEnd: durationSummary(endToEnd),
      },
    },
  };
}

function proofObservation(kind, sourceChainId, destinationChainId, account, identity) {
  return buildAcceptedProofObservation({
    kind,
    sourceChainId,
    destinationChainId,
    proof: {
      checkpointHeight: String(100 + identity),
      stateRoot: hex32(6_000 + identity),
      account,
      storageKey: hex32(8_000 + identity),
      expectedValue: "0x01",
      accountProof: [`0xc1${identity.toString(16).padStart(2, "0")}`],
      storageProof: [`0xc2${identity.toString(16).padStart(2, "0")}00`],
    },
    acceptedTransactionHash: hex32(9_000 + identity),
    acceptedBlockNumber: 200 + identity,
  });
}

function faultSnapshots(peerCount, startBlock) {
  return ["chainA", "chainB"].map((key, chainIndex) => ({
    key,
    chainId: chainIndex === 0 ? 41001 : 41002,
    validatorCount: 4,
    validators: [1, 2, 3, 4].map((offset) => address((chainIndex + 1) * 100 + offset)),
    peerCount,
    startBlock,
    blockNumber: startBlock + 2,
    blocksProduced: 2,
  }));
}

function address(value) {
  return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}

function hex32(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function durationSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (quantile) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
  return {
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    meanMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  };
}
