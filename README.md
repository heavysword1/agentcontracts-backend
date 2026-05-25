# AgentGov — US Federal Intelligence API

x402-powered MCP server. Pay per query in USDC on Base mainnet.

## MCP Endpoint

```
https://contracts.memoryapi.org/mcp
```

## Tools

- `search_contracts`
- `search_grants`
- `search_awards`

## Usage (Claude Desktop / Cursor / Windsurf)

Add to your MCP config:
```json
{
  "mcpServers": {
    "agentcontracts-backend": {
      "url": "https://contracts.memoryapi.org/mcp",
      "transport": "http"
    }
  }
}
```

## x402 API

Also available as x402 pay-per-query API at `https://contracts.memoryapi.org`

## Tags
federal contracts, grants, SAM.gov, Grants.gov, x402, Base, USDC, MCP

## License
MIT — Ocean Digital Group LLC
