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
import { analyzeXspFile } from "./xsp.js";

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

/** Human-readable byte size, e.g. 1234567 -> "1.18 MiB". */
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exp;
  const rounded = exp === 0 ? value : value.toFixed(2);
  return `${rounded} ${units[exp]} (${bytes.toLocaleString("en-US")} bytes)`;
}

function buildXspEmbed(header, stats, attachment) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const reusePct = pct(stats.reuseRatio);
  const downloadPct = pct(1 - stats.reuseRatio);

  const embed = new EmbedBuilder()
    .setColor(0x107c10)
    .setTitle(`XSP file — ${attachment.name}`)
    .setDescription(`Magic: \`${header.magic}\``)
    .addFields(
      {
        name: "Version",
        value: `\`${header.upgradeFromVersion}\` → \`${header.upgradeToVersion}\``,
        inline: false,
      },
      {
        name: "Patch records",
        value: `\`${header.recordCount.toLocaleString("en-US")}\``,
        inline: true,
      },
      {
        name: "Block size",
        value: `\`${formatBytes(header.pageSize)}\``,
        inline: true,
      },
      {
        name: "Disk space required",
        value: `\`${formatBytes(header.diskSpaceRequired)}\``,
        inline: true,
      },
      {
        name: `Re-used from install (${reusePct})`,
        value: `\`${formatBytes(stats.reusedBytes)}\` · ${stats.copyCount.toLocaleString("en-US")} record(s)`,
        inline: false,
      },
      {
        name: `Downloaded (${downloadPct})`,
        value: `\`${formatBytes(stats.downloadedBytes)}\` · ${stats.newCount.toLocaleString("en-US")} record(s)`,
        inline: false,
      },
      {
        name: "Content ID (VDUID)",
        value: `\`${header.contentId}\``,
        inline: false,
      },
      {
        name: "Update Domain ID (UDUID)",
        value: `\`${header.updateDomainId}\``,
        inline: false,
      },
      { name: "Build ID", value: `\`${header.buildId}\``, inline: false },
      { name: "Plan ID", value: `\`${header.planId}\``, inline: false },
      { name: "XSP ID", value: `\`${header.xspId}\``, inline: false },
    );

  const footerParts = [`File size: ${formatBytes(attachment.size)}`];
  if (stats.unknownCount > 0) {
    footerParts.push(`${stats.unknownCount} record(s) with unknown flag`);
  }
  if (stats.truncated) {
    footerParts.push(`only first ${stats.parsedCount.toLocaleString("en-US")} records analysed`);
  }
  embed.setFooter({ text: footerParts.join(" · ") });

  return embed;
}

async function handleDisplayCatalog(interaction) {
  const productId = interaction.options.getString("id", true).trim();
  const market = (
    interaction.options.getString("market") || DEFAULT_MARKET
  ).trim();
  const language = (
    interaction.options.getString("language") || DEFAULT_LANGUAGE
  ).trim();

  await interaction.deferReply();

  try {
    const data = await fetchProduct(productId, { market, languages: language });
    const summary = summarizeProduct(data);
    const embed = buildEmbed(summary, { market, language });
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error(`Lookup failed for "${productId}":`, error);
    await interaction.editReply({
      content: `⚠️ ${error.message ?? "Something went wrong while querying DisplayCatalog."}`,
    });
  }
}

async function handleXspInfo(interaction) {
  const attachment = interaction.options.getAttachment("file", true);

  await interaction.deferReply();

  try {
    const { header, stats } = await analyzeXspFile(
      attachment.url,
      attachment.size,
    );
    const embed = buildXspEmbed(header, stats, attachment);
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error(`XSP parse failed for "${attachment.name}":`, error);
    await interaction.editReply({
      content: `⚠️ ${error.message ?? "Could not read the XSP header."}`,
    });
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "displaycatalog":
      return handleDisplayCatalog(interaction);
    case "xspinfo":
      return handleXspInfo(interaction);
    default:
      return;
  }
});

await registerCommands();
await client.login(token);
