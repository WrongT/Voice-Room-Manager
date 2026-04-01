import {
  Client,
  VoiceState,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  GuildMember,
  VoiceChannel,
  TextChannel,
  OverwriteType,
} from "discord.js";
import { logger } from "../lib/logger";

const GENERATOR_CHANNEL_ID = "1488997560415682640";
const ALLOWED_ROLE_ID = "1488521626059542538";
const EMBED_COLOR = 0x0a4939;

const EMOJIS = [
  "🐡","🍄","🍓","🍋","🥝","👻","🐻","🍰","🧸","🐯",
  "🐙","🦕","🌴","🍄‍🟫","🌼","🌺","🔥",
];

function randomEmoji(): string {
  return EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
}

interface TempRoom {
  channelId: string;
  ownerId: string;
  panelMessageId: string | null;
  locked: boolean;
  trusted: Set<string>;
  limit: number;
}

const rooms = new Map<string, TempRoom>();
const creationCooldown = new Map<string, number>();
const COOLDOWN_MS = 10_000;

// Lock: prevents two concurrent "first-send" calls from racing and sending the panel twice.
// Once panelMessageId is set on the room, all subsequent calls just edit — the lock only guards the initial send.
const panelSendLock = new Set<string>();

function buildPanel(room: TempRoom, channel: VoiceChannel): EmbedBuilder {
  const owner = channel.guild.members.cache.get(room.ownerId);
  const ownerTag = `<@${room.ownerId}>`;
  const avatarUrl = owner?.user.displayAvatarURL({ size: 256 }) ?? null;

  const voiceMembers = channel.members
    .filter((m) => !m.user.bot)
    .map((m) => `<@${m.id}>`);

  const memberField =
    voiceMembers.length > 0
      ? truncateMembers(voiceMembers)
      : "*No one connected*";

  const limitStr = room.limit > 0 ? `${channel.members.size}/${room.limit}` : `${channel.members.size}/∞`;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${channel.name}`)
    .addFields(
      { name: "👑 Owner", value: ownerTag, inline: true },
      { name: "🔒 Status", value: room.locked ? "Locked" : "Unlocked", inline: true },
      { name: "👥 Limit", value: limitStr, inline: true },
      { name: "🔗 Connected Members", value: memberField },
    )
    .setFooter({ text: "Temp Voice • Control Panel" })
    .setTimestamp();

  if (avatarUrl) embed.setThumbnail(avatarUrl);

  return embed;
}

function truncateMembers(members: string[]): string {
  const MAX = 900;
  let result = members.join(", ");
  if (result.length <= MAX) return result;

  let shown = 0;
  let built = "";
  for (const m of members) {
    const next = built ? `, ${m}` : m;
    if (built.length + next.length + 20 > MAX) break;
    built += next;
    shown++;
  }
  const remaining = members.length - shown;
  return `${built} + **${remaining} more**`;
}

function buildButtons(_locked: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("tv_rename")
      .setLabel("Rename")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tv_limit")
      .setLabel("Set Limit")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tv_lock")
      .setLabel("Lock")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tv_unlock")
      .setLabel("Unlock")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tv_claim")
      .setLabel("Claim")
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("tv_trust")
      .setLabel("Trust User")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tv_untrust")
      .setLabel("Untrust User")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tv_kick")
      .setLabel("Kick User")
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2];
}

async function sendOrUpdatePanel(
  channel: VoiceChannel,
  room: TempRoom,
): Promise<void> {
  const textChannel = channel as unknown as TextChannel;
  const embed = buildPanel(room, channel);
  const rows = buildButtons(room.locked);

  // If we already have a panel, just edit it — no lock needed.
  if (room.panelMessageId) {
    try {
      const msg = await textChannel.messages.fetch(room.panelMessageId);
      await msg.edit({ embeds: [embed], components: rows });
      return;
    } catch {
      // Message was deleted — fall through to re-send below.
      room.panelMessageId = null;
    }
  }

  // Guard: if another async path is already sending the first panel for this room, skip.
  if (panelSendLock.has(channel.id)) return;
  panelSendLock.add(channel.id);

  try {
    const msg = await textChannel.send({ embeds: [embed], components: rows });
    room.panelMessageId = msg.id;
  } finally {
    panelSendLock.delete(channel.id);
  }
}

async function applyRoomPermissions(
  channel: VoiceChannel,
  room: TempRoom,
): Promise<void> {
  const basePerms = [
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.UseVAD,
    PermissionsBitField.Flags.Stream,
    PermissionsBitField.Flags.UseSoundboard,
    PermissionsBitField.Flags.UseApplicationCommands,
    PermissionsBitField.Flags.UseEmbeddedActivities,
    PermissionsBitField.Flags.Connect,
    PermissionsBitField.Flags.Speak,
    PermissionsBitField.Flags.ViewChannel,
  ];

  const overwrites: {
    id: string;
    type: OverwriteType;
    allow?: bigint[];
    deny?: bigint[];
  }[] = [
    {
      id: ALLOWED_ROLE_ID,
      type: OverwriteType.Role,
      allow: room.locked ? [] : basePerms,
      // When locked: only deny Connect — View Channel stays open so they can still see the room
      deny: room.locked
        ? [
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.MuteMembers,
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.ManageRoles,
            PermissionsBitField.Flags.MoveMembers,
          ]
        : [
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.MuteMembers,
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.ManageRoles,
            PermissionsBitField.Flags.MoveMembers,
          ],
    },
  ];

  for (const uid of room.trusted) {
    overwrites.push({
      id: uid,
      type: OverwriteType.Member,
      // Only Connect needs to be explicitly allowed — View Channel is never denied
      allow: [PermissionsBitField.Flags.Connect],
      deny: [],
    });
  }

  overwrites.push({
    id: room.ownerId,
    type: OverwriteType.Member,
    allow: basePerms,
    deny: [],
  });

  await channel.permissionOverwrites.set(overwrites as any);
}

export function setupTempVoice(client: Client): void {
  client.on("voiceStateUpdate", async (oldState: VoiceState, newState: VoiceState) => {
    const guild = newState.guild || oldState.guild;

    if (newState.channelId === GENERATOR_CHANNEL_ID) {
      const member = newState.member;
      if (!member || member.user.bot) return;

      if (!member.roles.cache.has(ALLOWED_ROLE_ID)) {
        await member.voice.disconnect("No permission to create temp room").catch(() => {});
        return;
      }

      const now = Date.now();
      const lastCreated = creationCooldown.get(member.id) ?? 0;
      if (now - lastCreated < COOLDOWN_MS) {
        await member.voice.disconnect("Creation cooldown active").catch(() => {});
        return;
      }
      creationCooldown.set(member.id, now);

      const genChannel = guild.channels.cache.get(GENERATOR_CHANNEL_ID);
      const categoryId = genChannel instanceof VoiceChannel
        ? genChannel.parentId
        : (genChannel as any)?.parentId ?? null;

      const channelName = `${randomEmoji()} ・ ${member.displayName}`;

      try {
        const newCh = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildVoice,
          parent: categoryId ?? undefined,
          position: genChannel ? (genChannel as any).rawPosition + 1 : undefined,
          permissionOverwrites: [
            {
              id: ALLOWED_ROLE_ID,
              allow: [
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.UseVAD,
                PermissionsBitField.Flags.Stream,
                PermissionsBitField.Flags.UseSoundboard,
                PermissionsBitField.Flags.UseApplicationCommands,
                PermissionsBitField.Flags.UseEmbeddedActivities,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
                PermissionsBitField.Flags.ViewChannel,
              ],
              deny: [
                PermissionsBitField.Flags.AttachFiles,
                PermissionsBitField.Flags.EmbedLinks,
                PermissionsBitField.Flags.MuteMembers,
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.ManageRoles,
                PermissionsBitField.Flags.MoveMembers,
              ],
            },
            {
              id: member.id,
              allow: [
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.UseVAD,
                PermissionsBitField.Flags.Stream,
                PermissionsBitField.Flags.UseSoundboard,
                PermissionsBitField.Flags.UseApplicationCommands,
                PermissionsBitField.Flags.UseEmbeddedActivities,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
                PermissionsBitField.Flags.ViewChannel,
              ],
            },
          ],
        });

        const room: TempRoom = {
          channelId: newCh.id,
          ownerId: member.id,
          panelMessageId: null,
          locked: false,
          trusted: new Set(),
          limit: 0,
        };
        rooms.set(newCh.id, room);

        await member.voice.setChannel(newCh).catch(() => {});
        logger.info({ channelId: newCh.id, owner: member.id }, "Temp voice room created");
        // Panel is sent exactly once by the voiceStateUpdate that fires when the owner joins the new channel.
      } catch (err) {
        logger.error({ err }, "Failed to create temp voice channel");
      }
      // Always return after handling a generator join — prevent fall-through to the update blocks below.
      return;
    }

    if (oldState.channelId && rooms.has(oldState.channelId)) {
      const channelId = oldState.channelId;
      const room = rooms.get(channelId)!;
      const channel = guild.channels.cache.get(channelId) as VoiceChannel | undefined;

      if (!channel) {
        rooms.delete(channelId);
        return;
      }

      const realMembers = channel.members.filter((m) => !m.user.bot);

      if (realMembers.size === 0) {
        logger.info({ channelId }, "Temp voice room empty, deleting");
        rooms.delete(channelId);
        await channel.delete().catch(() => {});
        return;
      }

      if (!realMembers.has(room.ownerId)) {
        const nextOwner = realMembers.first();
        if (nextOwner) {
          room.ownerId = nextOwner.id;
          logger.info({ channelId, newOwner: nextOwner.id }, "Auto-claimed temp voice room");
          await sendOrUpdatePanel(channel, room);
        }
      } else {
        await sendOrUpdatePanel(channel, room);
      }
    }

    if (newState.channelId && newState.channelId !== oldState.channelId && rooms.has(newState.channelId)) {
      const room = rooms.get(newState.channelId)!;
      const channel = guild.channels.cache.get(newState.channelId) as VoiceChannel | undefined;
      if (channel) {
        await sendOrUpdatePanel(channel, room);
      }
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
      await handleButton(interaction as ButtonInteraction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelect(interaction as StringSelectMenuInteraction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction as ModalSubmitInteraction);
    }
  });
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const channel = interaction.channel as VoiceChannel | null;
  if (!channel) return;

  const room = rooms.get(channel.id);
  if (!room) {
    await interaction.reply({ content: "This is not a temp voice room.", flags: 64 });
    return;
  }

  const member = interaction.member as GuildMember;
  const isOwner = member.id === room.ownerId;

  const id = interaction.customId;

  if (id === "tv_claim") {
    if (isOwner) {
      await interaction.reply({ content: "You are already the owner.", flags: 64 });
      return;
    }
    const voiceMember = channel.members.get(member.id);
    if (!voiceMember) {
      await interaction.reply({ content: "You must be in the voice channel to claim.", flags: 64 });
      return;
    }
    if (channel.members.has(room.ownerId)) {
      await interaction.reply({ content: "The owner is still in the channel.", flags: 64 });
      return;
    }
    await interaction.deferUpdate();
    room.ownerId = member.id;
    await sendOrUpdatePanel(channel, room);
    return;
  }

  if (!isOwner) {
    await interaction.reply({ content: "Only the room owner can use this.", flags: 64 });
    return;
  }

  if (id === "tv_lock") {
    await interaction.deferUpdate();
    room.locked = true;
    await applyRoomPermissions(channel, room);
    await sendOrUpdatePanel(channel, room);
    return;
  }

  if (id === "tv_unlock") {
    await interaction.deferUpdate();
    room.locked = false;
    await applyRoomPermissions(channel, room);
    await sendOrUpdatePanel(channel, room);
    return;
  }

  if (id === "tv_trust") {
    const vcMembers = channel.members.filter((m) => !m.user.bot && m.id !== room.ownerId);
    if (vcMembers.size === 0) {
      await interaction.reply({ content: "No members to trust.", flags: 64 });
      return;
    }
    await interaction.deferUpdate();
    const options = vcMembers.map((m) => ({
      label: m.displayName.slice(0, 25),
      value: m.id,
    }));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("tv_trust_select")
        .setPlaceholder("Select a member to trust")
        .addOptions(options),
    );
    await interaction.followUp({ content: "Who do you want to trust?", components: [row], flags: 64 });
    return;
  }

  if (id === "tv_untrust") {
    if (room.trusted.size === 0) {
      await interaction.reply({ content: "No trusted members to remove.", flags: 64 });
      return;
    }
    await interaction.deferUpdate();
    const guild = channel.guild;
    const options = [...room.trusted].map((uid) => {
      const m = guild.members.cache.get(uid);
      return {
        label: m ? m.displayName.slice(0, 25) : uid.slice(0, 25),
        value: uid,
      };
    });
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("tv_untrust_select")
        .setPlaceholder("Select a member to untrust")
        .addOptions(options),
    );
    await interaction.followUp({ content: "Who do you want to untrust?", components: [row], flags: 64 });
    return;
  }

  if (id === "tv_kick") {
    const vcMembers = channel.members.filter((m) => !m.user.bot && m.id !== room.ownerId);
    if (vcMembers.size === 0) {
      await interaction.reply({ content: "No members to kick.", flags: 64 });
      return;
    }
    await interaction.deferUpdate();
    const options = vcMembers.map((m) => ({
      label: m.displayName.slice(0, 25),
      value: m.id,
    }));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("tv_kick_select")
        .setPlaceholder("Select a member to kick")
        .addOptions(options),
    );
    await interaction.followUp({ content: "Who do you want to kick?", components: [row], flags: 64 });
    return;
  }

  if (id === "tv_rename") {
    const modal = new ModalBuilder()
      .setCustomId("tv_rename_modal")
      .setTitle("Rename Your Room");
    const input = new TextInputBuilder()
      .setCustomId("tv_rename_input")
      .setLabel("New name")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(32)
      .setValue(channel.name);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (id === "tv_limit") {
    const modal = new ModalBuilder()
      .setCustomId("tv_limit_modal")
      .setTitle("Set User Limit");
    const input = new TextInputBuilder()
      .setCustomId("tv_limit_input")
      .setLabel("User limit (0 = unlimited)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(2)
      .setValue(String(room.limit));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }
}

async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const channel = interaction.channel as VoiceChannel | null;
  if (!channel) return;
  const room = rooms.get(channel.id);
  if (!room) return;

  const member = interaction.member as GuildMember;
  if (member.id !== room.ownerId) {
    await interaction.reply({ content: "Only the owner can do this.", flags: 64 });
    return;
  }

  const targetId = interaction.values[0];
  await interaction.deferUpdate();

  if (interaction.customId === "tv_trust_select") {
    room.trusted.add(targetId);
    await applyRoomPermissions(channel, room);
    await sendOrUpdatePanel(channel, room);
    await interaction.followUp({ content: `<@${targetId}> is now trusted.`, flags: 64 });
    return;
  }

  if (interaction.customId === "tv_untrust_select") {
    room.trusted.delete(targetId);
    await applyRoomPermissions(channel, room);
    await sendOrUpdatePanel(channel, room);
    await interaction.followUp({ content: `<@${targetId}> is no longer trusted.`, flags: 64 });
    return;
  }

  if (interaction.customId === "tv_kick_select") {
    const target = channel.members.get(targetId);
    if (!target) {
      await interaction.followUp({ content: "That member is no longer in the channel.", flags: 64 });
      return;
    }
    await target.voice.disconnect("Kicked from temp voice").catch(() => {});
    if (room.locked) {
      room.trusted.delete(targetId);
      await applyRoomPermissions(channel, room);
    }
    await sendOrUpdatePanel(channel, room);
    await interaction.followUp({ content: `<@${targetId}> was kicked.`, flags: 64 });
    return;
  }
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const channel = interaction.channel as VoiceChannel | null;
  if (!channel) return;
  const room = rooms.get(channel.id);
  if (!room) return;

  const member = interaction.member as GuildMember;
  if (member.id !== room.ownerId) {
    await interaction.reply({ content: "Only the owner can do this.", flags: 64 });
    return;
  }

  if (interaction.customId === "tv_rename_modal") {
    await interaction.deferUpdate();
    const newName = interaction.fields.getTextInputValue("tv_rename_input").trim();
    if (!newName) return;
    await channel.setName(newName).catch(() => {});
    await sendOrUpdatePanel(channel, room);
    return;
  }

  if (interaction.customId === "tv_limit_modal") {
    await interaction.deferUpdate();
    const val = parseInt(interaction.fields.getTextInputValue("tv_limit_input").trim(), 10);
    if (isNaN(val) || val < 0 || val > 99) {
      await interaction.followUp({ content: "Invalid limit. Use a number 0–99.", flags: 64 });
      return;
    }
    room.limit = val;
    await channel.setUserLimit(val).catch(() => {});
    await sendOrUpdatePanel(channel, room);
    return;
  }
}

export async function cleanupGhostRooms(client: Client): Promise<void> {
  for (const [channelId, room] of rooms.entries()) {
    for (const guild of client.guilds.cache.values()) {
      const channel = guild.channels.cache.get(channelId) as VoiceChannel | undefined;
      if (!channel) {
        rooms.delete(channelId);
        continue;
      }
      const realMembers = channel.members.filter((m) => !m.user.bot);
      if (realMembers.size === 0) {
        rooms.delete(channelId);
        await channel.delete().catch(() => {});
      }
    }
  }
}
