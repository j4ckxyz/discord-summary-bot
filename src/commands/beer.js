import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import llmService from '../services/llm.js';
import { BeerModel } from '../database/models.js';

const BEER_ALCOHOL_GRAMS = 14;
const WIDMARK_RATIO = 0.6; // Average for men/women mix
const MAX_LOG_AMOUNT = 24; // Max beers in one log command

const TOLERANCE_LEVELS = {
  low: { beers: 2, label: 'Low (1-2 beers)' },
  medium: { beers: 4, label: 'Medium (3-4 beers)' },
  high: { beers: 6, label: 'High (5-7 beers)' }
};

// --- Helpers ---

function generateCalendar(year, month, dailyStats) {
  // year, month are UTC based
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstDayStr = new Date(Date.UTC(year, month, 1)).getUTCDay(); 
  
  const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  let grid = '```\n';
  grid += days.join(' ') + '\n';
  
  let currentDay = 1;
  let row = '';
  
  // Padding for first week
  for (let i = 0; i < firstDayStr; i++) {
    row += '   ';
  }
  
  while (currentDay <= daysInMonth) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
    const count = dailyStats[dateStr] || 0;
    
    let cell = String(currentDay).padStart(2, ' ');
    if (count > 0) {
       if (count >= 5) cell = '🥴';
       else if (count >= 1) cell = '🍺';
    }
    
    row += cell + ' ';
    
    if ((firstDayStr + currentDay - 1) % 7 === 6) {
      grid += row + '\n';
      row = '';
    }
    
    currentDay++;
  }
  
  if (row.length > 0) {
    grid += row + '\n';
  }
  
  grid += '```';
  return grid;
}

async function getOrCreateProfile(userId) {
  return BeerModel.getProfile(userId);
}

async function calculateBAC(beers, weightKg, hoursSinceFirst) {
  if (!weightKg || weightKg <= 0) return null;

  const totalAlcohol = beers * BEER_ALCOHOL_GRAMS;
  const bodyWater = weightKg * WIDMARK_RATIO;
  const bac = (totalAlcohol / bodyWater) * 100;

  return Math.max(0, bac - (hoursSinceFirst * 0.015));
}

function getBACLevel(bac) {
  if (bac === null || bac <= 0) return { emoji: '🫗', label: 'Sober', color: 0x57F287 };
  if (bac < 0.03) return { emoji: '🍺', label: 'Mild buzz', color: 0x3BA55D };
  if (bac < 0.06) return { emoji: '🥴', label: 'Tipsy', color: 0xFEE75C };
  if (bac < 0.10) return { emoji: '😵‍💫', label: 'Drunk', color: 0xED4245 };
  if (bac < 0.15) return { emoji: '🤢', label: 'Very drunk', color: 0xC41E3A };
  return { emoji: '🚑', label: 'Danger zone', color: 0x000000 };
}

