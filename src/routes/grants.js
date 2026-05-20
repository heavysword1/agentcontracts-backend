const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();

const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache
const GRANTS_URL = 'https://apply07.grants.gov/grantsws/rest/opportunities/search/';

const bazaarInfo = {
  input: {
    type: 'http',
    method: 'GET',
    queryParams: {
      keyword: 'artificial intelligence',
      eligibility: 'small_business',
      category: 'ST',
      status: 'posted',
      limit: '10',
      min_award: '50000',
      max_award: '2000000'
    },
    schema: {
      properties: {
        keyword:     { type: 'string', description: 'Search keyword or phrase' },
        eligibility: { type: 'string', description: 'Eligible applicants: small_business, nonprofit, state, tribal, individual, all' },
        category:    { type: 'string', description: 'Funding category code: ST=Science, HL=Health, ED=Education, AG=Agriculture, etc.' },
        status:      { type: 'string', description: 'posted, forecasted, or all (default: posted)' },
        limit:       { type: 'string', description: 'Number of results (max 25)' },
        min_award:   { type: 'string', description: 'Minimum award amount in USD' },
        max_award:   { type: 'string', description: 'Maximum award amount in USD' }
      },
      required: []
    }
  },
  output: {
    example: {
      success: true,
      count: 3,
      total_available: 847,
      grants: [
        {
          id: 'ABC-2026-001',
          title: 'SBIR Phase I: AI for Healthcare',
          agency: 'National Institutes of Health',
          cfda: '93.310',
          category: 'Health',
          status: 'posted',
          posted_date: '2026-04-15',
          close_date: '2026-06-30',
          award_ceiling: 300000,
          award_floor: 50000,
          estimated_funding: 2000000,
          expected_awards: 6,
          eligibility: ['Small Businesses'],
          description_preview: 'NIH seeks innovative AI applications for early disease detection...',
          url: 'https://grants.gov/search-grants?cfda=93.310'
        }
      ],
      disclaimer: 'Information only. Verify all details on grants.gov before applying.'
    }
  }
};

// Eligibility code mapping
const eligibilityMap = {
  'small_business': '06',
  'nonprofit': '13',
  'state': '00',
  'county': '01',
  'city': '02',
  'tribal': '21',
  'individual': '10',
  'university': '12',
  'all': ''
};

// Funding category codes
const categoryNames = {
  'AG': 'Agriculture', 'AR': 'Arts', 'BC': 'Business & Commerce',
  'CD': 'Community Development', 'CP': 'Consumer Protection',
  'DPR': 'Disaster Prevention', 'ED': 'Education', 'ELT': 'Employment & Training',
  'EN': 'Energy', 'ENV': 'Environment', 'FN': 'Food & Nutrition',
  'HL': 'Health', 'HO': 'Housing', 'HU': 'Humanities',
  'IIJ': 'Income Security', 'IS': 'Information & Statistics',
  'LJL': 'Law & Justice', 'NR': 'Natural Resources', 'RA': 'Regional Development',
  'RD': 'Rural Development', 'ST': 'Science & Technology',
  'T': 'Transportation', 'O': 'Other'
};

router.get('/', async (req, res) => {
  try {
    const { keyword, eligibility, category, status = 'posted', limit = 10, min_award, max_award } = req.query;

    const cacheKey = `grants:${keyword}:${eligibility}:${category}:${status}:${limit}:${min_award}:${max_award}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Build status filter
    const statusMap = { posted: 'posted', forecasted: 'forecasted', all: 'forecasted|posted' };
    const oppStatuses = statusMap[status] || 'posted';

    // Build request body
    const body = {
      keyword: keyword || '',
      oppStatuses,
      startRecordNum: 0,
      rows: Math.min(parseInt(limit) || 10, 25),
      sortBy: 'openDate|desc'
    };

    if (eligibility && eligibilityMap[eligibility]) {
      body.eligibilities = eligibilityMap[eligibility];
    }
    if (category) {
      body.fundingCategories = category;
    }

    const response = await axios.post(GRANTS_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 12000
    });

    const data = response.data;
    const opportunities = data.oppHits || [];

    const grants = opportunities
      .filter(opp => {
        if (!min_award && !max_award) return true;
        const ceiling = parseInt(opp.awardCeiling) || 0;
        if (min_award && ceiling < parseInt(min_award)) return false;
        if (max_award && ceiling > parseInt(max_award)) return false;
        return true;
      })
      .map(opp => ({
        id: opp.id,
        title: opp.title,
        agency: opp.agencyName,
        cfda: opp.cfdaList?.[0] || null,
        category: categoryNames[opp.fundingCategory] || opp.fundingCategory,
        status: opp.oppStatus,
        posted_date: opp.openDate,
        close_date: opp.closeDate,
        award_ceiling: parseInt(opp.awardCeiling) || null,
        award_floor: parseInt(opp.awardFloor) || null,
        estimated_funding: parseInt(opp.estimatedFunding) || null,
        expected_awards: parseInt(opp.expectedNumberOfAwards) || null,
        eligibility: opp.eligibilityTypes || [],
        description_preview: (opp.synopsis || '').substring(0, 200).replace(/<[^>]*>/g, '').trim() + (opp.synopsis?.length > 200 ? '...' : ''),
        url: `https://grants.gov/search-grants?cfda=${opp.cfdaList?.[0] || ''}`
      }));

    const result = {
      success: true,
      count: grants.length,
      total_available: data.hitCount || grants.length,
      grants,
      source: 'Grants.gov — US Federal Grant Opportunities',
      disclaimer: 'Information only. Verify all details on grants.gov before applying.'
    };

    cache.set(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('[grants] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch grants', details: err.message });
  }
});

module.exports = { router, bazaarInfo };
