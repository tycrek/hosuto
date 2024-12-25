# Hosuto

A Cloudflare Images custom domain relay.

## Setup

1. Clone this repo
2. Copy `example.wrangler.toml` to `wrangler.toml`
3. Change the details as required. Your API key should have **Read/Edit** permissions for **Cloudflare Images** and **Workers KV Storage**.
4. Run `npx wrangler deploy` to publish to Cloudflare
