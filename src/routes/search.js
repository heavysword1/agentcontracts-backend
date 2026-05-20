const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();

const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache
const SAM_API_KEY = process.env.SAM_API_KEY;
const BASE_URL = 'https://api.sam.gov/opportunities/v2/search';

// Bazaar extension info
const bazaarInfo = {
  input: {
    type: 'http',
    method: 'GET',
    queryParams: {
      keyword: 'software development',
      naics: '541511',
      limit: '10',
      set_aside: 'SBA',
      agency: 'DEPT OF DEFENSE',
      due_after: '2026-01-01'
    },
    schema: {
      properties: {
        keyword:    { type: 'string', description: 'Search keyword or phrase' },
        naics:      { type: 'string', description: '6-digit NAICS code' },
        limit:      { type: 'string', description: 'Number of results (max 25)' },
        set_aside:  { type: 'string', description: 'Set-aside type: SBA, 8A, SDVOSBC, WOSB, HZC, etc.' },
        agency:     { type: 'string', description: 'Awarding agency name (partial match)' },
        due_after:  { type: 'string', description: 'Only show opportunities due after this date (YYYY-MM-DD)' }
      },
      required: []
    }
  },
  output: {
    example: {
      success: true,
      count: 2,
      opportunities: [
        {
          id: 'abc123',
          title: 'Software Development Services',
          agency: 'DEPT OF DEFENSE',
          naics: '541511',
          type: 'Solicitation',
          set_aside: 'Small Business',
          deadline: '2026-06-15T17:00:00',
          posted: '2026-05-01',
          description_preview: 'The Department of Defense seeks software development support...',
          url: 'https://sam.gov/opp/abc123/view'
        }
      ]
    }
  }
};

// POST x402 paid route
router.get('/', async (req, res) => {
  try {
    const { keyword, naics, limit = 10, set_aside, agency, due_after } = req.query;

    const cacheKey = `search:${keyword}:${naics}:${limit}:${set_aside}:${agency}:${due_after}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const params = {
      api_key: SAM_API_KEY,
      limit: Math.min(parseInt(limit) || 10, 25),
      offset: 0,
      postedFrom: due_after ? toSamDate(due_after) : getDateDaysAgo(90),
      postedTo: getTodayStr()
    };

    if (keyword) params.q = keyword;
    if (naics) params.naicsCode = naics;

    // SAM.gov set-aside codes
    const setAsideMap = {
      'SBA': 'SBA', '8A': '8A', 'SDVOSBC': 'SDVOSBC',
      'WOSB': 'WOSB', 'HZC': 'HZC', 'HS3': 'HS3'
    };
    if (set_aside && setAsideMap[set_aside.toUpperCase()]) {
      params.ntype = setAsideMap[set_aside.toUpperCase()];
    }

    const response = await axios.get(BASE_URL, { params, timeout: 10000 });
    const data = response.data;

    const opps = (data.opportunitiesData || []).map(opp => ({
      id: opp.noticeId,
      title: opp.title,
      agency: opp.fullParentPathName || opp.organizationName,
      naics: opp.naicsCode,
      type: opp.type,
      set_aside: opp.typeOfSetAside || 'None',
      deadline: opp.responseDeadLine,
      posted: opp.postedDate,
      description_preview: (opp.description || '').substring(0, 200).replace(/<[^>]*>/g, '').trim() + '...',
      url: `https://sam.gov/opp/${opp.noticeId}/view`
    })).filter(opp => {
      if (!agency) return true;
      return (opp.agency || '').toLowerCase().includes(agency.toLowerCase());
    });

    const result = {
      success: true,
      count: opps.length,
      total_available: data.totalRecords || opps.length,
      opportunities: opps,
      source: 'SAM.gov — US Federal Contract Opportunities',
      disclaimer: 'Information only. Verify all details on sam.gov before action.'
    };

    cache.set(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('[search] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch opportunities', details: err.message });
  }
});

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toSamDate(d.toISOString().split('T')[0]);
}

function getTodayStr() {
  return toSamDate(new Date().toISOString().split('T')[0]);
}

// SAM.gov expects MM/DD/YYYY
function toSamDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

module.exports = { router, bazaarInfo };
