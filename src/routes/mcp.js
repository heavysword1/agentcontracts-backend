const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();
const cache = new NodeCache({ stdTTL: 300 });

const SAM_API_KEY = process.env.SAM_API_KEY;
const GRANTS_URL = 'https://apply07.grants.gov/grantsws/rest/opportunities/search/';

const TOOLS = [
  {
    name: 'search_contracts',
    description: 'Search active US federal contract opportunities from SAM.gov. Useful for finding RFPs, solicitations, and government procurement opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword or phrase' },
        naics: { type: 'string', description: '6-digit NAICS code for the industry' },
        set_aside: { type: 'string', description: 'Set-aside type: SBA, 8A, SDVOSBC, WOSB, HZC' },
        agency: { type: 'string', description: 'Filter by agency name' },
        limit: { type: 'number', description: 'Number of results (max 25)', default: 10 }
      }
    }
  },
  {
    name: 'search_grants',
    description: 'Search active US federal grant opportunities from Grants.gov. Covers all federal agencies and funding types.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword or phrase' },
        eligibility: { type: 'string', description: 'Eligible applicant type: small_business, nonprofit, state, tribal, individual, university' },
        category: { type: 'string', description: 'Funding category: ST=Science, HL=Health, ED=Education, AG=Agriculture' },
        min_award: { type: 'number', description: 'Minimum award amount in USD' },
        max_award: { type: 'number', description: 'Maximum award amount in USD' },
        limit: { type: 'number', description: 'Number of results (max 25)', default: 10 }
      }
    }
  },
  {
    name: 'search_awards',
    description: 'Search historical US federal contract award data for price intelligence. Find out what similar contracts paid and who won them.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword' },
        naics: { type: 'string', description: '6-digit NAICS code' },
        agency: { type: 'string', description: 'Filter by agency name' },
        limit: { type: 'number', description: 'Number of results (max 25)', default: 10 }
      }
    }
  },
  {
    name: 'search_spending',
    description: 'Search federal award spending data from USAspending.gov. Find awards by keyword, look up a company total federal contracts, or see agency spending breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'awards (search awards), recipient (company history), or agency', default: 'awards' },
        keyword: { type: 'string', description: 'Search keyword (e.g. "artificial intelligence", "cloud services")' },
        recipient: { type: 'string', description: 'Company name (e.g. "Microsoft", "Lockheed Martin")' },
        agency: { type: 'string', description: 'Filter by agency name' },
        min_amount: { type: 'number', description: 'Minimum award amount in USD' },
        limit: { type: 'number', description: 'Number of results (max 25)', default: 10 }
      }
    }
  }
];

function toSamDate(iso) { const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; }
function getDateDaysAgo(days) { const d = new Date(); d.setDate(d.getDate()-days); return toSamDate(d.toISOString().split('T')[0]); }
function getTodayStr() { return toSamDate(new Date().toISOString().split('T')[0]); }

const eligibilityMap = { small_business:'06', nonprofit:'13', state:'00', tribal:'21', individual:'10', university:'12' };