export default {
  data: new SlashCommandBuilder()
    .setName('beer')
    .setDescription('Track your beer consumption and stats')
    .addSubcommand(subcommand =>
      subcommand
        .setName('log')
        .setDescription('Log beer(s)')
        .addIntegerOption(option => 
          option.setName('amount')
            .setDescription('Number of beers (default 1)')
            .setMinValue(1)
            .setMaxValue(MAX_LOG_AMOUNT)
            .setRequired(false))
        .addStringOption(option =>
          option.setName('date')
            .setDescription('Date (YYYY-MM-DD), "today", or "yesterday"')
            .setRequired(false))
        .addStringOption(option =>
            option.setName('backfill')
              .setDescription('Backfill multiple days, e.g., "1,2,3" for past 3 days')
              .setRequired(false))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('View your current status and stats')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('calendar')
        .setDescription('View your drinking calendar')
    )
    .addSubcommand(subcommand =>
        subcommand
          .setName('setup')
          .setDescription('Set up your profile (age, height, weight)')
          .addIntegerOption(option =>
            option.setName('age')
              .setDescription('Your age')
              .setRequired(true)
              .setMinValue(16)
              .setMaxValue(120))
          .addIntegerOption(option =>
            option.setName('weight')
              .setDescription('Weight in kg (for BAC calculation)')
              .setRequired(false)
              .setMinValue(30)
              .setMaxValue(200))
          .addIntegerOption(option =>
            option.setName('height_cm')
              .setDescription('Height in cm')
              .setRequired(false)
              .setMinValue(100)
              .setMaxValue(250))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('leaderboard')
        .setDescription('View server leaderboards')
        .addStringOption(option =>
          option.setName('sort')
            .setDescription('Sort criteria')
            .setRequired(false)
            .addChoices(
              { name: 'Most Beers (Weekly)', value: 'beers' },
              { name: 'Highest BAC (Current)', value: 'bac' },
              { name: 'Longest Sober Streak', value: 'sober' },
              { name: 'Most Active Days (Weekly)', value: 'days' }
            ))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    // --- Rate Limit Check (except for setup) ---
    if (subcommand !== 'setup') {
        const canLog = BeerModel.checkRateLimit(userId);
        if (!canLog) {
            return interaction.reply({
                content: '⏳ **Whoa there!** You are logging too fast. Please wait a minute.',
                ephemeral: true
            });
        }
    }

    // --- SETUP ---
    if (subcommand === 'setup') {
      const age = interaction.options.getInteger('age');
      const weight = interaction.options.getInteger('weight');
      const height = interaction.options.getInteger('height_cm');

      if (age < 16) {
        return interaction.reply({ content: '❌ Minimum age is 16.', ephemeral: true });
      }

      BeerModel.upsertProfile(userId, age, height, weight);

      return interaction.reply({
        content: `✅ **Profile Updated**\nAge: ${age}\nWeight: ${weight ? weight + 'kg' : 'Not set'}\nHeight: ${height ? height + 'cm' : 'Not set'}\n\n🔒 Your physical stats are private and only used for BAC estimates.`,
        ephemeral: true
      });
    }

    // --- LOG ---
    if (subcommand === 'log') {
      const amount = interaction.options.getInteger('amount') || 1;
      const dateInput = interaction.options.getString('date');
      const backfillInput = interaction.options.getString('backfill');
      const now = new Date();
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      let datesToLog = [];

      // Logic: Prioritize backfill, then date, then today
      if (backfillInput) {
        const days = backfillInput.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d) && d >= 1 && d <= 14);
        if (days.length === 0) {
            return interaction.reply({ content: '❌ Invalid backfill. Use "1,2,3" (days ago). Max 14.', ephemeral: true });
        }
        for (const d of days) {
            datesToLog.push(new Date(now.getTime() - d * 24 * 60 * 60 * 1000));
        }
      } else if (dateInput) {
        const lower = dateInput.toLowerCase();
        let d = new Date();
        if (lower === 'yesterday') d.setDate(d.getDate() - 1);
        else if (lower !== 'today' && lower !== 'now') {
            d = new Date(dateInput);
        }
        
        if (isNaN(d.getTime())) return interaction.reply({ content: '❌ Invalid date.', ephemeral: true });
        datesToLog.push(d);
      } else {
        datesToLog.push(now);
      }

      // Validation
      const validDates = [];
      for (const d of datesToLog) {
          if (d < twoWeeksAgo) continue; // Skip too old
          // Normalize to YYYY-MM-DD
          validDates.push(d.toISOString().split('T')[0]);
      }

      if (validDates.length === 0) {
          return interaction.reply({ content: '❌ No valid dates to log (cannot log > 14 days ago).', ephemeral: true });
      }

      // Execute Log
      let totalLogged = 0;
      for (const dateStr of validDates) {
          BeerModel.logBeers(userId, guildId, dateStr, amount);
          totalLogged += amount;
      }
      
      BeerModel.incrementActivityStreak(userId);

      const msg = datesToLog.length === 1 
        ? `🍺 **Logged ${amount} beer(s)** for ${validDates[0]}`
        : `🍺 **Logged ${totalLogged} beers** across ${validDates.length} days`;
        
      return interaction.reply({ content: msg, ephemeral: false });
    }

    // --- STATUS ---
    if (subcommand === 'status') {
      const profile = await getOrCreateProfile(userId);
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      
      // Stats
      const todayCount = BeerModel.getBeerCount(userId, guildId, today, today);
      const weekCount = BeerModel.getBeerCount(userId, guildId, new Date(now.getTime() - 7*86400000), now);
      const totalCount = BeerModel.getBeerCount(userId, guildId);
      const streak = BeerModel.getSoberStreak(userId, guildId);
      
      // BAC
      let bacInfo = '';
      if (profile && profile.weight) {
          const bac = await calculateBAC(todayCount, profile.weight, 2); 
          const level = getBACLevel(bac);
          if (bac > 0) {
             bacInfo = `\n**BAC Estimate:** ${bac.toFixed(3)}% ${level.emoji} (${level.label})`;
          }
      }

      const embed = new EmbedBuilder()
        .setTitle('🍺 Your Status')
        .setColor(0xF1C40F)
        .addFields(
            { name: 'Today', value: `${todayCount} 🍺`, inline: true },
            { name: 'Week', value: `${weekCount} 🍺`, inline: true },
            { name: 'All Time', value: `${totalCount} 🍺`, inline: true },
            { name: 'Sober Streak', value: `${streak} days`, inline: true }
        );
        
      if (bacInfo) embed.setDescription(bacInfo);
      
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // --- CALENDAR ---
    if (subcommand === 'calendar') {
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth(); // 0-11
        
        // Get stats for this month (UTC)
        const startOfMonth = new Date(Date.UTC(year, month, 1));
        const endOfMonth = new Date(Date.UTC(year, month + 1, 0));
        
        const stats = BeerModel.getDailyStats(userId, guildId, startOfMonth, endOfMonth);
        // Transform to map
        const statsMap = {};
        stats.forEach(s => statsMap[s.date] = s.count);
        
        const calStr = generateCalendar(year, month, statsMap);
        
        // Month name
        const monthName = startOfMonth.toLocaleString('default', { month: 'long', timeZone: 'UTC' });
        
        const embed = new EmbedBuilder()
           .setTitle(`📅 Drinking Calendar: ${monthName} ${year}`)
           .setDescription(calStr)
           .setFooter({ text: '🍺 = 1-4 beers, 🥴 = 5+ beers' });
           
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // --- LEADERBOARD ---
    if (subcommand === 'leaderboard') {
      const sortBy = interaction.options.getString('sort') || 'beers';
      const now = new Date();
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      let entries;
      let title = '';

      if (sortBy === 'sober') {
        title = 'Longest Sober Streak (All Time)';
        const participants = BeerModel.getAllParticipants(guildId);
        entries = [];
        for (const p of participants) {
          const streak = BeerModel.getSoberStreak(p.user_id, guildId);
          if (streak !== -1) {
             entries.push({ user_id: p.user_id, val: streak, label: 'days' });
          }
        }
        entries.sort((a, b) => b.val - a.val);
      } else if (sortBy === 'beers') {
        title = 'Most Beers (Last 7 Days)';
        const data = BeerModel.getLeaderboard(guildId, weekStart, now);
        entries = data.map(d => ({ user_id: d.user_id, val: d.beer_count, label: '🍺' }));
        entries.sort((a, b) => b.val - a.val);
      } else if (sortBy === 'days') {
        title = 'Most Active Days (Last 7 Days)';
        const data = BeerModel.getLeaderboard(guildId, weekStart, now);
        entries = data.map(d => ({ user_id: d.user_id, val: d.drinking_days, label: 'days' }));
        entries.sort((a, b) => b.val - a.val);
      } else if (sortBy === 'bac') {
        title = 'Highest Estimated BAC (Today)';
        const today = new Date(now.toISOString().split('T')[0]);
        const data = BeerModel.getLeaderboard(guildId, today, now);
        entries = [];
        for (const d of data) {
           if (d.bac_estimate > 0) {
               entries.push({ user_id: d.user_id, val: d.bac_estimate, label: '%' });
           }
        }
        entries.sort((a, b) => b.val - a.val);
      }

      if (!entries || entries.length === 0) {
        return interaction.reply('📉 No data found for this leaderboard.');
      }

      entries = entries.slice(0, 10);
      let desc = '';
      const medals = ['🥇', '🥈', '🥉'];

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const medal = i < 3 ? medals[i] : '🔸';
        const user = await interaction.client.users.fetch(e.user_id).catch(() => ({ username: 'Unknown' }));
        
        let valStr = e.val;
        if (sortBy === 'bac') valStr = e.val.toFixed(3);
        
        desc += `${medal} **${user.username}**: ${valStr} ${e.label}\n`;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🏆 ${title}`)
        .setDescription(desc)
        .setColor(0xFFD700)
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }
  },
  
  async executeText(message, args) {
    // Basic text command support for legacy compatibility
    message.reply("🍺 Please use the slash command `/beer` for the new and improved experience!");
  }
};
