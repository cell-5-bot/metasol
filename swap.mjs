// swap.mjs
import fetch from "node-fetch";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";

/**
 * Executes a token swap on Solana using Jupiter API.
 * @param {string} inputMint - Token mint to swap from (e.g., SOL)
 * @param {string} outputMint - Token mint to swap to (e.g., USDC)
 * @param {number} amount - Amount in smallest unit (e.g., lamports)
 * @param {Keypair} wallet - Wallet Keypair for signing
 * @param {Connection} connection - Solana connection
 */
export async function executeSwap(inputMint, outputMint, amount, wallet, connection) {
  try {
    console.log("🔁 Fetching quote from Jupiter...");

    // Step 1: Get best quote
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
    const quoteResponse = await fetch(quoteUrl);
    const quote = await quoteResponse.json();

    if (!quote || !quote.outAmount) throw new Error("No valid quote received");

    console.log(`✅ Quote: ${amount / 1e9} input → ${quote.outAmount / 1e6} output`);

    // Step 2: Get swap transaction from Jupiter
    console.log("🧾 Building swap transaction...");
    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });

    const swapData = await swapResponse.json();

    if (!swapData.swapTransaction) {
      console.error("Swap response:", swapData);
      throw new Error("Swap transaction not returned from Jupiter");
    }

    // Step 3: Decode transaction
    const txBuffer = Buffer.from(swapData.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(txBuffer);

    // Step 4: Sign transaction
    transaction.sign([wallet]);

    // Step 5: Send to Solana
    console.log("📤 Sending transaction...");
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    console.log("✅ Swap submitted:", signature);

    // Step 6: Confirm transaction
    await connection.confirmTransaction(signature, "confirmed");
    console.log("🎉 Swap confirmed on-chain!");

    return signature;

  } catch (err) {
    console.error("❌ Swap failed:", err);
    throw err;
  }
}