async function executeTool(name, args) {
  switch (name) {
    case 'search_contracts': {
      const { keyword, naics, set_aside, agency, limit = 10 } = args;
      const params = { api_key: SAM_API_KEY, limit: Math.min(limit, 25), offset: 0, postedFrom: getDateDaysAgo(90), postedTo: getTodayStr() };
      if (keyword) params.q = keyword;
      if (naics) params.naicsCode = naics;
      const { data } = await axios.get('https://api.sam.gov/opportunities/v2/search', { params, timeout: 10000 });
      let opps = (data.opportunitiesData || []).map(o => ({ id: o.noticeId, title: o.title, agency: o.fullParentPathName || o.organizationName, naics: o.naicsCode, type: o.type, set_aside: o.typeOfSetAside || 'None', deadline: o.responseDeadLine, posted: o.postedDate, url: `https://sam.gov/opp/${o.noticeId}/view` }));
      if (agency) opps = opps.filter(o => (o.agency||'').toLowerCase().includes(agency.toLowerCase()));
      return { success: true, count: opps.length, total_available: data.totalRecords, opportunities: opps, disclaimer: 'Information only. Verify on sam.gov before action.' };
    }
    case 'search_grants': {
      const { keyword, eligibility, category, min_award, max_award, limit = 10 } = args;
      const body = { keyword: keyword || '', oppStatuses: 'posted', startRecordNum: 0, rows: Math.min(limit, 25) };
      if (eligibility && eligibilityMap[eligibility]) body.eligibilities = eligibilityMap[eligibility];
      if (category) body.fundingCategories = category;
      const { data } = await axios.post(GRANTS_URL, body, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });
      let grants = (data.oppHits || []).map(o => ({ id: o.id, title: o.title, agency: o.agencyName, category: o.fundingCategory, status: o.oppStatus, close_date: o.closeDate, award_ceiling: parseInt(o.awardCeiling) || null, award_floor: parseInt(o.awardFloor) || null, url: `https://grants.gov/search-grants?cfda=${o.cfdaList?.[0]||''}` }));
      if (min_award) grants = grants.filter(g => (g.award_ceiling||0) >= min_award);
      if (max_award) grants = grants.filter(g => (g.award_ceiling||Infinity) <= max_award);
      return { success: true, count: grants.length, total_available: data.hitCount, grants, disclaimer: 'Information only. Verify on grants.gov before applying.' };
    }
    case 'search_awards': {
      const { keyword, naics, agency, limit = 10 } = args;
      const today = new Date(); const from = new Date(); from.setDate(today.getDate()-90);
      const params = { api_key: SAM_API_KEY, limit: Math.min(limit, 25), offset: 0, postedFrom: toSamDate(from.toISOString().split('T')[0]), postedTo: toSamDate(today.toISOString().split('T')[0]) };
      if (keyword) params.q = keyword;
      if (naics) params.naicsCode = naics;
      const { data } = await axios.get('https://api.sam.gov/opportunities/v2/search', { params, timeout: 10000 });
      let awards = (data.opportunitiesData || []).map(o => ({ id: o.noticeId, title: o.title, agency: o.fullParentPathName, naics: o.naicsCode, award_amount: o.award?.amount || null, awardee: o.award?.awardee?.name || null, url: `https://sam.gov/opp/${o.noticeId}/view` }));
      if (agency) awards = awards.filter(a => (a.agency||'').toLowerCase().includes(agency.toLowerCase()));
      const amounts = awards.filter(a => a.award_amount).map(a => a.award_amount);
      const price_intel = amounts.length ? { avg: Math.round(amounts.reduce((a,b)=>a+b,0)/amounts.length), min: Math.min(...amounts), max: Math.max(...amounts) } : null;
      return { success: true, count: awards.length, awards, price_intelligence: price_intel, disclaimer: 'Information only. Verify on sam.gov before action.' };
    }

    case 'search_spending': {
      const { type = 'awards', keyword, recipient, agency, min_amount, limit = 10 } = args;
      const lim = Math.min(limit, 25);
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = `${new Date().getFullYear()-1}-01-01`;
      const filters = { award_type_codes: ['A','B','C','D'], time_period: [{ start_date: startDate, end_date: endDate }] };
      if (keyword) filters.keyword_search = [keyword];
      if (recipient) filters.recipient_search_text = [recipient];
      const body = { filters, fields: ['Award ID','Recipient Name','Award Amount','Awarding Agency','Award Date','Description'], limit: lim, sort: 'Award Amount', order: 'desc' };
      const { data } = await axios.post('https://api.usaspending.gov/api/v2/search/spending_by_award/', body, { timeout: 15000 });
      let awards = data.results || [];
      if (min_amount) awards = awards.filter(a => (a['Award Amount']||0) >= min_amount);
      const totalValue = awards.reduce((s,a) => s+(a['Award Amount']||0), 0);
      return { success: true, type, period: `${startDate} to ${endDate}`, count: awards.length, total_value: totalValue, awards: awards.map(a=>({ recipient:a['Recipient Name'], amount:a['Award Amount'], agency:a['Awarding Agency'], date:a['Award Date'], description:a['Description']?.substring(0,100) })), source: 'USAspending.gov', disclaimer: 'Information only.' };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}


router.get('/', (req, res) => {
  res.json({
    name: 'AgentGov',
    version: '1.0.0',
    transport: 'http',
    protocol: 'mcp',
    tools: ["search_contracts", "search_grants", "search_awards", "search_spending"]
  });
});

router.post('/', async (req, res) => {
  const { jsonrpc, method, params, id } = req.body;
  try {
    let result;
    switch (method) {
      case 'initialize': result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'AgentGov', version: '1.0.0' } }; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'tools/call': { const { name, arguments: a = {} } = params; result = { content: [{ type: 'text', text: JSON.stringify(await executeTool(name, a), null, 2) }] }; break; }
      case 'ping': result = {}; break;
      default: return res.json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method}` }, id });
    }
    res.json({ jsonrpc: '2.0', result, id });
  } catch (err) {
    res.json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id });
  }
});

module.exports = router;
