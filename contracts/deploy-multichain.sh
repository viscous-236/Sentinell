#!/bin/bash

# Multi-Chain Deployment Script for SentinelHook
# Deploys to Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia

set -e

echo "========================================="
echo "  SentinelHook Multi-Chain Deployment"
echo "========================================="
echo ""

# Load environment variables
source .env

# Check if private key is set
if [ "$PRIVATE_KEY" == "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
    echo "❌ Error: Please set your PRIVATE_KEY in .env file"
    exit 1
fi

# Deployment function
deploy_to_chain() {
    local CHAIN_NAME=$1
    local RPC_URL=$2
    local API_KEY=$3
    
    echo "========================================="
    echo "  Deploying to $CHAIN_NAME"
    echo "========================================="
    echo ""
    
    # Deploy
    forge script Script/DeploySentinelHook.s.sol:DeploySentinelHook \
        --rpc-url $RPC_URL \
        --broadcast \
        --verify \
        --etherscan-api-key $API_KEY \
        -vvv
    
    echo ""
    echo "✅ Deployed to $CHAIN_NAME successfully!"
    echo ""
}

# Deploy to Ethereum Sepolia
echo "Step 1/3: Ethereum Sepolia"
deploy_to_chain "Ethereum Sepolia" "$ETHEREUM_SEPOLIA_RPC" "$ETHERSCAN_API_KEY"
sleep 5

# Deploy to Base Sepolia
echo "Step 2/3: Base Sepolia"
deploy_to_chain "Base Sepolia" "$BASE_SEPOLIA_RPC" "$BASESCAN_API_KEY"
sleep 5

# Deploy to Arbitrum Sepolia
echo "Step 3/3: Arbitrum Sepolia"
deploy_to_chain "Arbitrum Sepolia" "$ARBITRUM_SEPOLIA_RPC" "$ARBISCAN_API_KEY"

echo ""
echo "========================================="
echo "  ✅ All Deployments Complete!"
echo "========================================="
echo ""
echo "  Check deployment addresses in broadcast/ directory"
echo "  Verify contracts on respective explorers"
echo ""
