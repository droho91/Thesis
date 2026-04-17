import { ethers } from "ethers";
import {
  providerFor,
  signaturesFor,
  signerFor,
  validatorAddresses,
} from "./ibc-lite-common.mjs";
import { finalizedHeaderByHeight, latestFinalizedHeader } from "./ibc-lite-header-progression.mjs";

function log(prefix, message) {
  console.log(prefix ? `[${prefix}] ${message}` : message);
}

function validatorEpochObject(epoch) {
  return {
    sourceChainId: epoch.sourceChainId,
    sourceValidatorSetRegistry: epoch.sourceValidatorSetRegistry,
    epochId: epoch.epochId,
    parentEpochHash: epoch.parentEpochHash,
    validators: Array.from(epoch.validators),
    votingPowers: Array.from(epoch.votingPowers),
    totalVotingPower: epoch.totalVotingPower,
    quorumNumerator: epoch.quorumNumerator,
    quorumDenominator: epoch.quorumDenominator,
    activationBlockNumber: epoch.activationBlockNumber,
    activationBlockHash: epoch.activationBlockHash,
    timestamp: epoch.timestamp,
    epochHash: epoch.epochHash,
    active: epoch.active,
  };
}

export async function submitConflictingHeaderUpdate({
  cfg,
  artifacts,
  sourceKey,
  destinationKey,
  height = null,
  requireExistingTrusted = false,
  logPrefix = "",
}) {
  const destination = cfg.chains[destinationKey];
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const header = height
    ? await finalizedHeaderByHeight({ cfg, artifacts, chainKey: sourceKey, height })
    : await latestFinalizedHeader({ cfg, artifacts, chainKey: sourceKey });

  if (header.sourceCommitmentHash === ethers.ZeroHash) {
    throw new Error(`source ${sourceKey} finalized header ${header.height} is empty`);
  }

  const existing = await client.consensusStateHashBySequence(cfg.chains[sourceKey].chainId, header.height);
  if (requireExistingTrusted && existing === ethers.ZeroHash) {
    throw new Error(
      `${destinationKey} must already trust ${sourceKey} header #${header.height} before conflict evidence can freeze it.`
    );
  }

  header.packetRoot = ethers.keccak256(ethers.toUtf8Bytes(`conflict:${sourceKey}:${Date.now()}`));
  header.stateRoot = ethers.keccak256(ethers.toUtf8Bytes(`conflict-state:${sourceKey}:${Date.now()}`));
  header.blockHash = await client.hashHeader(header);
  const conflictHash = await client.hashConsensusState(header);
  const commitDigest = await client.hashCommitment(header);
  const signatures = await signaturesFor(sourceKey, sourceProvider, commitDigest);
  await (await client.updateState([header], signatures)).wait();
  log(logPrefix, `submitted conflicting finalized header ${sourceKey}->${destinationKey} ${conflictHash}`);
  return { conflictHash, height: header.height.toString() };
}

export async function recoverClientWithSuccessorEpoch({
  cfg,
  artifacts,
  sourceKey,
  destinationKey,
  recoveryValidatorIndices,
  logPrefix = "",
}) {
  const ownerSource = await signerFor(cfg, sourceKey, 0);
  const ownerDestination = await signerFor(cfg, destinationKey, 0);
  const sourceProvider = providerFor(cfg, sourceKey);
  const validatorRegistry = new ethers.Contract(
    cfg.chains[sourceKey].validatorRegistry,
    artifacts.validatorRegistry.abi,
    ownerSource
  );
  const client = new ethers.Contract(cfg.chains[destinationKey].client, artifacts.client.abi, ownerDestination);

  const currentEpochId = await validatorRegistry.activeValidatorEpochId();
  const nextEpochId = currentEpochId + 1n;
  const validators = await validatorAddresses(sourceKey, sourceProvider, recoveryValidatorIndices);
  const powers = validators.map(() => 1n);

  await (await client.beginRecovery(cfg.chains[sourceKey].chainId)).wait();
  await (await validatorRegistry.commitValidatorEpoch(nextEpochId, validators, powers)).wait();
  const epoch = validatorEpochObject(await validatorRegistry.validatorEpoch(nextEpochId));
  const signatures = await signaturesFor(sourceKey, sourceProvider, epoch.epochHash);
  await (await client.updateValidatorEpoch(epoch, signatures)).wait();

  log(logPrefix, `recovered ${destinationKey} client for ${sourceKey} with successor epoch ${nextEpochId}`);
  return { epochId: nextEpochId.toString(), epochHash: epoch.epochHash };
}
