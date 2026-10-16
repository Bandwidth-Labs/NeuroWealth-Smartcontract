import { Account, Address, Contract, rpc, scValToNative, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { getBrowserTestHarness } from './browserTestHarness';
import {
  EMPTY_VAULT_STATE,
  deriveVaultState,
  shortenAddress as shortenSharedAddress,
  type VaultState,
} from '../../../packages/vault-client/src/stellar';

export type { VaultState };
export { EMPTY_VAULT_STATE };

function requirePublicEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set; refusing to use an unsafe vault contract default`);
  }
  return value;
}

const RPC_URL = requirePublicEnv('NEXT_PUBLIC_SOROBAN_RPC_URL');
const NETWORK_PASSPHRASE = requirePublicEnv('NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE');
const VAULT_CONTRACT_ID = requirePublicEnv('NEXT_PUBLIC_VAULT_CONTRACT_ID');

export const server = new rpc.Server(RPC_URL, {
  allowHttp: process.env.NEXT_PUBLIC_E2E_TESTS === 'true',
});
export const networkPassphrase = NETWORK_PASSPHRASE;

export async function simulateContractCall(
  method: string,
  args: xdr.ScVal[] = [],
  callerAddress: string,
): Promise<unknown> {
  const testHarness = getBrowserTestHarness();
  if (testHarness) return testHarness.simulateContractCall(method);

  const account = new Account(callerAddress, '0');
  const contract = new Contract(VAULT_CONTRACT_ID);
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    throw new Error(`Simulation failed for ${method}: ${'error' in sim ? sim.error : 'No retval'}`);
  }
  return scValToNative(sim.result.retval);
}

export async function fetchVaultState(userAddress?: string): Promise<VaultState> {
  if (!userAddress) {
    return { ...EMPTY_VAULT_STATE };
  }

  try {
    const userScVal = new Address(userAddress).toScVal();

    const [balanceRes, strategyRes, exchangeRateRes, totalAssetsRes, totalSharesRes] = await Promise.allSettled([
      simulateContractCall('get_balance', [userScVal], userAddress),
      simulateContractCall('get_user_strategy', [userScVal], userAddress),
      simulateContractCall('get_exchange_rate', [], userAddress),
      simulateContractCall('get_total_assets', [], userAddress),
      simulateContractCall('get_total_shares', [], userAddress),
    ]);

    return deriveVaultState({
      balance: balanceRes.status === 'fulfilled' ? Number(balanceRes.value) / 1e7 : 0,
      rawStrategy: strategyRes.status === 'fulfilled' ? String(strategyRes.value) : '',
      exchangeRateRaw: exchangeRateRes.status === 'fulfilled' ? Number(exchangeRateRes.value) / 1e7 : 0,
      totalAssets: totalAssetsRes.status === 'fulfilled' ? Number(totalAssetsRes.value) / 1e7 : 0,
      totalShares: totalSharesRes.status === 'fulfilled' ? Number(totalSharesRes.value) / 1e7 : 0,
    });
  } catch (err) {
    console.warn('Failed to fetch vault state from Soroban RPC:', err);
    return { ...EMPTY_VAULT_STATE };
  }
}

export function shortenAddress(address: string, chars = 4): string {
  return shortenSharedAddress(address, chars);
}