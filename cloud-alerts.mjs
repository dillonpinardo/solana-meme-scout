import fs from 'node:fs/promises';

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) throw new Error('Missing Discord webhook secret.');
const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const stateFile = 'discord-alerted-tokens.json';
const paperFile = 'paper-test.json';
const n = value => Number(value || 0);
const money = value => '$' + n(value).toFixed(2);
const get = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Market data request failed.');
  return response.json();
};
const post = async body => {
  const response = await fetch(webhook + '?wait=true', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Discord alert failed.');
};
const eligible = pair => {
  const liquidity = n(pair.liquidity?.usd), volume = n(pair.volume?.h24);
  const buys = n(pair.txns?.h24?.buys), sells = n(pair.txns?.h24?.sells);
  const ratio = buys / Math.max(sells, 1), move = n(pair.priceChange?.h24);
  const age = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600000 : Infinity;
  return liquidity >= config.minLiquidityUsd && volume >= config.minVolume24hUsd && ratio >= config.minBuysToSellsRatio && age >= 1 && age <= config.maxTokenAgeHours && move >= -10 && move <= 150;
};
const bestPair = pairs => pairs.sort((a, b) => n(b.liquidity?.usd) - n(a.liquidity?.usd))[0];
const closePaperPosition = async (paper, reason, price, at) => {
  const position = paper.position;
  const proceeds = n(position.notionalUsd) * price / n(position.entryPrice);
  const pnl = proceeds - n(position.notionalUsd);
  const pct = (price / n(position.entryPrice) - 1) * 100;
  paper.cashUsd = proceeds;
  paper.closedAddresses = [...new Set([...(paper.closedAddresses || []), position.address])];
  paper.trades.push({ side: 'SELL', at, symbol: position.symbol, address: position.address, entryPrice: position.entryPrice, exitPrice: price, proceedsUsd: proceeds, pnlUsd: pnl, pnlPct: pct, reason });
  paper.position = null;
  await post({ username: 'Meme Scout', content: 'PAPER SELL — ' + position.symbol + '\nReason: ' + reason + '\nEntry: $' + position.entryPrice + ' to Exit: $' + price + '\nVirtual P/L: ' + (pnl >= 0 ? '+' : '-') + money(Math.abs(pnl)) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)\nNo real trade was made.' });
};

let alerted = {}; try { alerted = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch {}
let paper = null; try { paper = JSON.parse(await fs.readFile(paperFile, 'utf8')); } catch {}
const boosts = (await get('https://api.dexscreener.com/token-boosts/latest/v1')).filter(item => item.chainId === 'solana').slice(0, 30);
const addresses = [...new Set(boosts.map(item => item.tokenAddress))];
if (!addresses.length) process.exit(0);
const pairs = await get('https://api.dexscreener.com/tokens/v1/solana/' + addresses.join(','));
const best = Object.values(Object.groupBy(pairs, item => item.baseToken?.address)).map(group => bestPair(group)).filter(Boolean);

for (const pair of best) {
  const liquidity = n(pair.liquidity?.usd), volume = n(pair.volume?.h24), marketCap = n(pair.marketCap || pair.fdv);
  const buys = n(pair.txns?.h24?.buys), sells = n(pair.txns?.h24?.sells), ratio = buys / Math.max(sells, 1);
  const move = n(pair.priceChange?.h24), age = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600000 : Infinity;
  const score = (liquidity >= config.minLiquidityUsd ? 30 : 0) + (volume >= config.minVolume24hUsd ? 20 : 0) + (ratio >= config.minBuysToSellsRatio ? 20 : 0) + (age >= 1 && age <= config.maxTokenAgeHours ? 10 : 0) + (move >= -10 && move <= 150 ? 10 : 0);
  if (!eligible(pair) || score < config.minScoreToBuy || alerted[pair.baseToken.address]) continue;
  const address = String(pair.baseToken.address);
  await post({ username: 'Meme Scout', allowed_mentions: { parse: [] }, embeds: [{ title: 'New paper-scan candidate: ' + pair.baseToken.symbol, url: pair.url, color: 6591999, fields: [{ name: 'Found at', value: new Date().toLocaleString(), inline: true }, { name: 'Price found', value: '$' + (pair.priceUsd || 'unknown'), inline: true }, { name: 'Market cap found', value: money(marketCap), inline: true }, { name: 'Score', value: String(score), inline: true }, { name: 'Liquidity', value: money(liquidity), inline: true }, { name: '24h volume', value: money(volume), inline: true }, { name: 'Buy/sell', value: ratio.toFixed(2), inline: true }, { name: 'Token address (press and hold to copy)', value: address }, { name: 'Links', value: '[Open chart](' + pair.url + ') • [Inspect on Solscan](https://solscan.io/token/' + address + ')' }], footer: { text: 'Paper signal only — verify before any trade.' } }] });
  alerted[address] = new Date().toISOString();
}

if (paper?.active && !paper.completed) {
  const now = Date.now(), end = Date.parse(paper.endsAt);
  paper.cashUsd = n(paper.cashUsd || paper.startingUsd || 20);
  paper.trades ||= []; paper.closedAddresses ||= [];
  if (paper.position) {
    const livePairs = await get('https://api.dexscreener.com/tokens/v1/solana/' + paper.position.address);
    const current = bestPair(livePairs), price = n(current?.priceUsd);
    const heldMs = now - Date.parse(paper.position.openedAt);
    const returnPct = price > 0 ? (price / n(paper.position.entryPrice) - 1) * 100 : 0;
    if (price > 0 && returnPct <= -8) await closePaperPosition(paper, 'stop loss at -8%', price, new Date().toISOString());
    else if (price > 0 && heldMs >= 10 * 60 * 1000 && returnPct < 2) await closePaperPosition(paper, 'slow after 10 minutes', price, new Date().toISOString());
  }
  if (now < end && !paper.position && paper.cashUsd > 0) {
    const choice = best.find(pair => eligible(pair) && !paper.closedAddresses.includes(pair.baseToken.address));
    const entry = n(choice?.priceUsd);
    if (choice && entry > 0) {
      const at = new Date().toISOString();
      paper.position = { address: choice.baseToken.address, symbol: choice.baseToken.symbol, entryPrice: entry, notionalUsd: paper.cashUsd, openedAt: at };
      paper.trades.push({ side: 'BUY', at, symbol: choice.baseToken.symbol, address: choice.baseToken.address, priceUsd: entry, notionalUsd: paper.cashUsd });
      paper.cashUsd = 0;
      await post({ username: 'Meme Scout', content: 'PAPER BUY — ' + choice.baseToken.symbol + '\nVirtual amount: ' + money(paper.position.notionalUsd) + '\nEntry: $' + entry + '\nRule: recheck every 5 minutes; exit at -8% or if under +2% after 10 minutes.\nNo real trade was made.' });
    }
  }
  if (now >= end) {
    if (paper.position) {
      const livePairs = await get('https://api.dexscreener.com/tokens/v1/solana/' + paper.position.address);
      const price = n(bestPair(livePairs)?.priceUsd);
      if (price > 0) await closePaperPosition(paper, 'test finished', price, new Date().toISOString());
    }
    paper.completed = true; paper.completedAt = new Date().toISOString(); paper.endingUsd = paper.cashUsd;
    const totalPnl = n(paper.endingUsd) - n(paper.startingUsd);
    await post({ username: 'Meme Scout', content: 'PAPER TEST COMPLETE\nVirtual start: ' + money(paper.startingUsd) + '\nVirtual ending: ' + money(paper.endingUsd) + '\nTotal P/L: ' + (totalPnl >= 0 ? '+' : '-') + money(Math.abs(totalPnl)) + '\nCompleted trades: ' + paper.trades.filter(trade => trade.side === 'SELL').length + '\nNo real trade was made.' });
  }
  await fs.writeFile(paperFile, JSON.stringify(paper, null, 2) + '\n');
}
await fs.writeFile(stateFile, JSON.stringify(alerted, null, 2) + '\n');
