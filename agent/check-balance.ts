import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

const TOKEN = '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb';
const WALLET = '0xC25dA7A84643E29819e93F4Cb4442e49604662f1';

const client = createPublicClient({
  chain: sepolia,
  transport: http('https://eth-sepolia.g.alchemy.com/v2/eJTW-rO6Spw-MYUjJIPu8wHTGCbnw5Bk')
});

async function check() {
  const balance = await client.readContract({
    address: TOKEN,
    abi: [{
      inputs: [{type: 'address'}],
      name: 'balanceOf',
      outputs: [{type: 'uint256'}],
      stateMutability: 'view',
      type: 'function'
    }],
    functionName: 'balanceOf',
    args: [WALLET]
  }) as bigint;
  
  console.log(`Balance: ${balance / 1000000n} ytest.usd (${balance} units)`);
}

check();
