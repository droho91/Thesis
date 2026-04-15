import { ethers } from "ethers";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  deploy,
  loadArtifact,
  saveConfig,
  validatorAddresses,
} from "./ibc-lite-common.mjs";

const INITIAL_EPOCH_ID = BigInt(process.env.VALIDATOR_EPOCH_ID || 1);

async function deploySourceCore({ chainKey, provider, owner, artifacts }) {
  const chainId = Number((await provider.getNetwork()).chainId);
  const validators = await validatorAddresses(provider);
  const powers = validators.map(() => 1n);
  const packetStore = await deploy(artifacts.packetStore, owner, [chainId]);
  const validatorRegistry = await deploy(artifacts.validatorRegistry, owner, [
    chainId,
    INITIAL_EPOCH_ID,
    validators,
    powers,
  ]);
  const checkpointRegistry = await deploy(artifacts.checkpointRegistry, owner, [
    chainId,
    await packetStore.getAddress(),
    await validatorRegistry.getAddress(),
  ]);

  console.log(`[${chainKey}] source core chainId=${chainId}`);
  return { chainId, packetStore, validatorRegistry, checkpointRegistry };
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

async function main() {
  const artifacts = {
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    validatorRegistry: await loadArtifact("source/SourceValidatorEpochRegistry.sol", "SourceValidatorEpochRegistry"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
    handler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    escrow: await loadArtifact("apps/EscrowVault.sol", "EscrowVault"),
    voucher: await loadArtifact("apps/VoucherToken.sol", "VoucherToken"),
    lending: await loadArtifact("apps/VoucherLendingPool.sol", "VoucherLendingPool"),
    app: await loadArtifact("apps/MinimalTransferApp.sol", "MinimalTransferApp"),
  };

  const providerA = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const providerB = new ethers.JsonRpcProvider(CHAIN_B_RPC);
  const ownerA = await providerA.getSigner(0);
  const ownerB = await providerB.getSigner(0);

  const sourceA = await deploySourceCore({ chainKey: "A", provider: providerA, owner: ownerA, artifacts });
  const sourceB = await deploySourceCore({ chainKey: "B", provider: providerB, owner: ownerB, artifacts });
  const epochA = validatorEpochObject(await sourceA.validatorRegistry.validatorEpoch(INITIAL_EPOCH_ID));
  const epochB = validatorEpochObject(await sourceB.validatorRegistry.validatorEpoch(INITIAL_EPOCH_ID));

  const clientA = await deploy(artifacts.client, ownerA, [epochB]);
  const clientB = await deploy(artifacts.client, ownerB, [epochA]);
  const handlerA = await deploy(artifacts.handler, ownerA, [sourceA.chainId, await clientA.getAddress()]);
  const handlerB = await deploy(artifacts.handler, ownerB, [sourceB.chainId, await clientB.getAddress()]);

  const bankTokenA = await deploy(artifacts.bankToken, ownerA, ["Bank A Deposit Token", "aBANK"]);
  const escrowA = await deploy(artifacts.escrow, ownerA, [await bankTokenA.getAddress()]);
  const voucherB = await deploy(artifacts.voucher, ownerB, ["Voucher for Bank A Deposit", "vA"]);
  const stableB = await deploy(artifacts.bankToken, ownerB, ["Bank B Stable Token", "sBANK"]);
  const lendingB = await deploy(artifacts.lending, ownerB, [
    await voucherB.getAddress(),
    await stableB.getAddress(),
    Number(process.env.LENDING_COLLATERAL_FACTOR_BPS || 5000),
  ]);
  const appA = await deploy(artifacts.app, ownerA, [
    sourceA.chainId,
    await sourceA.packetStore.getAddress(),
    await handlerA.getAddress(),
    await escrowA.getAddress(),
    ethers.ZeroAddress,
  ]);
  const appB = await deploy(artifacts.app, ownerB, [
    sourceB.chainId,
    await sourceB.packetStore.getAddress(),
    await handlerB.getAddress(),
    ethers.ZeroAddress,
    await voucherB.getAddress(),
  ]);

  await (await sourceA.packetStore.grantRole(await sourceA.packetStore.PACKET_COMMITTER_ROLE(), await appA.getAddress())).wait();
  await (await sourceB.packetStore.grantRole(await sourceB.packetStore.PACKET_COMMITTER_ROLE(), await appB.getAddress())).wait();
  await (await escrowA.grantApp(await appA.getAddress())).wait();
  await (await voucherB.grantApp(await appB.getAddress())).wait();
  await (await appA.configureRemoteApp(sourceB.chainId, await appB.getAddress())).wait();
  await (await appB.configureRemoteApp(sourceA.chainId, await appA.getAddress())).wait();

  const config = {
    chains: {
      A: {
        rpc: CHAIN_A_RPC,
        chainId: sourceA.chainId,
        packetStore: await sourceA.packetStore.getAddress(),
        validatorRegistry: await sourceA.validatorRegistry.getAddress(),
        checkpointRegistry: await sourceA.checkpointRegistry.getAddress(),
        client: await clientA.getAddress(),
        packetHandler: await handlerA.getAddress(),
        canonicalToken: await bankTokenA.getAddress(),
        escrowVault: await escrowA.getAddress(),
        transferApp: await appA.getAddress(),
      },
      B: {
        rpc: CHAIN_B_RPC,
        chainId: sourceB.chainId,
        packetStore: await sourceB.packetStore.getAddress(),
        validatorRegistry: await sourceB.validatorRegistry.getAddress(),
        checkpointRegistry: await sourceB.checkpointRegistry.getAddress(),
        client: await clientB.getAddress(),
        packetHandler: await handlerB.getAddress(),
        voucherToken: await voucherB.getAddress(),
        stableToken: await stableB.getAddress(),
        lendingPool: await lendingB.getAddress(),
        transferApp: await appB.getAddress(),
      },
    },
  };
  await saveConfig(config);
  console.log(`IBC-lite deployment saved to .ibc-lite.local.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
