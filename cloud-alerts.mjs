import fs from 'node:fs/promises';
const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) throw new Error('Missing Discord webhook secret.');
const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const stateFile = 'discord-alerted-tokens.json';
const n = value => Number(value || 0);
const money = value => value ? '$'+Math.round(value).toLocaleString() : 'unknown';
const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error('Market data failed.'); return r.json(); };
let alerted = {}; try { alerted = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch {}
const boosts = (await get('https://api.dexscreener.com/token-boosts/latest/v1')).filter(x => x.chainId === 'solana').slice(0,30);
const addresses = [...new Set(boosts.map(x => x.tokenAddress))];
if (!addresses.length) process.exit(0);
const pairs = await get('https://api.dexscreener.com/tokens/v1/solana/' + addresses.join(','));
const best = Object.values(Object.groupBy(pairs, x => x.baseToken?.address)).map(group => group.sort((a,b) => n(b.liquidity?.usd)-n(a.liquidity?.usd))[0]).filter(Boolean);
for (const pair of best) {
  const liquidity=n(pair.liquidity?.usd), volume=n(pair.volume?.h24), marketCap=n(pair.marketCap || pair.fdv), buys=n(pair.txns?.h24?.buys), sells=n(pair.txns?.h24?.sells), ratio=buys/Math.max(sells,1), move=n(pair.priceChange?.h24), age=pair.pairCreatedAt?(Date.now()-pair.pairCreatedAt)/3600000:Infinity;
  const score=(liquidity>=config.minLiquidityUsd?30:0)+(volume>=config.minVolume24hUsd?20:0)+(ratio>=config.minBuysToSellsRatio?20:0)+(age>=1&&age<=config.maxTokenAgeHours?10:0)+(move>=-10&&move<=150?10:0);
  if (!(liquidity>=config.minLiquidityUsd&&volume>=config.minVolume24hUsd&&ratio>=config.minBuysToSellsRatio&&age>=1&&age<=config.maxTokenAgeHours&&move>=-10&&move<=150&&score>=config.minScoreToBuy) || alerted[pair.baseToken.address]) continue;
  const address=String(pair.baseToken.address);
  const body={username:'Meme Scout',allowed_mentions:{parse:[]},embeds:[{title:'New paper-scan candidate: '+pair.baseToken.symbol,url:pair.url,color:6591999,fields:[{name:'Found at',value:new Date().toLocaleString(),inline:true},{name:'Price found',value:'$'+(pair.priceUsd||'unknown'),inline:true},{name:'Market cap found',value:money(marketCap),inline:true},{name:'Score',value:String(score),inline:true},{name:'Liquidity',value:money(liquidity),inline:true},{name:'24h volume',value:money(volume),inline:true},{name:'Buy/sell',value:ratio.toFixed(2),inline:true},{name:'Token address — press and hold to copy',value:'`'+address+'`'},{name:'Links',value:'[Open chart]('+pair.url+') • [Inspect on Solscan](https://solscan.io/token/'+address+')'}],footer:{text:'Paper signal only — verify before any trade.'}}]};
  const r=await fetch(webhook+'?wait=true',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(r.ok) alerted[pair.baseToken.address]=new Date().toISOString();
}
await fs.writeFile(stateFile,JSON.stringify(alerted,null,2)+'\n');
