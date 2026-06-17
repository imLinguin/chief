# DisplayCatalog Discord Bot

A [discord.js](https://discord.js.org/) bot that queries the Microsoft Store
**DisplayCatalog** API and, given a product id, reports the product's
**available platforms**, **package formats**, and **content IDs**.

The DisplayCatalog request/response handling is modelled after the
[xodus](https://github.com/xodus-gaming/xodus/blob/main/xodus/src/api/displaycatalog.rs)
implementation.

## How it works

The bot calls:

```
GET https://displaycatalog.mp.microsoft.com/v7.0/products/{productId}
    ?market={market}&languages={language}&fieldsTemplate=details
```

and extracts the following from the JSON response (`PascalCase` keys):

| Shown as       | JSON path |
| -------------- | --------- |
| Platforms      | `Product.DisplaySkuAvailabilities[].Availabilities[].Conditions.ClientConditions.AllowedPlatforms[].PlatformName` and `…Sku.Properties.Packages[].PlatformDependencies[].PlatformName` |
| Package formats| `…Sku.Properties.Packages[].PackageFormat` |
| Content IDs    | `…Sku.Properties.Packages[].ContentId` (falls back to `…FulfillmentData.PackageContentId`) |

## Setup

1. **Create a Discord application + bot**
   at <https://discord.com/developers/applications>, copy the **bot token**
   and the **application (client) ID**.

2. **Install dependencies** (requires Node.js 18+ for the global `fetch`):

   ```bash
   npm install
   ```

3. **Configure environment** — copy `.env.example` to `.env` and fill it in:

   ```bash
   cp .env.example .env
   ```

   - `DISCORD_TOKEN` — your bot token
   - `DISCORD_CLIENT_ID` — your application id
   - `DISCORD_GUILD_ID` — *(optional)* a server id for instant command
     registration during development. Leave blank to register globally.

4. **Invite the bot** to your server with the `applications.commands` (and
   `bot`) scopes.

## Running

```bash
npm start
```

The bot registers its slash command automatically on startup, so there is
nothing else to do. (You can also register commands separately with
`npm run deploy`.)

## Usage

In any channel the bot can see:

```
/displaycatalog id:9NBLGGH4R315
```

Options:

- `id` *(required)* — the Store product id.
- `market` *(optional)* — two letter market code (default `US`).
- `language` *(optional)* — language code (default `en-us`).

The bot replies with an embed listing the product title, platforms, package
formats, content IDs, and a short per-package breakdown.

## Project layout

| File | Purpose |
| ---- | ------- |
| `src/displaycatalog.js` | DisplayCatalog API client + response summariser |
| `src/commands.js`       | Slash command definition |
| `src/index.js`          | Bot entry point + interaction handling |
| `src/deploy-commands.js`| Standalone slash command registration script |
