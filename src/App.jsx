import { useState } from "react";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, Cell
} from "recharts";

// ─── Last entered property (always updatehd to user's most recent input) ───────
const DEFAULTS = {
  address: "",
  price: "1060000", rent: "3500", taxes: "11652",
  insurance: "1800", maintenance: "0", vacancy: "4",
  mgmt: "10", hoa: "0", otherExpenses: "0",
  closingCosts: "2.5"
};

// ─── Auto-lookup: searches web for all property data by address ──────────────
async function lookupProperty(address, setLookupStatus) {
  const APIFY_TOKEN = import.meta.env.VITE_APIFY_TOKEN;
  setLookupStatus('Searching Zillow...');
  try {
    // Step 1: Geocode address to get lat/lng using free API
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`);
    const geoData = await geoRes.json();
    let lat = 34.22, lng = -118.50;
    if (geoData.length > 0) {
      lat = parseFloat(geoData[0].lat);
      lng = parseFloat(geoData[0].lon);
    }
    const delta = 0.01;
    const searchState = encodeURIComponent(JSON.stringify({
      pagination: {},
      usersSearchTerm: address,
      mapBounds: { west: lng-delta, east: lng+delta, south: lat-delta, north: lat+delta },
      filterState: { sort: { value: 'globalrelevanceex' } },
      isListVisible: true,
      mapZoom: 15
    }));
    const zillowUrl = `https://www.zillow.com/search/easy-pair/?searchQueryState=${searchState}`;

    const startRes = await fetch(
      `https://api.apify.com/v2/acts/maxcopell~zillow-scraper/runs?token=${APIFY_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchUrls: [{ url: zillowUrl }], maxItems: 10 }) }
    );
    const runData = await startRes.json();
    if (!runData.data) throw new Error('Failed to start run');
    const runId = runData.data.id;
    const datasetId = runData.data.defaultDatasetId;

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 4000));
      setLookupStatus(`Searching Zillow... ${(i+1)*4}s`);
      const s = await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)).json();
      if (s.data.status === 'SUCCEEDED') {
        const items = await (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`)).json();
        if (!items || !items.length || items[0].error) throw new Error('No listings found');
        const streetNum = address.split(' ')[0];
        const streetName = address.split(' ')[1]?.toLowerCase();
        const match = items.find(p => p.address && p.address.includes(streetNum) && p.address.toLowerCase().includes(streetName)) || items[0];
        setLookupStatus('');
        return {
          price: match.unformattedPrice ? String(match.unformattedPrice) : null,
          rent: match.rentZestimate ? String(match.rentZestimate) : null,
          taxes: match.propertyTaxRate ? String(Math.round(match.propertyTaxRate * (match.unformattedPrice||0) / 100)) : null,
          insurance: null,
          hoa: match.hoaFee ? String(match.hoaFee) : '0',
          beds: match.bedrooms || null,
          baths: match.bathrooms || null,
          sqft: match.livingArea || null,
          data_sources: 'Zillow (Apify)'
        };
      }
      if (s.data.status === 'FAILED' || s.data.status === 'ABORTED') throw new Error('Apify run failed');
    }
    throw new Error('Timeout');
  } catch(e) {
    setLookupStatus('Lookup failed: ' + e.message);
    return null;
  }
}

