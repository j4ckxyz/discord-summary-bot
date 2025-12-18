import { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js'
import logger from '../utils/logger.js'
import { config } from '../utils/config.js'
import llmService from '../services/llm.js'

export default {
  data: new SlashCommandBuilder()
    .setName('viewall')
    .setDescription('View messages from any server the bot is in (BOT OWNER ONLY)')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('What to do with the messages')
        .setRequired(false)
        .addChoices(
          { name: 'View Messages', value: 'view' },
          { name: 'Search Messages', value: 'search' },
          { name: 'Summarize Channel', value: 'summary' },
          { name: 'Export Chat History', value: 'export' }
        )
    )
    .addStringOption(option =>
      option.setName('server')
        .setDescription('Server ID or name to view messages from')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('keyword')
        .setDescription('Keyword to search for (required for search action)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('channel')
        .setDescription('Channel ID or name (for summary action)')
        .setRequired(false)
    )
    .addIntegerOption(option =>
      option.setName('limit')
        .setDescription('Number of messages to retrieve (default: 50, max: 1000)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(1000)
    ),

  async execute(interaction) {
    try {
      // Check if user is bot owner
      const botOwnerId = process.env.BOT_OWNER_ID || config.botOwnerId
      
      if (!botOwnerId) {
        await interaction.reply({
          content: 'Bot owner ID is not configured. Please set BOT_OWNER_ID in your .env file or config.json.',
          ephemeral: true
        })
        return
      }

      if (interaction.user.id !== botOwnerId) {
        await interaction.reply({
          content: 'This command is only available to the bot owner.',
          ephemeral: true
        })
        logger.cmd(`Unauthorized /viewall attempt by ${interaction.user.tag} (${interaction.user.id})`)
        return
      }

      // Get all guilds the bot is in
      const guilds = interaction.client.guilds.cache

      if (guilds.size === 0) {
        await interaction.reply({
          content: 'The bot is not in any servers.',
          ephemeral: true
        })
        return
      }

      const action = interaction.options.getString('action')
      const serverOption = interaction.options.getString('server')
      const keyword = interaction.options.getString('keyword')
      const channelOption = interaction.options.getString('channel')
      const limit = interaction.options.getInteger('limit') || 50
      
      // If NO options provided at all, show action selection menu
      if (!action && !serverOption && !keyword && !channelOption) {
        const actionSelectMenu = new StringSelectMenuBuilder()
          .setCustomId('viewall_action_select')
          .setPlaceholder('Choose what you want to do')
          .addOptions([
            {
              label: 'View Recent Messages',
              description: 'Browse the most recent messages from a server',
              value: 'view',
              emoji: '👀'
            },
            {
              label: 'Search for Keyword',
              description: 'Search messages containing specific keywords',
              value: 'search',
              emoji: '🔍'
            },
            {
              label: 'Summarize Channel',
              description: 'Get an AI summary of a specific channel',
              value: 'summary',
              emoji: '📝'
            },
            {
              label: 'Export Chat History',
              description: 'Download complete chat history as a file',
              value: 'export',
              emoji: '💾'
            }
          ])

        const row = new ActionRowBuilder().addComponents(actionSelectMenu)

        await interaction.reply({
          content: `**ViewAll - Bot Owner Tools**\n\nThe bot is currently in **${guilds.size}** server(s).\n\nSelect an action to get started:`,
          components: [row],
          ephemeral: true
        })
        return
      }

      // Validate action-specific requirements
      if (action === 'search' && !keyword) {
        await interaction.reply({
          content: 'Please provide a keyword to search for when using the search action.',
          ephemeral: true
        })
        return
      }

      if (action === 'summary' && !channelOption) {
        await interaction.reply({
          content: 'Please provide a channel ID or name when using the summary action.',
          ephemeral: true
        })
        return
      }

      // If no server specified, show server selection menu
      if (!serverOption) {
        const guildOptions = Array.from(guilds.values()).map(guild => ({
          label: guild.name,
          description: `${guild.memberCount} members`,
          value: guild.id
        }))

        // Discord select menus can only have 25 options max
        if (guildOptions.length > 25) {
          guildOptions.length = 25
        }

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`viewall_server_select:${action}:${limit}:${keyword || ''}:${channelOption || ''}`)
          .setPlaceholder('Select a server')
          .addOptions(guildOptions)

        const row = new ActionRowBuilder().addComponents(selectMenu)

        let actionDescription = ''
        if (action === 'view') {
          actionDescription = `Viewing **${limit}** most recent messages`
        } else if (action === 'search') {
          actionDescription = `Searching for keyword: **${keyword}** (limit: ${limit})`
        } else if (action === 'summary') {
          actionDescription = `Summarizing channel: **${channelOption}** (${limit} messages)`
        } else if (action === 'export') {
          const format = interaction.options.getString('format') || 'txt'
          actionDescription = `Exporting **${limit}** messages as **${format.toUpperCase()}**`
        }

        await interaction.reply({
          content: `**Select a server:**\n${actionDescription}\n\nThe bot is in ${guilds.size} server(s).`,
          components: [row],
          ephemeral: true
        })
        return
      }

      // Server was specified, execute the action
      if (action === 'search') {
        await this.searchServerMessages(interaction, serverOption, keyword, limit)
      } else if (action === 'summary') {
        await this.summarizeChannel(interaction, serverOption, channelOption, limit)
      } else if (action === 'export') {
        const format = interaction.options.getString('format') || 'txt'
        await this.exportServerMessages(interaction, serverOption, channelOption, format, limit)
      } else {
        await this.displayServerMessages(interaction, serverOption, limit, keyword)
      }

    } catch (error) {
      logger.error('Error executing viewall command:', error)
      
      const errorMessage = 'An error occurred while executing this command.'
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorMessage, ephemeral: true })
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true })
      }
    }
  },

  /**
   * Search messages from a specific server by keyword
   */
  async searchServerMessages(interaction, guildId, keyword, limit = 50) {
    try {
      const guild = interaction.client.guilds.cache.get(guildId)
      
      if (!guild) {
        await interaction.reply({
          content: 'Server not found. The bot may have left this server.',
          ephemeral: true
        })
        return
      }

      // Defer reply as searching messages might take time
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true })
      }

      await interaction.editReply(`Searching for "${keyword}" in ${guild.name}...`)

      // Get all text channels in the guild
      const textChannels = guild.channels.cache.filter(
        channel => channel.isTextBased() && !channel.isThread()
      )

      if (textChannels.size === 0) {
        await interaction.editReply(`**${guild.name}**\n\nNo accessible text channels found.`)
        return
      }

      // Collect messages matching the keyword
      const matchingMessages = []
      const keywordLower = keyword.toLowerCase()
      
      for (const [channelId, channel] of textChannels) {
        try {
          // Fetch more messages to search through
          const messages = await channel.messages.fetch({ limit: 100 })
          
          messages.forEach(msg => {
            if (msg.content && msg.content.toLowerCase().includes(keywordLower)) {
              matchingMessages.push({
                content: msg.content,
                author: msg.author.tag,
                authorId: msg.author.id,
                channel: channel.name,
                channelId: channel.id,
                timestamp: msg.createdTimestamp,
                id: msg.id,
                attachments: msg.attachments.size > 0,
                embeds: msg.embeds.length > 0
              })
            }
          })
        } catch (channelError) {
          logger.error(`Error searching channel ${channel.name}:`, channelError)
        }
      }

      // Sort by timestamp (newest first)
      matchingMessages.sort((a, b) => b.timestamp - a.timestamp)

      // Limit to requested amount
      const limitedMessages = matchingMessages.slice(0, limit)

      if (limitedMessages.length === 0) {
        await interaction.editReply(`**${guild.name}**\n\nNo messages found containing "${keyword}".`)
        return
      }

      // Create embed(s) to display messages
      const embeds = []
      let currentEmbed = new EmbedBuilder()
        .setTitle(`Search results in ${guild.name}`)
        .setDescription(`Found ${matchingMessages.length} messages containing "${keyword}"\nShowing ${limitedMessages.length} results`)
        .setColor(0x5865F2)
        .setTimestamp()

      let fieldCount = 0
      
      for (const msg of limitedMessages) {
        // Discord embeds can have max 25 fields
        if (fieldCount >= 25) {
          embeds.push(currentEmbed)
          currentEmbed = new EmbedBuilder()
            .setTitle(`Search results in ${guild.name} (continued)`)
            .setColor(0x5865F2)
          fieldCount = 0
        }

        const timestamp = new Date(msg.timestamp).toLocaleString()
        let content = msg.content.substring(0, 200)
        if (msg.content.length > 200) content += '...'
        
        if (msg.attachments) content += ' [📎 Attachments]'
        if (msg.embeds) content += ' [📋 Embeds]'

        currentEmbed.addFields({
          name: `#${msg.channel} | ${msg.author}`,
          value: `${content}\n*${timestamp}*`,
          inline: false
        })
        
        fieldCount++
      }

      embeds.push(currentEmbed)

      // Discord allows max 10 embeds per message
      const embedsToSend = embeds.slice(0, 10)

      await interaction.editReply({
        content: null,
        embeds: embedsToSend
      })

      logger.cmd(`/viewall search executed by ${interaction.user.tag} for server: ${guild.name}, keyword: ${keyword}`)

    } catch (error) {
      logger.error('Error searching server messages:', error)
      
      const errorContent = 'An error occurred while searching messages from this server.'
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorContent })
      } else {
        await interaction.reply({ content: errorContent, ephemeral: true })
      }
    }
  },

  /**
   * Summarize a channel from a specific server
   */
  async summarizeChannel(interaction, guildId, channelIdentifier, limit = 100) {
    try {
      const guild = interaction.client.guilds.cache.get(guildId)
      
      if (!guild) {
        await interaction.reply({
          content: 'Server not found. The bot may have left this server.',
          ephemeral: true
        })
        return
      }

      // Defer reply as summarizing might take time
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true })
      }

      await interaction.editReply(`Finding channel in ${guild.name}...`)

      // Find the channel by ID or name
      let targetChannel = guild.channels.cache.get(channelIdentifier)
      
      if (!targetChannel) {
        // Try to find by name
        targetChannel = guild.channels.cache.find(
          ch => ch.name.toLowerCase() === channelIdentifier.toLowerCase() && ch.isTextBased()
        )
      }

      if (!targetChannel || !targetChannel.isTextBased()) {
        await interaction.editReply(`Channel "${channelIdentifier}" not found or is not a text channel.`)
        return
      }

      await interaction.editReply(`Fetching messages from #${targetChannel.name}...`)

      // Fetch messages from the channel
      const messages = await targetChannel.messages.fetch({ limit: Math.min(limit, 100) })
      
      if (messages.size === 0) {
        await interaction.editReply(`No messages found in #${targetChannel.name}.`)
        return
      }

      await interaction.editReply(`Generating summary of ${messages.size} messages from #${targetChannel.name}...`)

      // Format messages for LLM
      const messageTexts = Array.from(messages.values())
        .reverse() // Chronological order
        .filter(msg => !msg.author.bot && msg.content) // Filter out bot messages and empty content
        .map(msg => `[${msg.author.tag}]: ${msg.content}`)
        .join('\n')

      if (!messageTexts.trim()) {
        await interaction.editReply(`No valid messages to summarize in #${targetChannel.name}.`)
        return
      }

      // Generate summary using LLM
      const summaryPrompt = `You are a neutral Discord chat summarizer. Summarize the following ${messages.size} messages from #${targetChannel.name} in the server "${guild.name}". Focus on the main topics discussed, key points raised, and any decisions or conclusions reached. Be concise but informative (aim for 300-500 words). Include who said what when relevant.\n\nMessages:\n${messageTexts}`

      const summary = await llmService.generateText(summaryPrompt)

      // Create embed for summary
      const embed = new EmbedBuilder()
        .setTitle(`Summary of #${targetChannel.name}`)
        .setDescription(summary.substring(0, 4096)) // Discord embed description limit
        .setColor(0x5865F2)
        .setFooter({ text: `${guild.name} | ${messages.size} messages analyzed` })
        .setTimestamp()

      await interaction.editReply({
        content: null,
        embeds: [embed]
      })

      logger.cmd(`/viewall summary executed by ${interaction.user.tag} for server: ${guild.name}, channel: ${targetChannel.name}`)

    } catch (error) {
      logger.error('Error summarizing channel:', error)
      
      const errorContent = 'An error occurred while summarizing the channel.'
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorContent })
      } else {
        await interaction.reply({ content: errorContent, ephemeral: true })
      }
    }
  },

  /**
   * Display messages from a specific server
   */
  async displayServerMessages(interaction, guildId, limit = 50, keyword = null) {
    try {
      const guild = interaction.client.guilds.cache.get(guildId)
      
      if (!guild) {
        await interaction.reply({
          content: 'Server not found. The bot may have left this server.',
          ephemeral: true
        })
        return
      }

      // Defer reply as fetching messages might take time
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true })
      }

      // Get all text channels in the guild
      const textChannels = guild.channels.cache.filter(
        channel => channel.isTextBased() && !channel.isThread()
      )

      if (textChannels.size === 0) {
        const replyContent = `**${guild.name}**\n\nNo accessible text channels found.`
        if (interaction.replied) {
          await interaction.editReply({ content: replyContent })
        } else {
          await interaction.editReply({ content: replyContent })
        }
        return
      }

      // Collect recent messages from all channels
      const allMessages = []
      
      for (const [channelId, channel] of textChannels) {
        try {
          const messages = await channel.messages.fetch({ limit: Math.min(limit, 100) })
          
          messages.forEach(msg => {
            allMessages.push({
              content: msg.content || '[No text content]',
              author: msg.author.tag,
              authorId: msg.author.id,
              channel: channel.name,
              channelId: channel.id,
              timestamp: msg.createdTimestamp,
              id: msg.id,
              attachments: msg.attachments.size > 0,
              embeds: msg.embeds.length > 0
            })
          })
        } catch (channelError) {
          logger.error(`Error fetching messages from channel ${channel.name}:`, channelError)
        }
      }

      // Sort by timestamp (newest first)
      allMessages.sort((a, b) => b.timestamp - a.timestamp)

      // Limit to requested amount
      const limitedMessages = allMessages.slice(0, limit)

      if (limitedMessages.length === 0) {
        const replyContent = `**${guild.name}**\n\nNo messages found in accessible channels.`
        await interaction.editReply({ content: replyContent })
        return
      }

      // Create embed(s) to display messages
      const embeds = []
      let currentEmbed = new EmbedBuilder()
        .setTitle(`Messages from ${guild.name}`)
        .setDescription(`Showing ${limitedMessages.length} most recent messages`)
        .setColor(0x5865F2)
        .setTimestamp()

      let fieldCount = 0
      
      for (const msg of limitedMessages) {
        // Discord embeds can have max 25 fields
        if (fieldCount >= 25) {
          embeds.push(currentEmbed)
          currentEmbed = new EmbedBuilder()
            .setTitle(`Messages from ${guild.name} (continued)`)
            .setColor(0x5865F2)
          fieldCount = 0
        }

        const timestamp = new Date(msg.timestamp).toLocaleString()
        let content = msg.content.substring(0, 200) // Limit content length
        if (msg.content.length > 200) content += '...'
        
        if (msg.attachments) content += ' [📎 Attachments]'
        if (msg.embeds) content += ' [📋 Embeds]'

        currentEmbed.addFields({
          name: `#${msg.channel} | ${msg.author}`,
          value: `${content}\n*${timestamp}*`,
          inline: false
        })
        
        fieldCount++
      }

      embeds.push(currentEmbed)

      // Discord allows max 10 embeds per message, send first 10
      const embedsToSend = embeds.slice(0, 10)

      await interaction.editReply({
        content: null,
        embeds: embedsToSend
      })

      logger.cmd(`/viewall executed by ${interaction.user.tag} for server: ${guild.name}`)

    } catch (error) {
      logger.error('Error displaying server messages:', error)
      
      const errorContent = 'An error occurred while fetching messages from this server.'
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorContent })
      } else {
        await interaction.reply({ content: errorContent, ephemeral: true })
      }
    }
  },

  /**
   * Export messages from a specific channel to a file
   */
  async exportServerMessages(interaction, guildId, channelIdentifier, format = 'txt', limit = 1000) {
    try {
      const guild = interaction.client.guilds.cache.get(guildId)
      
      if (!guild) {
        await interaction.reply({
          content: 'Server not found. The bot may have left this server.',
          ephemeral: true
        })
        return
      }

      // Defer reply as exporting might take time
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true })
      }

      await interaction.editReply(`Finding channel in **${guild.name}**...`)

      // Find the channel by ID or name
      let targetChannel = guild.channels.cache.get(channelIdentifier)
      
      if (!targetChannel) {
        // Try to find by name
        targetChannel = guild.channels.cache.find(
          ch => ch.name.toLowerCase() === channelIdentifier.toLowerCase() && ch.isTextBased()
        )
      }

      if (!targetChannel || !targetChannel.isTextBased()) {
        await interaction.editReply(`Channel "${channelIdentifier}" not found or is not a text channel in **${guild.name}**.`)
        return
      }

      await interaction.editReply(`Fetching messages from **#${targetChannel.name}** in **${guild.name}**...`)

      // Fetch messages from the channel - handle pagination for large limits
      const allMessages = []
      let lastMessageId = null
      const fetchLimit = Math.min(limit, 1000) // Cap at 1000
      
      while (allMessages.length < fetchLimit) {
        const fetchAmount = Math.min(100, fetchLimit - allMessages.length) // Discord max is 100 per request
        
        try {
          const options = { limit: fetchAmount }
          if (lastMessageId) {
            options.before = lastMessageId
          }
          
          const messages = await targetChannel.messages.fetch(options)
          
          if (messages.size === 0) break // No more messages
          
          messages.forEach(msg => {
            allMessages.push({
              id: msg.id,
              content: msg.content || '',
              author: msg.author.tag,
              authorId: msg.author.id,
              authorBot: msg.author.bot,
              channel: targetChannel.name,
              channelId: targetChannel.id,
              timestamp: msg.createdTimestamp,
              createdAt: msg.createdAt.toISOString(),
              attachments: Array.from(msg.attachments.values()).map(att => ({
                name: att.name,
                url: att.url,
                size: att.size
              })),
              embeds: msg.embeds.map(emb => ({
                title: emb.title,
                description: emb.description,
                url: emb.url
              })),
              reactions: msg.reactions.cache.size > 0 ? Array.from(msg.reactions.cache.values()).map(r => ({
                emoji: r.emoji.name,
                count: r.count
              })) : []
            })
          })
          
          lastMessageId = messages.last().id
          
          await interaction.editReply(`Fetching messages... (${allMessages.length}/${fetchLimit})`)
        } catch (fetchError) {
          logger.error(`Error fetching messages from channel ${targetChannel.name}:`, fetchError)
          break
        }
      }

      if (allMessages.length === 0) {
        await interaction.editReply(`No messages found in **#${targetChannel.name}**.`)
        return
      }

      // Sort by timestamp (oldest first for chronological order)
      allMessages.sort((a, b) => a.timestamp - b.timestamp)

      const limitedMessages = allMessages

      await interaction.editReply(`Generating ${format.toUpperCase()} file with ${limitedMessages.length} messages...`)

      // Generate the file based on format
      let fileContent = ''
      const channelName = targetChannel.name.replace(/[^a-z0-9]/gi, '_')
      const guildName = guild.name.replace(/[^a-z0-9]/gi, '_')
      let fileName = `${guildName}_${channelName}_${Date.now()}.${format}`
      
      if (format === 'txt') {
        fileContent = this.generateTxtExport(guild, targetChannel, limitedMessages)
      } else if (format === 'json') {
        fileContent = this.generateJsonExport(guild, targetChannel, limitedMessages)
      } else if (format === 'markdown' || format === 'md') {
        fileContent = this.generateMarkdownExport(guild, targetChannel, limitedMessages)
        fileName = `${guildName}_${channelName}_${Date.now()}.md`
      } else {
        await interaction.editReply(`Unsupported format: **${format}**. Please use txt, json, or markdown.`)
        return
      }

      // Create attachment and send
      const buffer = Buffer.from(fileContent, 'utf-8')
      const attachment = new AttachmentBuilder(buffer, { name: fileName })

      await interaction.editReply({
        content: `**Export Complete!**\n\nServer: **${guild.name}**\nChannel: **#${targetChannel.name}**\nMessages: **${limitedMessages.length}** (most recent)\nFormat: **${format.toUpperCase()}**`,
        files: [attachment]
      })

      logger.cmd(`/viewall export executed by ${interaction.user.tag} for server: ${guild.name}, channel: ${targetChannel.name}, format: ${format}, messages: ${limitedMessages.length}`)

    } catch (error) {
      logger.error('Error exporting server messages:', error)
      
      const errorContent = 'An error occurred while exporting messages from this server.'
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorContent })
      } else {
        await interaction.reply({ content: errorContent, ephemeral: true })
      }
    }
  },

  /**
   * Generate TXT format export
   */
  generateTxtExport(guild, channel, messages) {
    let content = `===========================================\n`
    content += `Chat Export from: ${guild.name} - #${channel.name}\n`
    content += `Export Date: ${new Date().toISOString()}\n`
    content += `Total Messages: ${messages.length}\n`
    content += `===========================================\n\n`

    for (const msg of messages) {
      const date = new Date(msg.timestamp).toLocaleString()
      content += `[${date}] ${msg.author}${msg.authorBot ? ' [BOT]' : ''}\n`
      
      if (msg.content) {
        content += `${msg.content}\n`
      }
      
      if (msg.attachments.length > 0) {
        content += `📎 Attachments: ${msg.attachments.map(a => a.name).join(', ')}\n`
      }
      
      if (msg.reactions.length > 0) {
        content += `👍 Reactions: ${msg.reactions.map(r => `${r.emoji} (${r.count})`).join(', ')}\n`
      }
      
      content += `\n`
    }

    return content
  },

  /**
   * Generate JSON format export
   */
  generateJsonExport(guild, channel, messages) {
    const exportData = {
      server: {
        name: guild.name,
        id: guild.id,
        memberCount: guild.memberCount
      },
      channel: {
        name: channel.name,
        id: channel.id
      },
      exportDate: new Date().toISOString(),
      messageCount: messages.length,
      messages: messages.map(msg => ({
        id: msg.id,
        timestamp: msg.createdAt,
        author: {
          username: msg.author,
          id: msg.authorId,
          bot: msg.authorBot
        },
        content: msg.content,
        attachments: msg.attachments,
        embeds: msg.embeds,
        reactions: msg.reactions
      }))
    }

    return JSON.stringify(exportData, null, 2)
  },

  /**
   * Generate Markdown format export
   */
  generateMarkdownExport(guild, channel, messages) {
    let content = `# Chat Export: ${guild.name} - #${channel.name}\n\n`
    content += `**Export Date:** ${new Date().toISOString()}\n`
    content += `**Total Messages:** ${messages.length}\n`
    content += `**Server:** ${guild.name} (${guild.id})\n`
    content += `**Channel:** #${channel.name} (${channel.id})\n\n`
    content += `---\n\n`

    for (const msg of messages) {
      const date = new Date(msg.timestamp).toLocaleString()
      const botBadge = msg.authorBot ? ' `[BOT]`' : ''
      
      content += `### ${msg.author}${botBadge}\n`
      content += `*${date}*\n\n`
      
      if (msg.content) {
        content += `${msg.content}\n\n`
      }
      
      if (msg.attachments.length > 0) {
        content += `**Attachments:**\n`
        for (const att of msg.attachments) {
          content += `- [${att.name}](${att.url}) *(${Math.round(att.size / 1024)}KB)*\n`
        }
        content += `\n`
      }

      if (msg.embeds.length > 0) {
        content += `**Embeds:**\n`
        for (const emb of msg.embeds) {
          if (emb.title) content += `- **${emb.title}**\n`
          if (emb.description) content += `  ${emb.description.substring(0, 100)}...\n`
        }
        content += `\n`
      }
      
      if (msg.reactions.length > 0) {
        content += `**Reactions:** ${msg.reactions.map(r => `${r.emoji} (${r.count})`).join(', ')}\n\n`
      }
      
      content += `---\n\n`
    }

    return content
  }
}
