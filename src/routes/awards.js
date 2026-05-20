const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();

const cache = new NodeCache({ stdTTL: 600 }); // 10 min cache
const SAM_API_KEY = process.env.SAM_API_KEY;
const BASE_URL = 'https://api.sam.gov/opportunities/v2/search';

const bazaarInfo = {
  input: {
    type: 'http',
    method: 'GET',
    queryParams: {
      naics: '541511',
      keyword: 'software development',
      limit: '10',
      agency: 'DEPT OF DEFENSE'
    },
    schema: {
      properties: {
        naics:   { type: 'string', description: '6-digit NAICS code for the industry' },
        keyword: { type: 'string', description: 'Search keyword for past awards' },
        limit:   { type: 'string', description: 'Number of results (max 25)' },
        agency:  { type: 'string', description: 'Filter by awarding agency name' }
      },
      required: []
    }
  },
  output: {
    example: {
      success: true,
      count: 2,
      awards: [
        {
          id: 'def456',
          title: 'IT Support Services Award',
          agency: 'DEPT OF DEFENSE',
          naics: '541511',
          award_date: '2025-11-01',
          award_amount: 450000,
          awardee: 'Acme Tech Solutions LLC',
          set_aside: 'Small Business',
          url: 'https://sam.gov/opp/def456/view'
        }
      ],
      price_intelligence: {
        avg_award_amount: 450000,
        min_award_amount: 50000,
        max_award_amount: 900000,
        most_common_set_aside: 'Small Business'
      }
    }
  }
};

// POST x402 paid route
router.get('/', async (req, res) => {
  try {
    const { naics, keyword, limit = 10, agency } = req.query;

    const cacheKey = `awards:${naics}:${keyword}:${limit}:${agency}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const today = new Date();
    const from = new Date(); from.setDate(today.getDate() - 365);
    const toSamDate = iso => { const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; };

    const params = {
      api_key: SAM_API_KEY,
      limit: Math.min(parseInt(limit) || 10, 25),
      offset: 0,
      postedFrom: toSamDate(from.toISOString().split('T')[0]),
      postedTo: toSamDate(today.toISOString().split('T')[0])
      // Note: SAM.gov free tier doesn't support ptype filter reliably; returns all types
    };

    if (naics) params.naicsCode = naics;
    if (keyword) params.q = keyword;

    const response = await axios.get(BASE_URL, { params, timeout: 10000 });
    const data = response.data;

    const awards = (data.opportunitiesData || []).map(opp => ({
      id: opp.noticeId,
      title: opp.title,
      agency: opp.fullParentPathName || opp.organizationName,
      naics: opp.naicsCode,
      award_date: opp.award?.date || opp.postedDate,
      award_amount: opp.award?.amount || null,
      awardee: opp.award?.awardee?.name || null,
      set_aside: opp.typeOfSetAside || 'None',
      url: `https://sam.gov/opp/${opp.noticeId}/view`
    })).filter(a => {
      if (!agency) return true;
      return (a.agency || '').toLowerCase().includes(agency.toLowerCase());
    });

    // Price intelligence
    const amounts = awards.filter(a => a.award_amount).map(a => a.award_amount);
    const setAsides = awards.map(a => a.set_aside).filter(s => s && s !== 'None');
    const setAsideCount = setAsides.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(setAsideCount).sort((a, b) => b[1] - a[1])[0];

    const priceIntelligence = amounts.length > 0 ? {
      sample_size: amounts.length,
      avg_award_amount: Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length),
      min_award_amount: Math.min(...amounts),
      max_award_amount: Math.max(...amounts),
      most_common_set_aside: mostCommon ? mostCommon[0] : 'N/A'
    } : { note: 'No award amount data available for this query' };

    const result = {
      success: true,
      count: awards.length,
      awards,
      price_intelligence: priceIntelligence,
      source: 'SAM.gov — US Federal Contract Awards',
      disclaimer: 'Information only. Verify all details on sam.gov before action.'
    };

    cache.set(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('[awards] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch awards data', details: err.message });
  }
});

module.exports = { router, bazaarInfo };
