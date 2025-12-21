// ...existing code...
import dotenv from "dotenv";
dotenv.config();

import { Market } from "@project-serum/serum";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");

const SERUM_PROGRAM_ID = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const SERUM_MARKET_ADDRESS_STR = process.env.SERUM_MARKET_ADDRESS || "";
if (!SERUM_MARKET_ADDRESS_STR) {
  console.error('❌ Set SERUM_MARKET_ADDRESS env var to the market public key (do not use the Serum program ID).');
  console.error('Example: SERUM_MARKET_ADDRESS="<PUBKEY>" SOLANA_RPC_URL="https://api.mainnet-beta.solana.com" node load-market.mjs');
  process.exit(1);
}
const SERUM_MARKET_ADDRESS = new PublicKey(SERUM_MARKET_ADDRESS_STR);

(async () => {
  try {
    console.log("🔍 Checking account info...", { rpc: RPC, market: SERUM_MARKET_ADDRESS.toBase58() });
    const info = await connection.getAccountInfo(SERUM_MARKET_ADDRESS);
    if (!info) throw new Error("❌ Market account not found on this RPC endpoint. Verify pubkey/cluster or try a different RPC.");

    console.log("📦 Loading Serum market...");
    const market = await Market.load(connection, SERUM_MARKET_ADDRESS, {}, SERUM_PROGRAM_ID);

    console.log("✅ Market loaded successfully!");
    console.log("Base Mint:", market.baseMintAddress.toBase58());
    console.log("Quote Mint:", market.quoteMintAddress.toBase58());
    console.log("Event Queue:", market._decoded.eventQueue.toBase58());
    console.log("Request Queue:", market._decoded.requestQueue.toBase58());
    console.log("Bids:", market._decoded.bids.toBase58());
    console.log("Asks:", market._decoded.asks.toBase58());
  } catch (err) {
    console.error("❌ Failed to load market:", (err && err.message) || err);
    process.exit(1);
  }
})();
// ...existing code...