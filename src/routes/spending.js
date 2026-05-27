const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();
const cache = new NodeCache({ stdTTL: 300 });

const USA_BASE = 'https://api.usaspending.gov/api/v2';

router.get('/', async (req, res) => {
  try {
    const { type = 'awards', keyword, recipient, agency, min_amount, limit = 10, year } = req.query;
    const cacheKey = `spending:${type}:${keyword||''}:${recipient||''}:${agency||''}:${min_amount||''}:${limit}:${year||''}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const lim = Math.min(parseInt(limit) || 10, 25);
    const startYear = year || new Date().getFullYear().toString();
    const startDate = `${parseInt(startYear)-1}-01-01`;
    const endDate = new Date().toISOString().split('T')[0];

    let result;

    if (type === 'awards') {
      // Search federal awards
      const filters = {
        award_type_codes: ['A','B','C','D'], // Contracts
        time_period: [{ start_date: startDate, end_date: endDate }]
      };
      if (keyword) filters.keyword_search = [keyword];
      if (recipient) filters.recipient_search_text = [recipient];
      if (agency) filters.agencies = [{ type: 'awarding', tier: 'toptier', name: agency }];

      const body = {
        filters,
        fields: ['Award ID','Recipient Name','Award Amount','Awarding Agency','Award Date','Description','Place of Performance State Code'],
        limit: lim, sort: 'Award Amount', order: 'desc'
      };

      const { data } = await axios.post(`${USA_BASE}/search/spending_by_award/`, body, { timeout: 15000 });

      let awards = data.results || [];
      if (min_amount) awards = awards.filter(a => (a['Award Amount'] || 0) >= parseFloat(min_amount));

      result = {
        success: true,
        type: 'federal_awards',
        period: `${startDate} to ${endDate}`,
        count: awards.length,
        awards: awards.map(a => ({
          id: a['Award ID'],
          recipient: a['Recipient Name'],
          amount: a['Award Amount'],
          agency: a['Awarding Agency'],
          date: a['Award Date'],
          description: a['Description']?.substring(0, 200),
          state: a['Place of Performance State Code']
        })),
        source: 'USAspending.gov — Federal Award Data',
        disclaimer: 'Information only. Verify on usaspending.gov before any action.'
      };

    } else if (type === 'recipient') {
      // Company award history
      if (!recipient) return res.status(400).json({ error: 'recipient is required for type=recipient' });

      const body = {
        filters: {
          award_type_codes: ['A','B','C','D'],
          time_period: [{ start_date: `${parseInt(startYear)-5}-01-01`, end_date: endDate }],
          recipient_search_text: [recipient]
        },
        fields: ['Award ID','Recipient Name','Award Amount','Awarding Agency','Award Date','Description'],
        limit: lim, sort: 'Award Amount', order: 'desc'
      };

      const { data } = await axios.post(`${USA_BASE}/search/spending_by_award/`, body, { timeout: 15000 });
      const awards = data.results || [];

      const totalAmount = awards.reduce((sum, a) => sum + (a['Award Amount'] || 0), 0);
      const agencies = [...new Set(awards.map(a => a['Awarding Agency']))];

      result = {
        success: true,
        type: 'recipient_history',
        recipient,
        period: `Last 5 years (${parseInt(startYear)-5} to present)`,
        total_awards_found: awards.length,
        total_value: totalAmount,
        top_awarding_agencies: agencies.slice(0, 5),
        awards: awards.map(a => ({
          id: a['Award ID'],
          amount: a['Award Amount'],
          agency: a['Awarding Agency'],
          date: a['Award Date'],
          description: a['Description']?.substring(0, 150)
        })),
        source: 'USAspending.gov',
        disclaimer: 'Information only. Verify on usaspending.gov.'
      };

    } else if (type === 'agency') {
      // Agency spending breakdown
      const body = {
        filters: {
          award_type_codes: ['A','B','C','D'],
          time_period: [{ start_date: startDate, end_date: endDate }]
        },
        category: 'awarding_agency',
        limit: lim
      };
      if (keyword) body.filters.keyword_search = [keyword];

      const { data } = await axios.post(`${USA_BASE}/search/spending_by_category/`, body, { timeout: 15000 });

      result = {
        success: true,
        type: 'agency_spending',
        period: `${startDate} to ${endDate}`,
        count: (data.results || []).length,
        agencies: (data.results || []).map(a => ({
          agency: a.name,
          total_obligations: a.amount,
          award_count: a.award_count
        })),
        source: 'USAspending.gov',
        disclaimer: 'Information only.'
      };

    } else {
      return res.status(400).json({ error: 'type must be: awards, recipient, or agency' });
    }

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[spending] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
