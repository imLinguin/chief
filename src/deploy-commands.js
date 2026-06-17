import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.");
  process.exit(1);
}

const body = commands.map((command) => command.toJSON());
const rest = new REST().setToken(token);

try {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log(
      `Registered ${body.length} guild command(s) to guild ${guildId}.`,
    );
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(
      `Registered ${body.length} global command(s) (may take up to ~1 hour to appear).`,
    );
  }
} catch (error) {
  console.error("Failed to register commands:", error);
  process.exit(1);
}
