import { Telegraf, Markup } from "telegraf";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const conn = new Connection(process.env.SOLANA_RPC, "confirmed");
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR_FILE)))
);

// build main menu
const menu = Markup.inlineKeyboard([
  [Markup.button.callback("🛒 Buy", "buy"), Markup.button.callback("💰 Sell", "sell")],
  [Markup.button.callback("🔄 Refresh", "refresh")]
]);

async function getBalance() {
  const balance = await conn.getBalance(keypair.publicKey);
  const sol = (balance / 1e9).toFixed(4);
  return `${sol} SOL`;
}

// /start command
bot.start(async (ctx) => {
  const balance = await getBalance();
  await ctx.reply(
    `Welcome to Meta Solana Trading Bot!\n\nYour wallet address:\n${keypair.publicKey.toBase58()}\nBalance: ${balance}`,
    menu
  );
});

// Refresh button
bot.action("refresh", async (ctx) => {
  await ctx.answerCbQuery("Updating...");
  const balance = await getBalance();
  await ctx.reply(`Updated balance: ${balance}`, menu);
});

bot.launch();
console.log("Bot running...");
