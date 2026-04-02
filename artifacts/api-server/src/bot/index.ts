import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Bot is running ✅");
});
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from "discord.js";
import { logger } from "../lib/logger";
import { setupTempVoice, cleanupGhostRooms } from "./tempVoice";

const REQUIRED_PERMISSIONS = [
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.MoveMembers,
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.Connect,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.ManageRoles,
];

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.error("DISCORD_BOT_TOKEN is not set. Bot will not start.");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.GuildMember],
  });

  client.once("clientReady", async () => {
    logger.info({ tag: client.user?.tag }, "Discord bot is ready");

    for (const guild of client.guilds.cache.values()) {
      const me = guild.members.me;
      if (!me) continue;

      const missing: string[] = [];
      for (const perm of REQUIRED_PERMISSIONS) {
        if (!me.permissions.has(perm)) {
          const name = Object.entries(PermissionsBitField.Flags).find(([, v]) => v === perm)?.[0];
          missing.push(name ?? String(perm));
        }
      }
      if (missing.length > 0) {
        logger.warn({ guild: guild.name, missing }, "Bot is missing required permissions in guild!");
      } else {
        logger.info({ guild: guild.name }, "Permission check passed");
      }
    }

    await cleanupGhostRooms(client);
    logger.info("Ghost room cleanup complete");
  });

  setupTempVoice(client);
app.listen(process.env.PORT || 3000, () => {
  console.log("Web server running");
});
  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to login to Discord");
  });
}
