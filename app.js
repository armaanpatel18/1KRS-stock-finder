let DATA={stocks:[]};let filter="all";let budget=1000;const chosen={};

const $=s=>document.querySelector(s);
const fmt=n=>new Intl.NumberFormat("en-IN",{maximumFractionDigits:0}).format(n);
const pct=n=>n==null?"—":`${n>=0?"+":""}${n.toFixed(1)}%`; const val=n=>n==null?"—":fmt(n); const metric=n=>n==null?"—":n;

async function load(){
  DATA=await fetch("data/stocks.json",{cache:"no-store"}).then(r=>r.json());
  if(DATA.updated_at){$("#updatedAt").textContent=new Date(DATA.updated_at).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"});} else {$("#updatedAt").textContent="No live data yet";}
  render();
}
function render(){
  const s=DATA.stocks||[];
  $("#stats").innerHTML=[
    ["Candidates",s.length],["Undervalued",s.filter(x=>x.tag==="undervalued").length],
    ["Growth",s.filter(x=>x.tag==="growth").length],["Avg score",Math.round(s.reduce((a,x)=>a+x.score,0)/s.length)]
  ].map(x=>`<div class="stat"><b>${x[1]}</b><span>${x[0]}</span></div>`).join("");
  const q=$("#search").value.toLowerCase();
  const rows=s.filter(x=>(filter==="all"||x.tag===filter)&&(`${x.name} ${x.symbol}`).toLowerCase().includes(q)).sort((a,b)=>b.score-a.score);
  $("#stockGrid").innerHTML=rows.map(card).join("")||`<div class="notice">No matching stocks.</div>`;
  updatePortfolio();
}
function card(x){
  const upside=x.upside;
  const shares=chosen[x.symbol]??0;
  return `<article class="card">
    <div class="card-head"><div><div class="symbol">${x.symbol} • ₹${fmt(x.marketCapCr)} Cr</div><div class="name">${x.name}</div></div><div class="score">${x.score==null?"—":x.score}</div></div>
    <span class="badge ${x.tag}">${x.tag}</span>
    <div class="price">₹${fmt(x.price)}</div><div class="upside">Model fair value ${x.fairValue==null?"—":"₹"+fmt(x.fairValue)} • ${pct(upside)}</div>
    <div class="metrics">
      <div class="metric"><small>ROCE</small><b>${x.roce==null?"—":x.roce+"%"}</b></div>
      <div class="metric"><small>ROE</small><b>${x.roe==null?"—":x.roe+"%"}</b></div>
      <div class="metric"><small>P/E</small><b>${x.pe==null?"—":x.pe+"×"}</b></div>
      <div class="metric"><small>Debt/Equity</small><b>${x.de==null?"—":x.de}</b></div>
      <div class="metric"><small>5Y profit CAGR</small><b>${x.growth5==null?"—":x.growth5+"%"}</b></div>
      <div class="metric"><small>Upside</small><b>${pct(upside)}</b></div>
    </div>
    <div class="bar"><i style="width:${x.score||0}%"></i></div>
    <p class="why">${x.why}</p>
    <div class="select-row"><input aria-label="shares" type="number" min="0" value="${shares}" data-symbol="${x.symbol}" class="shares"><button data-add="${x.symbol}">Add to portfolio</button></div>
  </article>`;
}
function updatePortfolio(){
  const items=Object.entries(chosen).filter(([_,n])=>n>0);
  let total=0;
  $("#portfolioRows").innerHTML=items.map(([sym,n])=>{
    const x=DATA.stocks.find(s=>s.symbol===sym);const value=x.price*n;total+=value;
    return `<div class="p-row"><div><b>${x.name}</b><small>${sym} @ ₹${fmt(x.price)}</small></div><input class="shares" data-symbol="${sym}" type="number" min="0" value="${n}"><span>${n} shares</span><b>₹${fmt(value)}</b></div>`;
  }).join("") || `<div class="muted">Add stocks above to build your ₹${fmt(budget)} portfolio.</div>`;
  $("#portfolioTotal").textContent=`₹${fmt(total)} / ₹${fmt(budget)}`;
}
document.addEventListener("click",e=>{
  if(e.target.matches(".tabs button")){document.querySelectorAll(".tabs button").forEach(b=>b.classList.remove("active"));e.target.classList.add("active");filter=e.target.dataset.filter;render();}
  if(e.target.dataset.add){const sym=e.target.dataset.add;const input=document.querySelector(`input[data-symbol="${sym}"]`);chosen[sym]=Math.max(0,Number(input.value)||0);updatePortfolio();}
});
document.addEventListener("input",e=>{
  if(e.target.id==="budget"){budget=Math.max(100,Number(e.target.value)||1000);updatePortfolio();}
  if(e.target.id==="search")render();
  if(e.target.matches(".shares")&&e.target.dataset.symbol){chosen[e.target.dataset.symbol]=Math.max(0,Number(e.target.value)||0);updatePortfolio();}
});
load();