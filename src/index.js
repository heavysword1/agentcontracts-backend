require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const express = require('express');
const cors = require('cors');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { bazaarResourceServerExtension } = require('@x402/extensions');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { HTTPFacilitatorClient } = require('@x402/core/server');

const { router: searchRouter } = require('./routes/search');
const { router: awardsRouter } = require('./routes/awards');
const { router: grantsRouter, bazaarInfo: grantsBazaar } = require('./routes/grants');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50kb' }));

const PAY_TO = process.env.X402_WALLET_ADDRESS || '0x24FAcafEB49b4e3FACF0B3e69604A2F4640c9bf2';
const X402_NETWORK = 'eip155:8453'; // Base mainnet
const X402_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const PORT = process.env.PORT || 3001;

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AgentContracts',
    version: '1.0.0',
    description: 'x402-powered US government contract intelligence API',
    endpoints: {
      search:  'GET /x402/contracts/search  — Find active RFPs ($0.01 USDC)',
      awards:  'GET /x402/contracts/awards  — Historical award price intelligence ($0.05 USDC)'
    }
  });
});

// x402 setup
try {
  let facilitatorClient;
  if (process.env.CDP_API_KEY_NAME && process.env.CDP_API_KEY_PRIVATE_KEY) {
    const { createFacilitatorConfig } = require('@coinbase/x402');
    const rawConfig = createFacilitatorConfig(
      process.env.CDP_API_KEY_NAME,
      process.env.CDP_API_KEY_PRIVATE_KEY
    );
    // @x402/core calls _createAuthHeaders() then does result[path] internally
    // So we just need to return the {verify,settle,supported,list} object as-is
    const facilitatorConfig = {
      url: rawConfig.url,
      createAuthHeaders: rawConfig.createAuthHeaders
    };
    facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
    console.log('CDP auth configured for x402 mainnet');
  } else {
    facilitatorClient = new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL });
    console.log('x402 using public facilitator');
  }

  const x402Server = new x402ResourceServer(facilitatorClient)
    .register(X402_NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  // syncFacilitatorOnStart=false: skip blocking init, init lazily on first request
  app.use(
    paymentMiddleware(
      {
        'GET /x402/contracts/search': {
          accepts: [{ scheme: 'exact', price: '$0.01', network: X402_NETWORK, payTo: PAY_TO }],
          description: 'Search active US government contract opportunities on SAM.gov',
          extensions: {
            bazaar: { info: {
              input: {
                type: 'http', method: 'GET',
                queryParams: { keyword: 'software development', naics: '541511', limit: '10', set_aside: 'SBA' },
                schema: {
                  properties: {
                    keyword:   { type: 'string', description: 'Search keyword or phrase' },
                    naics:     { type: 'string', description: '6-digit NAICS code' },
                    limit:     { type: 'string', description: 'Number of results (max 25)' },
                    set_aside: { type: 'string', description: 'Set-aside: SBA, 8A, SDVOSBC, WOSB, HZC' },
                    agency:    { type: 'string', description: 'Filter by agency name' },
                    due_after: { type: 'string', description: 'Only opportunities due after YYYY-MM-DD' }
                  },
                  required: []
                }
              },
              output: { example: {
                success: true, count: 2, total_available: 148,
                opportunities: [{
                  id: 'abc123', title: 'Software Development Services',
                  agency: 'DEPT OF DEFENSE', naics: '541511',
                  type: 'Solicitation', set_aside: 'Small Business',
                  deadline: '2026-06-15T17:00:00', posted: '2026-05-01',
                  description_preview: 'The Department seeks software development support...',
                  url: 'https://sam.gov/opp/abc123/view'
                }],
                disclaimer: 'Information only. Verify all details on sam.gov before action.'
              }}
            }}
          },
          mimeType: 'application/json'
        },

        'GET /x402/grants/search': {
          accepts: [{ scheme: 'exact', price: '$0.01', network: X402_NETWORK, payTo: PAY_TO }],
          description: 'Search active US federal grant opportunities on Grants.gov',
          extensions: {
            bazaar: { info: {
              input: grantsBazaar.input,
              output: grantsBazaar.output
            }}
          },
          mimeType: 'application/json'
        },

        'GET /x402/contracts/awards': {
          accepts: [{ scheme: 'exact', price: '$0.05', network: X402_NETWORK, payTo: PAY_TO }],
          description: 'Historical US federal contract award data and price intelligence from SAM.gov',
          extensions: {
            bazaar: { info: {
              input: {
                type: 'http', method: 'GET',
                queryParams: { naics: '541511', keyword: 'software development', limit: '10', agency: 'DEPT OF DEFENSE' },
                schema: {
                  properties: {
                    naics:   { type: 'string', description: '6-digit NAICS code' },
                    keyword: { type: 'string', description: 'Search keyword for past awards' },
                    limit:   { type: 'string', description: 'Number of results (max 25)' },
                    agency:  { type: 'string', description: 'Filter by awarding agency name' }
                  },
                  required: []
                }
              },
              output: { example: {
                success: true, count: 5,
                awards: [{
                  id: 'def456', title: 'IT Support Services Award',
                  agency: 'DEPT OF DEFENSE', naics: '541511',
                  award_date: '2025-11-01', award_amount: 450000,
                  awardee: 'Acme Tech Solutions LLC', set_aside: 'Small Business',
                  url: 'https://sam.gov/opp/def456/view'
                }],
                price_intelligence: {
                  sample_size: 5,
                  avg_award_amount: 450000,
                  min_award_amount: 50000,
                  max_award_amount: 900000,
                  most_common_set_aside: 'Small Business'
                },
                disclaimer: 'Information only. Verify all details on sam.gov before action.'
              }}
            }}
          },
          mimeType: 'application/json'
        }
      },
      x402Server,
      {
        afterSettle: (req, res, next, settleResponse) => {
          const ext = settleResponse?.extensionResponses;
          if (ext) {
            console.log('[CDP] EXTENSION-RESPONSES:', JSON.stringify(ext));
            if (ext.bazaar) console.log('[Bazaar] Settle extensions:', JSON.stringify(ext));
          }
          next();
        }
      },
      null,
      true   // syncFacilitatorOnStart
    )
  );

  console.log('x402 middleware initialized:', X402_NETWORK, 'via', X402_FACILITATOR_URL);
} catch (err) {
  console.error('x402 init failed:', err.message);
}

// Mount routers
app.use('/x402/contracts/search', searchRouter);
app.use('/x402/contracts/awards', awardsRouter);
app.use('/x402/grants/search', grantsRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', service: 'AgentContracts' });
});

app.listen(PORT, () => {
  console.log(`AgentContracts running on port ${PORT}`);
});
