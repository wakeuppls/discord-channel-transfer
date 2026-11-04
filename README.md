# Discord Channel Transfer

Copy messages and attachments between Discord text channels, including across servers. Runs locally on Node.js 22+ with no dependencies. Originals stay untouched; copies include the author's name and original timestamp.

1. Create a bot in the [Developer Portal](https://discord.com/developers/applications) and enable **Message Content Intent**.
2. Invite it to both servers with **View Channels**, **Read Message History**, **Send Messages**, **Attach Files**, and **Embed Links**. Allow access to both channels.
3. Copy `.env.example` to `.env` and set `DISCORD_BOT_TOKEN`.
4. Enable Discord's **Developer Mode**, then right-click each channel and select **Copy Channel ID**.

```sh
# Preview 10 pending messages without sending
node transfer.mjs --source SOURCE_ID --target TARGET_ID --limit 10 --dry-run

# Copy all pending messages
node transfer.mjs --source SOURCE_ID --target TARGET_ID
```

Rerun to resume using `.transfer-state.json`; keep this file to avoid copying history again. After a forced stop, remove its `.lock` file only when no transfer is running. An interrupted send can duplicate the last part.

Supports ordinary server text channels. Reactions, reply relationships, threads, polls, and forwarded messages are not preserved. Discord upload limits apply.

Tests: `node --test`.
