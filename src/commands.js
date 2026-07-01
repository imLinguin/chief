import { SlashCommandBuilder } from "discord.js";

const DEFAULT_MARKET = process.env.DEFAULT_MARKET || "US";
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || "en-us";

/**
 * Slash command: /displaycatalog id:<productId> [market] [language]
 */
export const displaycatalogCommand = new SlashCommandBuilder()
  .setName("displaycatalog")
  .setDescription(
    "Look up Microsoft Store product metadata via the DisplayCatalog API.",
  )
  .addStringOption((option) =>
    option
      .setName("id")
      .setDescription('Store product id, e.g. "9NBLGGH4R315".')
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("market")
      .setDescription(`Two letter market code (default ${DEFAULT_MARKET}).`)
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("language")
      .setDescription(`Language code (default ${DEFAULT_LANGUAGE}).`)
      .setRequired(false),
  );

/**
 * Slash command: /xspinfo file:<attachment>
 */
export const xspinfoCommand = new SlashCommandBuilder()
  .setName("xspinfo")
  .setDescription(
    "Show header metadata for an uploaded XSP (MSIXVC patch) file.",
  )
  .addAttachmentOption((option) =>
    option
      .setName("file")
      .setDescription("The .xsp file to inspect.")
      .setRequired(true),
  );

export const commands = [displaycatalogCommand, xspinfoCommand];
