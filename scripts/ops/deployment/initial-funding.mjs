// Funding checkpoints belong to each token deployment, not to the current wallet balance.
export async function seedInitialAccounts({ manifest, allocations, readBalance, mint, confirm, persist }) {
  for (const { chain, contract, account, amount, label } of allocations) {
    const token = manifest.chains[chain].contracts[contract];
    if (!token.initialFunding) {
      // A ready legacy manifest already completed its original funding step.
      token.initialFunding = manifest.status === "ready" ? { complete: true } : { accounts: {} };
      await persist();
    }
    const funding = token.initialFunding;
    const key = account.toLowerCase();
    if (funding.complete || funding.accounts[key] === true) continue;

    const pending = funding.accounts[key];
    if (pending?.transactionHash) {
      await confirm(chain, contract, pending.transactionHash, label);
    } else {
      const balance = BigInt(await readBalance(chain, contract, account, label));
      if (balance < amount) {
        const transaction = await mint(chain, contract, account, amount - balance, label);
        funding.accounts[key] = { transactionHash: transaction.hash };
        await persist();
        await confirm(chain, contract, transaction, label);
      }
    }
    funding.accounts[key] = true;
    await persist();
  }
}
