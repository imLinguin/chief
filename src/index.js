import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
} from "discord.js";
import { commands } from "./commands.js";
import { fetchProduct, summarizeProduct } from "./displaycatalog.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const DEFAULT_MARKET = process.env.DEFAULT_MARKET || "US";
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || "en-us";

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/** Register slash commands on startup so the bot works out of the box. */
async function registerCommands() {
  const body = commands.map((command) => command.toJSON());
  const rest = new REST().setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log(`Registered ${body.length} guild command(s) to ${guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(`Registered ${body.length} global command(s).`);
  }
}

/** Discord embed field values are capped at 1024 characters. */
function clampField(text) {
  if (text.length <= 1024) return text;
  return `${text.slice(0, 1000)}\n… (truncated)`;
}

/** Format a list as a code block, or a placeholder when empty. */
function formatList(items) {
  if (!items.length) return "_None reported_";
  return clampField(items.map((item) => `\`${item}\``).join(", "));
}

function buildEmbed(summary, { market, language }) {
  const embed = new EmbedBuilder()
    .setColor(0x107c10) // Xbox / Microsoft Store green
    .setTitle(summary.title)
    .setDescription(
      [
        summary.publisher ? `**Publisher:** ${summary.publisher}` : null,
        summary.productType ? `**Type:** ${summary.productType}` : null,
        `**Market:** ${market} · **Language:** ${language}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .addFields(
      {
        name: `Platforms (${summary.platforms.length})`,
        value: formatList(summary.platforms),
      },
      {
        name: `Package formats (${summary.formats.length})`,
        value: formatList(summary.formats),
      },
      {
        name: `Content IDs (${summary.contentIds.length})`,
        value: formatList(summary.contentIds),
      },
    );

  if (summary.productId) {
    embed.setFooter({ text: `Product ID: ${summary.productId}` });
  }

  // Add a per-package breakdown (capped to keep the embed within limits).
  const detailed = summary.packages.filter((pkg) => pkg.contentId);
  if (detailed.length) {
    const lines = detailed.slice(0, 8).map((pkg) => {
      const parts = [
        pkg.format ? `[${pkg.format}]` : null,
        pkg.version ? `v${pkg.version}` : null,
        pkg.platforms.length ? pkg.platforms.join("/") : null,
        pkg.contentId ? `content: ${pkg.contentId}` : null,
      ].filter(Boolean);
      return `• ${parts.join(" · ")}`;
    });
    if (detailed.length > 8) {
      lines.push(`… and ${detailed.length - 8} more package(s)`);
    }
    embed.addFields({ name: "Packages", value: clampField(lines.join("\n")) });
  }

  return embed;
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "displaycatalog") return;

  const productId = interaction.options.getString("id", true).trim();
  const market = (
    interaction.options.getString("market") || DEFAULT_MARKET
  ).trim();
  const language = (
    interaction.options.getString("language") || DEFAULT_LANGUAGE
  ).trim();

  await interaction.deferReply();

  try {
    const data = await fetchProduct(productId, {
      market,
      languages: language,
    });
    const summary = summarizeProduct(data);
    const embed = buildEmbed(summary, { market, language });
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error(`Lookup failed for "${productId}":`, error);
    await interaction.editReply({
      content: `⚠️ ${error.message ?? "Something went wrong while querying DisplayCatalog."}`,
    });
  }
});

await registerCommands();
await client.login(token);
