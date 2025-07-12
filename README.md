# Tracker Bot

A Discord bot that scrapes Roblox item trade requests from Rolimon's and posts them as an embed. Built for easy deployment on Railway.

## Features
- Slash command: `/trackitem <itemid>`
- Scrapes only the 'request' (buying) side from Rolimon's item trade page
- Posts a rich embed with item info and recent request trades

## Setup

1. **Clone the repository**
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Create a `.env` file:**
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   ```
4. **Run locally:**
   ```bash
   npm start
   ```

## Deploying to Railway
1. Push your code to GitHub.
2. Create a new Railway project and link your repo.
3. Add your `DISCORD_TOKEN` as a Railway environment variable.
4. Deploy!

## Usage
- Invite your bot to your server with the `applications.commands` and `bot` scopes.
- Use `/trackitem <itemid>` in any channel the bot can see.

## Example
```
/trackitem 9910420
```

The bot will reply with an embed showing the latest request trades for that Roblox item.

---

**Note:** This bot scrapes Rolimon's, so if their layout changes, scraping logic may need updating. 