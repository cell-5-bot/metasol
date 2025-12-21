import { Keypair } from "@solana/web3.js";
import fs from "fs";
const Keypair= '/Users/mac/.config/solana/id.json';
const kp = Keypair.generate();
fs.writeFileSync("keypair.json", JSON.stringify(Array.from(kp.secretKey)));
console.log(kp.publicKey.toBase58());