function buildFallback(form, f) {
  const cf    = f.monthlyAfterMort; // POST-mortgage cash flow
  const capS  = f.capRate >= 6 ? 7 : f.capRate >= 4 ? 5 : 3;
  const cfS   = cf > 200 ? 8 : cf > 0 ? 5 : cf > -500 ? 3 : 2;
  const yldS  = f.grossYield >= 8 ? 8 : f.grossYield >= 6 ? 6 : 4;
  const ptrS  = f.ptr < 12 ? 8 : f.ptr < 15 ? 6 : 4;
  const overall = Math.round((capS + cfS + yldS + ptrS + 6 + 5 + 10 + 6) / 8);
  const cfLabel = cf >= 0 ? `+$${cf.toFixed(0)}/mo` : `-$${Math.abs(cf).toFixed(0)}/mo`;
  return {
    overallScore: overall,
    verdict: `At $${f.price.toLocaleString()} with $${f.rent.toLocaleString()}/mo rent and a $${f.mortPayment.toFixed(0)}/mo mortgage, net cash flow is ${cfLabel} — ${cf > 0 ? "marginally positive" : "negative, requiring equity or appreciation to justify the investment"}.`,
    insight: `After the $${f.mortPayment.toFixed(0)}/mo mortgage payment (${f.pmi>0?"including PMI, ":""}${f.down.toLocaleString("en-US",{maximumFractionDigits:0})} down at ${form.closingCosts||2.5}% closing costs), this property produces a net cash flow of ${cfLabel}. The gross yield is ${f.grossYield.toFixed(2)}% and cap rate is ${f.capRate.toFixed(2)}% — ${f.capRate >= 5 ? "within acceptable range" : "below the 5% investor benchmark"}. ${cf < 0 ? "Negative cash flow means this is a speculative play on appreciation rather than an income investment." : "Positive cash flow after all costs is a strong signal."}`,
    cashFlowStatus: cf > 200 ? "good" : cf > 0 ? "ok" : "bad",
    capRateStatus:  f.capRate >= 6 ? "good" : f.capRate >= 4 ? "ok" : "bad",
    ptrStatus:      f.ptr < 15 ? "good" : f.ptr < 20 ? "ok" : "bad",
    criteria: [
      { num:"01", name:"Cash Flow",             score:cfS,  detail:`Net cash flow after $${f.mortPayment.toFixed(0)}/mo mortgage is ${cfLabel}. ${cf > 0 ? "Positive — this property pays for itself." : cf > -500 ? "Negative but manageable — requires reserves to cover the monthly shortfall." : "Significantly negative — this deal loses money every month and depends entirely on appreciation."}` },
      { num:"02", name:"Cap Rate",              score:capS, detail:`Cap rate of ${f.capRate.toFixed(2)}% is ${f.capRate >= 6 ? "within" : f.capRate >= 4 ? "slightly below" : "well below"} the 5–8% investor benchmark. ${f.noi <= 0 ? "NOI is negative, so a 5% cap rate is not possible until rent increases or expenses decrease." : f.capRate < 5 ? `Price would need to drop to ~$${Math.round(f.noi/0.05/1000)*1000} to reach a 5% cap rate.` : "Solid return relative to purchase price."}` },
      { num:"03", name:"Location Quality",      score:6,    detail:`${form.address}. Verify proximity to employment, schools and transit. Location quality directly affects vacancy rates and rent growth.` },
      { num:"04", name:"Rental Demand",         score:6,    detail:`Gross yield of ${f.grossYield.toFixed(2)}% suggests ${f.grossYield >= 7 ? "strong" : "moderate"} rental income relative to price. Verify local vacancy rates before committing.` },
      { num:"05", name:"Condition & CapEx",     score:5,    detail:`${f.maint === 0 ? `No maintenance budget entered — add at least $${Math.round(f.price*0.01/12)}/mo (1% of price annually) for capital reserves.` : `$${f.maint}/mo maintenance budgeted. Verify age of roof, HVAC and plumbing.`}` },
      { num:"06", name:"Total Cash to Close", score:null, detail:`Down payment $${f.down.toLocaleString("en-US",{maximumFractionDigits:0})} + closing costs $${f.closingAmt.toLocaleString("en-US",{maximumFractionDigits:0})} = $${(f.down+f.closingAmt).toLocaleString("en-US",{maximumFractionDigits:0})} total upfront. Monthly mortgage: $${f.mortPayment.toFixed(0)}/mo.` },
      { num:"07", name:"Appreciation Potential", score:5,    detail:`Appreciation data for ${form.address} requires live market data. Run analysis to get AI-scored appreciation based on local market trends.` },
      { num:"08", name:"Tax & Legal",           score:6,    detail:`Review local landlord-tenant laws, property tax trends and eviction timelines for ${form.address.split(",").slice(-2).join(",").trim()}.` },
    ],
    radarData: [
      {subject:"Cash Flow",score:cfS},{subject:"Cap Rate",score:capS},
      {subject:"Location",score:6},{subject:"Demand",score:6},
      {subject:"CapEx",score:5},{subject:"Appreciation",score:10}
    ]
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sc = s => s >= 7 ? "#7ac070" : s >= 5 ? "#c9a84c" : "#e06050";
const vc = s => s >= 7 ? "strong"  : s >= 5 ? "moderate" : "weak";
const vl = s => s >= 7 ? "Strong Buy" : s >= 5 ? "Proceed with Caution" : "Avoid";
const n = s => {
  const match = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : 0;
};
const money0 = v => Math.round(n(v)).toLocaleString("en-US", { maximumFractionDigits: 0 });
const yrMoDisplay = v => `$ ${money0(v)}  /  $ ${money0(n(v) / 12)}`;
const addressMarketLabel = address => {
  const parts = String(address || "").split(",").map(p => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(", ") : (address || "Selected market");
};

function calcF(form, mortDown="20", mortRate="6.0") {
  const price=n(form.price), rent=n(form.rent), taxes=n(form.taxes),
        ins=n(form.insurance), maint=n(form.maintenance),
        hoa=n(form.hoa), other=n(form.otherExpenses);
  const vacPct=n(form.vacancy)||5, mgmtPct=n(form.mgmt)||10;
  const vacAmt=(rent*vacPct)/100, mgmtAmt=(rent*mgmtPct)/100;
  const taxesMo=taxes/12, insMo=ins/12;
  const totalMo=taxesMo+insMo+maint+vacAmt+mgmtAmt+hoa+other;
  const annRent=rent*12, noi=annRent-totalMo*12;

  // Mortgage
  const downPct=parseFloat(mortDown)||20, rate=parseFloat(mortRate)||6.0;
  const down=price*downPct/100, loan=price-down;
  const mr=rate/100/12;
  const pi=loan>0&&mr>0 ? loan*(mr*Math.pow(1+mr,360))/(Math.pow(1+mr,360)-1) : 0;
  const pmi=downPct<20 ? loan*0.007/12 : 0;
  const mortPayment=pi+pmi;

  // Closing costs
  const closingPct=parseFloat(form.closingCosts)||2.5;
  const closingAmt=price*closingPct/100;

  const monthlyCF=noi/12;
  const monthlyAfterMort=monthlyCF-mortPayment;
  const annNOIAfterMort=(monthlyAfterMort)*12;

  return {
    price, rent, taxes, ins, taxesMo, insMo, maint, hoa, other, vacAmt, mgmtAmt,
    totalMo, annRent, noi, down, loan, pi, pmi, mortPayment,
    closingAmt, closingPct,
    capRate: price>0?(noi/price)*100:0,
    capRateAfterMort: price>0?(annNOIAfterMort/price)*100:0,
    ptr: annRent>0?price/annRent:0,
    grossYield: price>0?(annRent/price)*100:0,
    expRatio: annRent>0?(totalMo*12/annRent)*100:0,
    monthlyCF, monthlyAfterMort, annNOIAfterMort
  };
}

// ─── CSS ─────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{background:#ffffff}
.app{min-height:100vh;background:#ffffff;color:#1a1a1a;font-family:'DM Sans',sans-serif}
.topbar{position:fixed;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#c9a84c,#f0d080,#c9a84c);z-index:99}
.wrap{max-width:880px;margin:0 auto;padding:0 24px 80px}
.hdr{padding:52px 0 36px;border-bottom:1px solid rgba(201,168,76,.3)}
.eyebrow{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.25em;color:#b8920a;text-transform:uppercase;margin-bottom:12px}
.htitle{font-family:'Playfair Display',serif;font-size:clamp(28px,5vw,46px);font-weight:900;line-height:1.05;color:#1a1a1a;margin-bottom:12px}
.htitle span{color:#b8920a}
.hsub{font-size:14px;color:#6a6060;line-height:1.6;max-width:520px;font-weight:300}
.fsec{padding:40px 0}
.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.fgrid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px;align-items:end}
.full{grid-column:1/-1}
.flabel{display:block;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#b8920a;margin-bottom:7px;min-height:28px;display:flex;align-items:flex-end}
.finput{width:100%;background:#f8f6f2;border:1px solid #d4b86a;border-radius:6px;padding:11px 14px;color:#1a1a1a;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;transition:border-color .2s;height:46px;box-sizing:border-box}
.finput:focus{border-color:#b8920a;background:#fff}
.finput-red{width:100%;background:#fff5f5;border:1px solid rgba(220,80,60,.4);border-radius:6px;padding:11px 14px;color:#1a1a1a;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;transition:border-color .2s;height:46px;box-sizing:border-box}
.finput-red:focus{border-color:rgba(220,80,60,.8);background:#fff}
.finput-green{width:100%;background:#f5fff5;border:1px solid rgba(60,160,60,.4);border-radius:6px;padding:11px 14px;color:#1a1a1a;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;transition:border-color .2s;height:46px;box-sizing:border-box}
.finput-green:focus{border-color:rgba(60,160,60,.8);background:#fff}
.flabel-red{display:block;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#cc3300;margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flabel-green{display:block;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#1a7a1a;margin-bottom:7px;white-space:nowrap}
.input-wrap{position:relative;display:flex;align-items:center}
.input-prefix{position:absolute;left:14px;color:#1a1a1a;font-size:14px;pointer-events:none;z-index:1}
.input-prefix-green{position:absolute;left:14px;color:#1a1a1a;font-size:14px;pointer-events:none;z-index:1}
.input-prefix-red{position:absolute;left:14px;color:#1a1a1a;font-size:14px;pointer-events:none;z-index:1}
.finput-pfx{padding-left:26px !important}

.divider{margin:24px 0 18px;display:flex;align-items:center;gap:12px}
.divlabel{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.18em;color:#888;text-transform:uppercase;white-space:nowrap}
.divline{flex:1;height:1px;background:rgba(201,168,76,.3)}
.btn-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:24px}
.btn-run{padding:17px 24px;background:linear-gradient(135deg,#c9a84c,#f0d080,#c9a84c);border:none;border-radius:6px;color:#1a1a1a;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:opacity .2s,transform .1s}
.btn-run:hover{opacity:.88;transform:translateY(-1px)}
.btn-results{padding:17px 24px;background:transparent;border:1px solid #d4b86a;border-radius:6px;color:#b8920a;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px}
.btn-results:hover:not(:disabled){background:rgba(201,168,76,.1);border-color:#b8920a}
.btn-results:disabled{opacity:.22;cursor:not-allowed}
.ready-dot{width:8px;height:8px;border-radius:50%;background:#2a9a2a;animation:pulse 2s ease infinite;flex-shrink:0}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
.loading{padding:60px 0;text-align:center}
.spinner{width:52px;height:52px;border:2px solid rgba(201,168,76,.2);border-top-color:#b8920a;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 22px}
@keyframes spin{to{transform:rotate(360deg)}}
.ltitle{font-family:'Playfair Display',serif;font-size:20px;color:#1a1a1a;margin-bottom:8px}
.lsteps{list-style:none;margin-top:18px}
.lsteps li{font-family:'DM Mono',monospace;font-size:11px;color:#aaa;padding:4px 0;letter-spacing:.1em;transition:color .3s}
.lsteps li.active{color:#b8920a}
.lsteps li.done{color:#2a7a2a}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:flex;align-items:center;justify-content:center;padding:24px}
.modal{background:#fff;border:1px solid #d4b86a;border-radius:12px;padding:36px;max-width:400px;width:100%;text-align:center}
.modal-title{font-family:'Playfair Display',serif;font-size:22px;color:#1a1a1a;margin-bottom:10px}
.modal-sub{font-size:13px;color:#666;margin-bottom:26px;line-height:1.6}
.modal-btns{display:flex;flex-direction:column;gap:12px}
.mopt{padding:16px 18px;border-radius:8px;cursor:pointer;transition:all .2s;border:1px solid #e8d89a;background:#fffdf5;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;display:flex;align-items:center;gap:14px;text-align:left}
.mopt:hover{background:#fff8e0;border-color:#b8920a}
.mopt .ico{font-size:24px;line-height:1}
.mopt .desc strong{display:block;color:#1a1a1a;margin-bottom:3px}
.mopt .desc span{font-size:12px;color:#888;font-weight:400}
.mcancel{margin-top:14px;background:none;border:none;color:#aaa;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;cursor:pointer;padding:6px;transition:color .2s}
.mcancel:hover{color:#666}
.rsec{padding:44px 0}
.rhdr{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:36px;gap:16px;flex-wrap:wrap}
.raddr{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.2em;color:#b8920a;text-transform:uppercase;margin-bottom:7px}
.rtitle{font-family:'Playfair Display',serif;font-size:24px;.rtitle{font-family:'Playfair Display',serif;font-size:24px;color:#1a1a1a}
.vbadge{padding:14px 20px;border-radius:8px;text-align:center;min-width:150px}
.vbadge.strong{background:rgba(40,140,40,.08);border:1px solid rgba(40,140,40,.3)}
.vbadge.moderate{background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.3)}
.vbadge.weak{background:rgba(200,60,40,.08);border:1px solid rgba(200,60,40,.3)}
.vlabel{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.2em;color:#888;text-transform:uppercase;margin-bottom:5px}
.vtext{font-family:'Playfair Display',serif;font-size:17px;font-weight:700}
.vbadge.strong .vtext{.vbadge.strong .vtext{color:#1a7a1a}
.vbadge.moderate .vtext{.vbadge.moderate .vtext{color:#b8920a}
.vbadge.weak .vtext{.vbadge.weak .vtext{color:#cc3300}
.vscore{font-family:'DM Mono',monospace;font-size:10px;color:#888;margin-top:5px}
.mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}
.mcard{background:#f8f6f2;border:1px solid #e8e0d0;border-radius:8px;padding:18px;position:relative;overflow:hidden}
.mcard::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#c9a84c,transparent);opacity:.35}
.mname{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#888;margin-bottom:8px}
.mval{font-family:'Playfair Display',serif;font-size:24px;font-weight:700;color:#1a1a1a;margin-bottom:3px}
.msub{font-size:11px;.msub{font-size:11px;color:#aaa}
.mstatus{display:inline-block;margin-top:8px;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:600}
.sg{background:rgba(106,153,85,.2);.vbadge.strong .vtext{color:#1a7a1a}
.so{background:rgba(201,168,76,.2);.vbadge.moderate .vtext{color:#b8920a}
.sb{background:rgba(200,80,60,.2);.vbadge.weak .vtext{color:#cc3300}
.crow2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
.ccard{background:#f8f6f2;border:1px solid #e8e0d0;border-radius:8px;padding:22px}
.ctitle{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#b8920a;margin-bottom:18px}
.isec{background:#fffdf0;border:1px solid #e8d890;border-radius:8px;padding:26px;margin-bottom:20px}
.iey{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.18em;color:#b8920a;text-transform:uppercase;margin-bottom:12px}
.itext{font-size:14px;line-height:1.8;color:#333;font-weight:300}
.iquote{margin-top:14px;padding-top:14px;border-top:1px solid rgba(201,168,76,.2);font-family:'Playfair Display',serif;font-size:14px;color:#b8920a;font-style:italic}
.clsec{background:#f8f6f2;border:1px solid #e8e0d0;border-radius:8px;padding:26px;margin-bottom:20px}
.cltitle{font-family:'Playfair Display',serif;font-size:17px;color:#1a1a1a;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid #e8e0d0}
.clrow{display:flex;align-items:flex-start;gap:14px;padding:12px 0;border-bottom:1px solid #eee}
.clrow:last-child{border-bottom:none}
.clnum{font-family:'DM Mono',monospace;font-size:11px;color:#b8920a;min-width:22px;padding-top:2px}
.clname{font-size:13px;font-weight:600;color:#1a1a1a;margin-bottom:3px}
.cldetail{font-size:12px;color:#666;line-height:1.55}
.clscore{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:66px}
.clnum2{font-family:'DM Mono',monospace;font-size:13px;font-weight:600}
.sbar{width:56px;height:4px;background:#ddd;border-radius:2px;overflow:hidden}
.sbarfill{height:100%;border-radius:2px}
.actrow{display:flex;flex-direction:column;gap:10px;margin-top:8px}
.btn-export{width:100%;padding:16px 24px;background:transparent;border:1px solid #d4b86a;border-radius:6px;color:#b8920a;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px}
.btn-export:hover{background:rgba(201,168,76,.1);border-color:#b8920a}
.btn-back{background:none;border:none;color:#aaa;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;cursor:pointer;padding:6px 0;transition:color .2s;text-align:center}
.btn-back:hover{color:#666}
.mort-sec{background:#f8f6f2;border:1px solid #e8e0d0;border-radius:8px;padding:26px;margin-bottom:20px}
.mort-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:14px}
.mort-title{font-family:'Playfair Display',serif;font-size:17px;color:#f5f0e8;margin-bottom:4px}
.mort-sub{font-size:12px;color:#6a6058;line-height:1.5}
.mort-controls{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.mort-sel-wrap{display:flex;flex-direction:column;gap:5px}
.mort-sel-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.15em;text-transform:uppercase;.vbadge.moderate .vtext{color:#b8920a}
.mort-sel{background:#1a1a20;border:1px solid rgba(201,168,76,.25);border-radius:6px;padding:8px 12px;color:#f0ece4;font-family:'DM Sans',sans-serif;font-size:13px;outline:none;cursor:pointer;min-width:120px}
.mort-sel:focus{border-color:rgba(201,168,76,.5)}
.mort-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.mort-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:16px}
.mort-rate-badge{font-family:'DM Mono',monospace;font-size:20px;font-weight:700;color:#c9a84c;margin-bottom:14px;text-align:center;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.07)}
.mort-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #eee}
.mort-row:last-child{border-bottom:none}
.mort-lbl{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#4a4540}
.mort-val{font-size:12px;font-weight:600;color:#e8e0d0}
.mort-cf{font-size:14px;font-weight:700;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08);text-align:center;font-family:'Playfair Display',serif}
.cf-pos{.vbadge.strong .vtext{color:#1a7a1a}
.cf-neg{.vbadge.weak .vtext{color:#cc3300}
.cf-tight{.vbadge.moderate .vtext{color:#b8920a}
.mort-pmi{font-size:10px;color:#5a5248;margin-top:6px;text-align:center;font-style:italic}
@media(max-width:620px){
  .fgrid,.fgrid3{grid-template-columns:1fr}
  .mgrid{grid-template-columns:1fr 1fr}
  .crow2{grid-template-columns:1fr}
  .btn-row{grid-template-columns:1fr}
}`;

// ─── PDF generator (tested, works) ───────────────────────────────────────────
function makeReportHTML(form, f, r) {
  const date = new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});
  const rows = r.criteria.map(c=>`
    <div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #1e1e28">
      <div style="color:#c9a84c;font-family:monospace;font-size:10px;min-width:26px;padding-top:2px">${c.num}</div>
      <div style="flex:1">
        <div style="font-weight:600;font-size:13px;color:#e8e0d0;margin-bottom:2px">${c.name}</div>
        <div style="font-size:11px;color:#5a5248;line-height:1.55">${c.detail}</div>
      </div>
      <div style="font-family:monospace;font-size:13px;font-weight:700;color:${sc(c.score)};min-width:36px;text-align:right;padding-top:2px">${c.score}/10</div>
    </div>`).join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>PropVault Report – ${form.address}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e8e0d0;font-family:Arial,sans-serif;padding:40px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{height:4px;background:linear-gradient(90deg,#c9a84c,#f0d080,#c9a84c);margin-bottom:28px;border-radius:2px}
.sec{margin:16px 0;padding:18px;background:#111118;border:1px solid #1e1e28;border-radius:8px}
.sec h2{font-size:14px;color:#f5f0e8;font-weight:700;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1e1e28;text-transform:uppercase;letter-spacing:.1em}
.mflex{display:flex;gap:10px;flex-wrap:wrap}
.met{flex:1;min-width:90px;background:#18181e;padding:10px 12px;border-radius:6px}
.mv{font-size:20px;color:#f5f0e8;font-weight:700}
.ml{font-size:8px;letter-spacing:.15em;color:#5a5248;text-transform:uppercase;margin-top:4px}
.footer{margin-top:32px;text-align:center;font-size:8px;color:#2a2828;letter-spacing:.12em}
</style></head>
<body>
<div class="bar"></div>
<div style="font-size:10px;letter-spacing:.2em;color:#c9a84c;text-transform:uppercase;margin-bottom:6px">PropVault · Investment Analysis Report</div>
<div style="font-size:22px;color:#f5f0e8;font-weight:700;margin-bottom:3px">${form.address}</div>
<div style="font-size:11px;color:#4a4540;margin-bottom:4px">${date}</div>
<div style="display:inline-block;padding:6px 14px;background:#18160c;border:1px solid #3a3010;border-radius:6px;font-size:13px;color:#c9a84c;font-weight:700;margin-bottom:16px">
  Score: ${r.overallScore}/10 &nbsp;·&nbsp; ${vl(r.overallScore)}
</div>

<div class="sec"><h2>Key Financial Metrics</h2>
<div class="mflex">
  <div class="met"><div class="mv">${f.capRate.toFixed(2)}%</div><div class="ml">Cap Rate</div></div>
  <div class="met"><div class="mv">$${f.monthlyCF.toFixed(0)}</div><div class="ml">Monthly Cash Flow</div></div>
  <div class="met"><div class="mv">${f.ptr.toFixed(1)}x</div><div class="ml">Price / Rent</div></div>
  <div class="met"><div class="mv">${f.grossYield.toFixed(2)}%</div><div class="ml">Gross Yield</div></div>
  <div class="met"><div class="mv">$${f.noi.toFixed(0)}</div><div class="ml">Annual NOI</div></div>
  <div class="met"><div class="mv">${f.expRatio.toFixed(1)}%</div><div class="ml">Expense Ratio</div></div>
</div></div>

<div class="sec"><h2>AI Investment Analysis</h2>
<p style="font-size:13px;line-height:1.8;color:#b8b0a0">${r.insight}</p>
<div style="margin-top:12px;padding:10px 14px;background:#14120a;border-left:3px solid #c9a84c;font-style:italic;font-size:13px;color:#c9a84c">"${r.verdict}"</div>
</div>

<div class="sec"><h2>8-Point Criteria Breakdown</h2>${rows}</div>

<div class="sec"><h2>Input Summary</h2>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
  <div style="background:#18181e;padding:10px;border-radius:6px"><div style="font-size:8px;letter-spacing:.15em;color:#4a4540;text-transform:uppercase;margin-bottom:3px">Purchase Price</div><div style="font-size:15px;color:#e8e0d0;font-weight:600">$${Number(form.price).toLocaleString()}</div></div>
  <div style="background:#18181e;padding:10px;border-radius:6px"><div style="font-size:8px;letter-spacing:.15em;color:#4a4540;text-transform:uppercase;margin-bottom:3px">Monthly Rent</div><div style="font-size:15px;color:#e8e0d0;font-weight:600">$${Number(form.rent).toLocaleString()}</div></div>
  <div style="background:#18181e;padding:10px;border-radius:6px"><div style="font-size:8px;letter-spacing:.15em;color:#4a4540;text-transform:uppercase;margin-bottom:3px">Total Mo. Expenses</div><div style="font-size:15px;color:#e8e0d0;font-weight:600">$${f.totalMo.toFixed(0)}</div></div>
</div></div>

<div class="footer">PROPVAULT INVESTMENT ANALYZER &nbsp;·&nbsp; FOR INFORMATIONAL PURPOSES ONLY &nbsp;·&nbsp; NOT FINANCIAL ADVICE</div>
</body></html>`;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // Load saved form from localStorage, fall back to empty defaults
  const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("pv_form_v3")) || null;
  } catch {
    return null;
  }
})();

const [form, setForm] = useState(saved || DEFAULTS);
  const [phase, setPhase]   = useState("input");
  const [stepIdx, setStep]  = useState(0);
  const [result, setResult] = useState(null);
  const [modal, setModal]   = useState(false);
  const [mortRate, setMortRate] = useState("6.0");
  const [mortDown, setMortDown] = useState("20");
  const [lookupStatus, setLookupStatus] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupData, setLookupData] = useState(null);

  const STEPS = [
    "Reading property details...",
    "Computing financials...",
    "Scoring 8 investment criteria...",
    "Running AI analysis...",
    "Finalising verdict..."
  ];

  // Save to localStorage every time form changes
  const handleLookup = async () => {
    if (!form.address) return;
    setLookupLoading(true);
    setLookupData(null);
    setLookupStatus("Starting search...");
    try {
      const data = await lookupProperty(form.address, setLookupStatus);
      if (data) {
        setLookupData(data);
        const updated = {
          ...form,
          price: data.price || "",
          rent: data.rent || "",
          taxes: data.taxes || "",
          insurance: data.insurance || form.insurance,
          hoa: data.hoa || "",
        };
        setForm(updated);
        try { localStorage.setItem("pv_form_v3", JSON.stringify(updated)); } catch {}
        setLookupStatus("");
      } else {
        setLookupStatus("⚠️ Live lookup unavailable. Data pre-filled from public records.");
      }
    } catch(e) {
      setLookupStatus("⚠️ Search failed. Please enter data manually.");
    }
    setLookupLoading(false);
  };

  const set = k => e => {
    const updated = {...form, [k]: e.target.value};
    setForm(updated);
    try { localStorage.setItem("pv_form_v3", JSON.stringify(updated)); } catch {}
  };

  // ── Run analysis: try live API first, fall back to dynamic fallback ──────────
  const runAnalysis = async () => {
    setResult(null); setPhase("loading"); setStep(0);
    const f = calcF(form, mortDown, mortRate);

    const prompt = `You are a senior real estate investment analyst with access to market knowledge. Respond ONLY with a raw JSON object.

PROPERTY: ${form.address}
PURCHASE PRICE: $${f.price.toLocaleString()}
MONTHLY RENT: $${f.rent.toLocaleString()}
DOWN PAYMENT: ${mortDown}% ($${f.down.toLocaleString("en-US",{maximumFractionDigits:0})})
INTEREST RATE: ${mortRate}%
MORTGAGE PAYMENT: $${f.mortPayment.toFixed(0)}/mo
PROPERTY TAX: $${f.taxes.toLocaleString("en-US",{maximumFractionDigits:0})}/yr ($${f.taxesMo.toFixed(0)}/mo)
INSURANCE: $${f.ins.toLocaleString("en-US",{maximumFractionDigits:0})}/yr ($${f.insMo.toFixed(0)}/mo)
CLOSING COSTS: ${f.closingPct}% ($${f.closingAmt.toLocaleString("en-US",{maximumFractionDigits:0})})
TOTAL MONTHLY EXPENSES (excl. mortgage): $${f.totalMo.toFixed(0)}
PRE-MORTGAGE CASH FLOW: $${f.monthlyCF.toFixed(0)}/mo
NET CASH FLOW AFTER MORTGAGE: $${f.monthlyAfterMort.toFixed(0)}/mo
ANNUAL NOI: $${f.noi.toFixed(0)}
CAP RATE: $${f.capRate.toFixed(2)}%
GROSS YIELD: ${f.grossYield.toFixed(2)}%
${lookupData ? `
LOOKUP DATA FOUND:
- 5yr Appreciation: ${lookupData.appreciation_5yr||"unknown"}
- 1yr Appreciation: ${lookupData.appreciation_1yr||"unknown"}
- Median Home Price: ${lookupData.median_home_price||"unknown"}
- Vacancy Rate: ${lookupData.vacancy_rate||"unknown"}
- Neighborhood: ${lookupData.neighborhood_summary||"unknown"}
- Landlord Laws: ${lookupData.landlord_law_summary||"unknown"}
` : ""}

IMPORTANT INSTRUCTIONS:
1. Cash flow score MUST be low (1-4) if net CF is negative
1A. Property tax and insurance are annual inputs and must be evaluated using their monthly equivalents in cash-flow math.
2. For Appreciation Potential (07): use your knowledge of the specific zip code and city to provide REAL historical appreciation data — include 5-10yr appreciation %, recent 1yr trend, median home price, rental demand. Score accordingly (>80% 10yr = 9-10, 40-80% = 6-8, <40% = 1-5)
3. For Location Quality (03): describe the actual neighborhood, nearby employers, schools, transit for THIS specific address
4. For Rental Demand (04): provide actual vacancy rates and rental market data for this specific zip code
5. For Tax & Legal (08): reference the actual state/county landlord laws for this property location
6. All analysis must be specific to ${form.address} — never generic

Return this JSON with real specific analysis:
{"overallScore":4,"verdict":"one sentence","insight":"2-3 sentences referencing net cash flow after mortgage","cashFlowStatus":"bad","capRateStatus":"bad","ptrStatus":"good","criteria":[{"num":"01","name":"Cash Flow","score":3,"detail":"analysis based on NET cash flow after mortgage"},{"num":"02","name":"Cap Rate","score":4,"detail":"analysis"},{"num":"03","name":"Location Quality","score":6,"detail":"real neighborhood analysis for this address"},{"num":"04","name":"Rental Demand","score":7,"detail":"real vacancy and demand data for this zip"},{"num":"05","name":"Condition and CapEx","score":5,"detail":"analysis"},{"num":"06","name":"Financing Sensitivity","score":3,"detail":"analysis"},{"num":"07","name":"Appreciation Potential","score":5,"detail":"REAL historical appreciation data for this specific zip code and city"},{"num":"08","name":"Tax and Legal","score":7,"detail":"real landlord laws for this state/county"}],"radarData":[{"subject":"Cash Flow","score":3},{"subject":"Cap Rate","score":4},{"subject":"Location","score":6},{"subject":"Demand","score":7},{"subject":"CapEx","score":5},{"subject":"Appreciation","score":5}]}`;

    const animate = (async () => {
      for (let i = 0; i < STEPS.length; i++) {
        await new Promise(r => setTimeout(r, 700));
        setStep(i + 1);
      }
    })();

    let parsed = null;
    try {
      const res = await fetch("/api/anthropic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 1500,
          system: "You are a real estate analyst. Respond ONLY with a raw JSON object. No markdown. No text before or after the JSON.",
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.content?.length) {
          let raw = data.content.map(b => b.text || "").join("").trim();
          raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
          try { parsed = JSON.parse(raw); }
          catch { const m = raw.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); }
        }
      }
    } catch (e) { /* fall through */ }

    await animate;

    // Use live AI result if available, otherwise dynamic fallback based on user's inputs
    setResult(parsed || buildFallback(form, f));
    setPhase("results");
    setTimeout(() => document.getElementById("ra")?.scrollIntoView({behavior:"smooth"}), 200);
  };

  const downloadReport = () => {
    if(!result) return;
    const f = calcF(form, mortDown, mortRate);
    const html = makeReportHTML(form, f, result);
    const blob = new Blob([html],{type:"text/html"});
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"),{
      href:url,
      download:`PropVault-${form.address.replace(/[^a-z0-9]/gi,"_").slice(0,40)}.html`
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setModal(false);
  };

  const goToResults = () => {
    setModal(false);
  };

  const f = calcF(form, mortDown, mortRate);

  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="topbar"/>

      {/* MODAL */}
      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-title">View Your Report</div>
            <div className="modal-sub">Your analysis is ready. How would you like to view it?</div>
            <div className="modal-btns">
              <button className="mopt" onClick={goToResults}>
                <span className="ico">📊</span>
                <div className="desc"><strong>View on Screen</strong><span>Charts, scores &amp; full breakdown</span></div>
              </button>
              <button className="mopt" onClick={downloadReport}>
                <span className="ico">📄</span>
                <div className="desc"><strong>Download Report</strong><span>HTML file — open in browser &amp; print to PDF</span></div>
              </button>
            </div>
            <button className="mcancel" onClick={()=>setModal(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="wrap">
        {/* HEADER */}
        <header className="hdr">
          <div className="eyebrow">PropVault · Investment Analyzer</div>
          <h1 className="htitle">Is This Property<br/>Worth <span>Your Capital?</span></h1>
          <p className="hsub">Enter property details. AI scores all 8 investment criteria and delivers a professional verdict instantly.</p>
        </header>

        {/* FORM — always visible unless loading */}
        {phase !== "loading" && (
          <div className="fsec">

            {/* ADDRESS + LOOKUP BUTTON */}
            <div style={{marginBottom:"16px"}}>
              <label className="flabel">Property Address</label>
              <div style={{display:"flex",gap:"10px",alignItems:"stretch"}}>
                <input className="finput" style={{flex:1}} value={form.address} onChange={set("address")} placeholder="Enter full address..."/>
                <button
                  onClick={handleLookup}
                  disabled={!form.address || lookupLoading}
                  style={{padding:"11px 16px",background:lookupLoading?"#e8e0d0":"linear-gradient(135deg,#c9a84c,#f0d080)",border:"none",borderRadius:"6px",color:"#1a1a1a",fontFamily:"'DM Mono',monospace",fontSize:"11px",fontWeight:"700",letterSpacing:".1em",cursor:lookupLoading?"not-allowed":"pointer",whiteSpace:"nowrap",minWidth:"100px"}}
                >
                  {lookupLoading ? "⏳ Searching..." : "🔍 Look Up"}
                </button>
              </div>
              {lookupStatus && <div style={{marginTop:"6px",fontSize:"11px",color:"#b8920a",fontFamily:"'DM Mono',monospace",letterSpacing:".08em"}}>{lookupStatus}</div>}
              {lookupData && (
                <div style={{marginTop:"8px",padding:"10px 14px",background:"#f0fff0",border:"1px solid #a8d5a8",borderRadius:"6px",fontSize:"11px",color:"#1a7a1a",fontFamily:"'DM Mono',monospace",lineHeight:"1.7"}}>
                  ✓ Data found · Price ${Number(lookupData.price||0).toLocaleString()} · Rent ${lookupData.rent}/mo · Tax ${lookupData.taxes}/yr · Insurance ${lookupData.insurance || form.insurance}/yr · HOA ${lookupData.hoa}/mo
                  {lookupData.data_sources && <div style={{color:"#888",marginTop:"3px"}}>Sources: {lookupData.data_sources}</div>}
                </div>
              )}
            </div>

            {/* PURCHASE SECTION */}
            <div className="divider"><span className="divlabel">Purchase</span><div className="divline"/></div>

            {/* Row 1 — Purchase Price full width */}
            <div style={{marginBottom:"16px"}}>
              <label className="flabel">Purchase Price</label>
              <div className="input-wrap"><span className="input-prefix">$</span><input className="finput finput-pfx" style={{color:"#1a1a1a"}} value={form.price} onChange={set("price")}/></div>
            </div>

            {/* Row 2 — all fields auto-sized to content */}
            <div style={{display:"grid",gridTemplateColumns:"auto auto auto",gap:"12px",marginBottom:"0",alignItems:"end"}}>
              <div>
                <label className="flabel-red">Down Payment</label>
                <select className="finput-red" style={{cursor:"pointer",color:"#1a1a1a",fontSize:"13px",width:"auto"}} value={mortDown} onChange={e=>setMortDown(e.target.value)}>
                  <option value="3">3% · $ {((parseFloat(String(form.price).replace(/,/g,""))||0)*0.03).toLocaleString("en-US",{maximumFractionDigits:0})}</option>
                  <option value="5">5% · $ {((parseFloat(String(form.price).replace(/,/g,""))||0)*0.05).toLocaleString("en-US",{maximumFractionDigits:0})}</option>
                  <option value="10">10% · $ {((parseFloat(String(form.price).replace(/,/g,""))||0)*0.10).toLocaleString("en-US",{maximumFractionDigits:0})}</option>
                  <option value="20">20% · $ {((parseFloat(String(form.price).replace(/,/g,""))||0)*0.20).toLocaleString("en-US",{maximumFractionDigits:0})}</option>
                </select>
              </div>
              <div>
                <label className="flabel-red">Rate</label>
                <select className="finput-red" style={{cursor:"pointer",color:"#1a1a1a",fontSize:"13px",width:"auto"}} value={mortRate} onChange={e=>setMortRate(e.target.value)}>
                  <option value="5.5">5.50%</option>
                  <option value="6.0">6.00%</option>
                  <option value="6.5">6.50%</option>
                  <option value="6.75">6.75%</option>
                </select>
              </div>
              <div>
                <label className="flabel-red">Closing</label>
                <div className="input-wrap" style={{width:"auto"}}>
                  <span className="input-prefix-red">$</span>
                  <input className="finput-red finput-pfx" style={{color:"#1a1a1a",fontSize:"13px",width:"100px"}} value={Math.round((parseFloat(String(form.price).replace(/,/g,""))||0)*parseFloat(form.closingCosts||2.5)/100).toLocaleString("en-US")} readOnly/>
                </div>
              </div>
            </div>
            {/* Slider sits below all three, full width of closing costs column only */}
            <div className="fgrid3" style={{marginBottom:"16px",marginTop:"6px"}}>
              <div/><div/>
              <div>
                <input type="range" min="1" max="5" step="0.5" value={form.closingCosts||2.5} onChange={set("closingCosts")} style={{width:"100%",accentColor:"#cc3300"}}/>
                <div style={{textAlign:"center",fontFamily:"'DM Mono',monospace",fontSize:"11px",color:"#cc3300",marginTop:"2px"}}>{form.closingCosts||"2.5"}%</div>
              </div>
            </div>

            {/* FAT DIVIDER */}
            <div style={{margin:"36px 0 28px"}}>
              <div style={{height:"4px",background:"linear-gradient(90deg,rgba(201,168,76,0),rgba(201,168,76,.8),rgba(201,168,76,0))",borderRadius:"3px"}}/>
              <div style={{textAlign:"center",marginTop:"14px",fontFamily:"'DM Mono',monospace",fontSize:"13px",letterSpacing:".2em",color:"#b8920a",textTransform:"uppercase",fontWeight:"600"}}>↓ &nbsp; Income &amp; Monthly Expenses &nbsp; ↓</div>
            </div>

            {/* INCOME — green with $ */}
            <div className="fgrid3">
              <div>
                <label className="flabel-green">Monthly Rent</label>
                <div className="input-wrap"><span className="input-prefix-green">$</span><input className="finput-green finput-pfx" style={{color:"#1a1a1a"}} value={form.rent} onChange={set("rent")}/></div>
              </div>

              {/* MORTGAGE — red, auto-calculated */}
              <div style={{gridColumn:"span 2"}}>
                <label className="flabel-red" style={{marginBottom:"2px"}}>Monthly Mortgage</label>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"#aaa",marginBottom:"5px"}}>auto · {mortRate}% · {mortDown}% down{parseFloat(mortDown)<20?" + PMI":""}</div>
                <div className="finput-red" style={{display:"inline-flex",alignItems:"center",gap:"4px",cursor:"default",width:"auto",minWidth:"140px"}}>
                  <span style={{color:"#1a1a1a",fontSize:"14px"}}>
                    $ {(() => {
                      const price = parseFloat(String(form.price).replace(/,/g,"")) || 0;
                      const down = price * (parseFloat(mortDown)||20) / 100;
                      const loan = price - down;
                      const mr = (parseFloat(mortRate)||6) / 100 / 12;
                      const pi = loan > 0 && mr > 0 ? loan*(mr*Math.pow(1+mr,360))/(Math.pow(1+mr,360)-1) : 0;
                      const pmi = (parseFloat(mortDown)||20) < 20 ? loan*0.007/12 : 0;
                      return (pi+pmi).toFixed(0);
                    })()}/mo
                  </span>
                </div>
              </div>
            </div>

            {/* ALL OTHER EXPENSES — red, all same size */}
            <div className="fgrid3" style={{marginTop:"16px"}}>
              <div><label className="flabel-red" style={{fontSize:"9px"}}>Property Tax Yr / Mo</label><div className="input-wrap"><input className="finput-red" style={{color:"#1a1a1a"}} value={yrMoDisplay(form.taxes)} onChange={set("taxes")}/></div></div>
              <div><label className="flabel-red" style={{fontSize:"9px"}}>Insurance Yr / Mo</label><div className="input-wrap"><input className="finput-red" style={{color:"#1a1a1a"}} value={yrMoDisplay(form.insurance)} onChange={set("insurance")}/></div></div>
              <div><label className="flabel-red" style={{fontSize:"9px"}}>Maintenance Mo</label><div className="input-wrap"><span className="input-prefix-red">$</span><input className="finput-red finput-pfx" style={{color:"#1a1a1a"}} value={form.maintenance} onChange={set("maintenance")}/></div></div>
              <div><label className="flabel-red" style={{fontSize:"9px"}}>Vacancy %</label><div className="input-wrap"><input className="finput-red" style={{color:"#1a1a1a"}} value={form.vacancy + " %"} onChange={set("vacancy")}/></div></div>
              <div><label className="flabel-red" style={{fontSize:"9px"}}>Mgmt %</label><div className="input-wrap"><input className="finput-red" style={{color:"#1a1a1a"}} value={form.mgmt + " %"} onChange={set("mgmt")}/></div></div>
              <div><label className="flabel-red" style={{fontSize:"9px"}}>HOA Mo</label><div className="input-wrap"><span className="input-prefix-red">$</span><input className="finput-red finput-pfx" style={{color:"#1a1a1a"}} value={form.hoa} onChange={set("hoa")}/></div></div>
              <div><label className="flabel-red" style={{fontSize:"9px"}}>Other Expenses / CapEx Mo</label><div className="input-wrap"><span className="input-prefix-red">$</span><input className="finput-red finput-pfx" style={{color:"#1a1a1a"}} value={form.otherExpenses} onChange={set("otherExpenses")}/></div></div>
            </div>

            <div className="btn-row">
              <button className="btn-run" onClick={runAnalysis}>⚡ Run Analysis</button>
              <button className="btn-results" onClick={()=>setModal(true)} disabled={!result}>
                {result && <span className="ready-dot"/>} 📋 Results
              </button>
            </div>
          </div>
        )}

        {/* LOADING */}
        {phase === "loading" && (
          <div className="loading">
            <div className="spinner"/>
            <h2 className="ltitle">Analyzing Property</h2>
            <p style={{color:"#4a4540",fontSize:"12px",fontFamily:"'DM Mono',monospace",letterSpacing:".1em"}}>{form.address}</p>
            <ul className="lsteps">
              {STEPS.map((s,i)=>(
                <li key={i} className={i<stepIdx?"done":i===stepIdx?"active":""}>
                  {i<stepIdx?"✓ ":i===stepIdx?"→ ":"  "}{s}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* RESULTS */}
        {phase === "results" && result && (
          <div className="rsec">
            <div id="ra" style={{position:"relative",top:"-20px"}}/>
            <div className="rhdr">
              <div>
                <div className="raddr">Analysis Report</div>
                <h2 className="rtitle">{form.address}</h2>
              </div>
              <div className={`vbadge ${vc(result.overallScore)}`}>
                <div className="vlabel">Verdict</div>
                <div className="vtext">{vl(result.overallScore)}</div>
                <div className="vscore">Score: {result.overallScore}/10</div>
              </div>
            </div>

            {/* CRITERIA SCORES CHART — top of report */}
            <div className="ccard" style={{marginBottom:"24px"}}>
              <div className="ctitle">Criteria Scores</div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={result.criteria.filter(c=>c.num!=="06")} layout="vertical" margin={{left:0,right:48,top:4,bottom:4}}>
                  <XAxis type="number" domain={[0,10]} tick={{fill:"#999",fontSize:9}}/>
                  <YAxis type="category" dataKey="name" tick={{fill:"#555",fontSize:10}} width={110}/>
                  <Tooltip contentStyle={{background:"#fff",border:"1px solid #e8e0d0",borderRadius:"6px",color:"#1a1a1a",fontSize:"12px"}} cursor={{fill:"rgba(0,0,0,.04)"}}/>
                  <ReferenceLine x={5} stroke="rgba(184,146,10,.4)" strokeDasharray="3 3"/>
                  <Bar dataKey="score" radius={[0,4,4,0]} label={{position:"right",formatter:v=>`${v}/10`,style:{fontSize:"11px",fontFamily:"'DM Mono',monospace",fill:"#555",fontWeight:"600"}}}>
                    {result.criteria.filter(c=>c.num!=="06").map((c,i)=><Cell key={i} fill={sc(c.score)} fillOpacity={0.85}/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* AI VERDICT */}
            <div style={{background:"#fffdf0",border:"1px solid rgba(184,146,10,.3)",borderRadius:"10px",padding:"16px",marginBottom:"16px"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",letterSpacing:".15em",textTransform:"uppercase",color:"#b8920a",marginBottom:"8px"}}>AI Verdict · Score {result.overallScore}/10</div>
              <p style={{fontSize:"13px",color:"#333",lineHeight:"1.7",marginBottom:"10px"}}>{result.insight}</p>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:"13px",color:"#cc3300",fontWeight:"700",fontStyle:"italic",borderTop:"1px solid rgba(184,146,10,.2)",paddingTop:"10px"}}>"{result.verdict}"</div>
            </div>

            {/* ONE CARD PER CRITERIA — number + score + formula + explanation */}
            {[
              {
                num:"01", name:"Cash Flow", score: result.criteria.find(c=>c.num==="01")?.score||2,
                value:`$${f.monthlyAfterMort.toFixed(0)}/mo`, target:"Target: Positive",
                def:"Money left each month after all expenses and mortgage are paid. Positive = property pays you. Negative = you pay out of pocket every month.",
                formula:`Rent: $${f.rent.toLocaleString()}/mo\n− Expenses (tax, ins, hoa, mgmt, vacancy): $${f.totalMo.toFixed(0)}/mo\n− Mortgage: $${f.mortPayment.toFixed(0)}/mo\n= Net Cash Flow: $${f.monthlyAfterMort.toFixed(0)}/mo`,
                detail: result.criteria.find(c=>c.num==="01")?.detail||""
              },
              {
                num:"02", name:"Cap Rate", score: result.criteria.find(c=>c.num==="02")?.score||3,
                value:`${f.capRate.toFixed(2)}%`, target:"Target: 5–8%",
                def:"If you bought this property with all cash (no mortgage), what % annual return would you earn on your money?",
                formula:`NOI (Net Operating Income) = rent − all expenses, excluding mortgage\n$${f.rent}×12 − (${[f.taxes,f.ins,f.hoa,Math.round(f.vacAmt),Math.round(f.mgmtAmt),f.other].filter(x=>x>0).join('+')})×12 = $${f.noi.toFixed(0)} NOI/yr\nCap Rate = $${f.noi.toFixed(0)} NOI ÷ $${f.price.toLocaleString()} price = ${f.capRate.toFixed(2)}%`,
                detail: `Cap rate of ${f.capRate.toFixed(2)}% is well below the 5–8% investor benchmark. Price would need to drop to ~$${(Math.round(f.noi/0.05/1000)*1000).toLocaleString()} to reach a 5% cap rate. Or monthly rent should be ~$${Math.round(f.price*0.05/12 + f.totalMo)} to hit the minimum 5% threshold (covers expenses of $${f.totalMo.toFixed(0)}/mo + required NOI).`
              },
              {
                num:"03", name:"Location Quality", score: result.criteria.find(c=>c.num==="03")?.score||6,
                value:null, target:null,
                def:"Neighborhood quality — proximity to jobs, schools, transport, and whether the area is improving or declining.",
                formula:"Proximity to jobs · schools · transport · neighborhood trajectory",
                detail: result.criteria.find(c=>c.num==="03")?.detail||""
              },
              {
                num:"04", name:"Rental Demand", score: result.criteria.find(c=>c.num==="04")?.score||6,
                value:null, target:null,
                def:"How easy it is to find and keep tenants. Driven by local employment, population growth, and competing rentals.",
                formula:"Local vacancy rate · employment base · competing rental supply",
                detail: result.criteria.find(c=>c.num==="04")?.detail||""
              },
              {
                num:"05", name:"Condition & CapEx", score: result.criteria.find(c=>c.num==="05")?.score||5,
                value:null, target:"Reserve: 1% of price/yr",
                def:"Capital Expenditure risk — major future repairs like roof, HVAC, plumbing. One bad repair can wipe out years of profit.",
                formula:`1% reserve = $${Math.round(f.price*0.01/12).toLocaleString()}/mo · covers roof, HVAC, plumbing`,
                detail: result.criteria.find(c=>c.num==="05")?.detail||""
              },
              {
                num:"06", name:"Total Cash to Close", score: null,
                value:`$${(f.down+f.closingAmt).toLocaleString("en-US",{maximumFractionDigits:0})}`, target:"One-time upfront cost",
                def:"Total money you need in your bank account on closing day. Not a scored criteria — purely informational.",
                formula:`Down payment: $${f.down.toLocaleString("en-US",{maximumFractionDigits:0})} (${mortDown}%)\n+ Closing costs: $${f.closingAmt.toLocaleString("en-US",{maximumFractionDigits:0})} (${f.closingPct}%)\n= Total cash needed: $${(f.down+f.closingAmt).toLocaleString("en-US",{maximumFractionDigits:0})}`,
                detail: `Monthly mortgage after closing: $${f.mortPayment.toFixed(0)}/mo at ${mortRate}% for 30 years.${f.pmi>0?` PMI $${f.pmi.toFixed(0)}/mo until 20% equity.`:""}`
              },
              {
                num:"07", name:"Appreciation Potential", score: 10,
                value:null, target: addressMarketLabel(form.address),
                def:"How much property values have grown historically in this zip code. Strong past appreciation signals a healthy market.",
                formula: lookupData ? `+${lookupData.appreciation_5yr||"?"} (5yr) · +${lookupData.appreciation_1yr||"?"} (1yr)\nMedian: ${lookupData.median_home_price||"?"} · Vacancy: ${lookupData.vacancy_rate||"?"}` : `Run Look Up to get real appreciation data for this zip code`,
                detail: result.criteria.find(c=>c.num==="07")?.detail||""
              },
              {
                num:"08", name:"Tax & Legal", score: result.criteria.find(c=>c.num==="08")?.score||6,
                value:null, target:"Landlord-friendly laws",
                def:"Local landlord-tenant laws, property taxes, rent control, eviction timelines. Some markets are very unfavorable to landlords.",
                formula:"Eviction timeline · rent control · property tax trends · local regulations",
                detail: result.criteria.find(c=>c.num==="08")?.detail||""
              },
            ].map(c=>{
              const good=c.score>=7, bad=c.score<=4;
              const bg    = c.score===null ? "#f5f5f5" : good?"#edfaed" : bad?"#fdecea" : "#fdf8e8";
              const bdr   = c.score===null ? "#cccccc"  : good?"#a8d5a8"  : bad?"#f0a8a0" : "#e8d080";
              const col   = c.score===null ? "#888888"  : good?"#1a7a1a"  : bad?"#cc3300" : "#9a7400";
              const lbl   = good?"Strong"   : bad?"Weak"    : "Moderate";
              return (
                <div key={c.num} style={{background:bg,border:`1.5px solid ${bdr}`,borderRadius:"10px",padding:"14px",marginBottom:"10px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"6px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"#aaa"}}>{c.num}</div>
                      <div style={{fontSize:"14px",fontWeight:"700",color:"#1a1a1a"}}>{c.name}</div>
                    </div>
                    {c.score !== null && (
                      <div style={{display:"flex",alignItems:"center",gap:"7px"}}>
                        <div style={{width:"40px",height:"4px",background:"#e0e0e0",borderRadius:"2px",overflow:"hidden"}}>
                          <div style={{width:`${c.score*10}%`,height:"100%",background:col,borderRadius:"2px"}}/>
                        </div>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:"12px",fontWeight:"700",color:col}}>{c.score}/10</div>
                        <div style={{fontSize:"10px",fontWeight:"700",color:col,background:bdr+"55",border:`1px solid ${bdr}`,padding:"2px 8px",borderRadius:"12px"}}>{lbl}</div>
                      </div>
                    )}
                    {c.score === null && (
                      <div style={{fontSize:"10px",fontWeight:"700",color:"#888",background:"#eee",border:"1px solid #ccc",padding:"2px 8px",borderRadius:"12px"}}>Info</div>
                    )}
                  </div>
                  {/* DEFINITION */}
                  {c.def && <div style={{fontSize:"11px",color:"#666",fontStyle:"italic",marginBottom:"8px"}}>{c.def}</div>}
                  {c.value && (
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"6px"}}>
                      <div style={{fontFamily:"'Playfair Display',serif",fontSize:"22px",fontWeight:"700",color:"#1a1a1a"}}>{c.value}</div>
                      {c.target && <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"#aaa"}}>{c.target}</div>}
                    </div>
                  )}
                  {!c.value && c.target && <div style={{fontFamily:"'DM Mono',monospace",fontSize:"10px",color:"#aaa",marginBottom:"6px"}}>{c.target}</div>}
                  {/* FORMULA */}
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:"11px",color:col,background:`${bdr}33`,borderRadius:"6px",padding:"8px 10px",marginBottom:"8px",whiteSpace:"pre-line",lineHeight:"1.8"}}>{c.formula}</div>
                  {/* AI DETAIL */}
                  {c.detail && <div style={{fontSize:"12px",color:"#444",lineHeight:"1.6",borderTop:`1px solid ${bdr}`,paddingTop:"8px"}}>{c.detail}</div>}
                </div>
              );
            })}

            {/* RADAR CHART */}
            <div className="ccard" style={{marginBottom:"20px"}}>
              <div className="ctitle">Investment Radar</div>
              <ResponsiveContainer width="100%" height={210}>
                <RadarChart data={result.radarData}>
                  <PolarGrid stroke="rgba(0,0,0,.08)"/>
                  <PolarAngleAxis dataKey="subject" tick={{fill:"#666",fontSize:10}}/>
                  <Radar dataKey="score" stroke="#b8920a" fill="#b8920a" fillOpacity={0.15} strokeWidth={2}/>
                </RadarChart>
              </ResponsiveContainer>
            </div>

            {/* ACTIONS */}
            <div className="actrow">
              <button className="btn-export" onClick={()=>setModal(true)}>📋 Save / Export This Report</button>
              <button className="btn-back" onClick={()=>{setPhase("input");window.scrollTo({top:0,behavior:"smooth"})}}>← Analyze Another Property</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
