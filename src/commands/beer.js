import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import llmService from '../services/llm.js';
import logger from '../utils/logger.js';

const BEER_ALCOHOL_GRAMS = 14;
const WIDMARK_RATIO = 0.6;

const TOLERANCE_LEVELS = {
  low: { beers: 2, label: 'Low (1-2 beers)' },
  medium: { beers: 4, label: 'Medium (3-4 beers)' },
  high: { beers: 6, label: 'High (5-7 beers)' }
};

async function getOrCreateProfile(userId) {
  const { BeerModel } = await import('../database/models.js');
  return BeerModel.getProfile(userId);
}

async function calculateBAC(beers, weightKg, hoursSinceFirst) {
  if (!weightKg || weightKg <= 0) return null;

  const totalAlcohol = beers * BEER_ALCOHOL_GRAMS;
  const bodyWater = weightKg * WIDMARK_RATIO;
  const bac = (totalAlcohol / bodyWater) * 100;

  return Math.max(0, bac - (hoursSinceFirst * 0.015));
}

async function calculateAdaptiveTolerance(userId, guildId) {
  const { BeerModel } = await import('../database/models.js');
  const patterns = BeerModel.getUserDrinkingPatterns(userId, guildId, 30);

  if (!patterns || patterns.total_sessions < 2) {
    return null;
  }

  const avgSession = patterns.avg_beers_per_session || 1;
  const maxSession = patterns.max_beers || 1;

  const estimatedTolerance = (avgSession * 0.7) + (maxSession * 0.3);
  const confidence = Math.min(0.9, 0.3 + (patterns.total_sessions * 0.05));

  return {
    tolerance_beers: Math.round(estimatedTolerance * 10) / 10,
    tolerance_confidence: Math.round(confidence * 100) / 100,
    total_sessions: patterns.total_sessions,
    drinking_days: patterns.drinking_days
  };
}

function convertFeetInchesToCm(feet, inches) {
  const totalInches = (feet * 12) + inches;
  return Math.round(totalInches * 2.54);
}

function getBACLevel(bac) {
  if (bac === null || bac <= 0) return { emoji: '🫗', label: 'Sober', color: 0x57F287 };
  if (bac < 0.03) return { emoji: '🍺', label: 'Mild buzz', color: 0x3BA55D };
  if (bac < 0.06) return { emoji: '🥴', label: 'Tipsy', color: 0xFEE75C };
  if (bac < 0.10) return { emoji: '😵‍💫', label: 'Drunk', color: 0xED4245 };
  if (bac < 0.15) return { emoji: '🤢', label: 'Very drunk', color: 0xC41E3A };
  return { emoji: '🚑', label: 'Danger zone', color: 0x000000 };
}

async function getDrunkAssessment(beers, timeRange) {
  try {
    const systemPrompt = `You are a health assistant providing brief, factual alcohol consumption assessments.
    Be concise and serious. No jokes. Focus on health implications.
    Keep responses under 100 characters.`;

    const userPrompt = `User has consumed ${beers} beer(s) over ${timeRange}.
    Assess this briefly without jokes. Focus on health impact.`;

    return await llmService.generateCompletion(systemPrompt, userPrompt);
  } catch (e) {
    return null;
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('beer')
    .setDescription('Track your beer consumption with adaptive tolerance tracking')
    .addSubcommand(subcommand =>
      subcommand
        .setName('setup')
        .setDescription('Set up your profile (age, height, weight, tolerance)')
        .addIntegerOption(option =>
          option.setName('age')
            .setDescription('Your age')
            .setRequired(true)
            .setMinValue(16)
            .setMaxValue(120))
        .addIntegerOption(option =>
          option.setName('height_cm')
            .setDescription('Height in cm (or use height_feet)')
            .setRequired(false)
            .setMinValue(100)
            .setMaxValue(250))
        .addIntegerOption(option =>
          option.setName('height_feet')
            .setDescription('Height in feet')
            .setRequired(false)
            .setMinValue(3)
            .setMaxValue(8))
        .addIntegerOption(option =>
          option.setName('height_inches')
            .setDescription('Height in inches (use with height_feet)')
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(11))
        .addIntegerOption(option =>
          option.setName('weight')
            .setDescription('Weight in kg (for BAC calculation, optional)')
            .setRequired(false)
            .setMinValue(30)
            .setMaxValue(200))
        .addStringOption(option =>
          option.setName('tolerance')
            .setDescription('Your tolerance level (updates over time)')
            .setRequired(false)
            .addChoices(
              { name: 'Low (1-2 beers)', value: 'low' },
              { name: 'Medium (3-4 beers)', value: 'medium' },
              { name: 'High (5-7 beers)', value: 'high' }
            )))
    .addSubcommand(subcommand =>
      subcommand
        .setName('tolerance')
        .setDescription('View your alcohol tolerance estimate'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('log')
        .setDescription('Log a beer')
        .addStringOption(option =>
          option.setName('date')
            .setDescription('Date (YYYY-MM-DD) or "today"/"yesterday". Leave empty for now.')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('backfill')
            .setDescription('Backfill multiple days, e.g., "1,2,3" for past 3 days')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('View your drinking stats'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('leaderboard')
        .setDescription('View weekly beer leaderboard')
        .addStringOption(option =>
          option.setName('sort')
            .setDescription('Sort by beer count or BAC level')
            .setRequired(false)
            .addChoices(
              { name: 'Most Beers', value: 'beers' },
              { name: 'Highest BAC', value: 'bac' },
              { name: 'Most Active Days', value: 'days' },
              { name: 'Longest Sober Streak', value: 'sober' }
            ))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    if (subcommand === 'setup') {
      const age = interaction.options.getInteger('age');
      const heightCm = interaction.options.getInteger('height_cm');
      const heightFeet = interaction.options.getInteger('height_feet');
      const heightInches = interaction.options.getInteger('height_inches');
      const weight = interaction.options.getInteger('weight');
      const tolerance = interaction.options.getString('tolerance');

      if (age < 16) {
        return interaction.reply({
          content: '❌ You must be at least 16 years old to use this feature',
          ephemeral: true
        });
      }

      const { BeerModel } = await import('../database/models.js');

      let height = null;
      if (heightCm) {
        height = heightCm;
      } else if (heightFeet && heightInches !== null) {
        height = convertFeetInchesToCm(heightFeet, heightInches);
      }

      let toleranceBeers = null;
      if (tolerance && TOLERANCE_LEVELS[tolerance]) {
        toleranceBeers = TOLERANCE_LEVELS[tolerance].beers;
      }

      BeerModel.upsertProfile(userId, age, height, weight || null);

      if (toleranceBeers) {
        BeerModel.updateTolerance(userId, toleranceBeers, 0.5);
      }

      const heightText = height ? `${height}cm` : 'not set';
      const weightText = weight ? `${weight}kg` : 'not set';
      const toleranceText = tolerance ? `${TOLERANCE_LEVELS[tolerance].label}` : 'not set (will adapt over time)';

      await interaction.reply({
        content: `✅ **Profile Updated**\n\nAge: ${age}\nHeight: ${heightText} 🔒 (private)\nWeight: ${weightText} 🔒 (private)\nTolerance: ${toleranceText}\n\n💡 Your tolerance will adapt over time based on your drinking patterns!`,
        ephemeral: true
      });
    }

    else if (subcommand === 'tolerance') {
      const { BeerModel } = await import('../database/models.js');
      const profile = await getOrCreateProfile(userId);

      if (!profile) {
        return interaction.reply({
          content: '❌ Please set up your profile first with `/beer setup`',
          ephemeral: true
        });
      }

      const adaptiveTolerance = await calculateAdaptiveTolerance(userId, guildId);

      let description = '';

      if (profile.tolerance_beers) {
        const confidencePercent = Math.round((profile.tolerance_confidence || 0) * 100);
        description += `**Base Tolerance:** ~${profile.tolerance_beers} beers (${confidencePercent}% confidence)\n\n`;
      }

      if (adaptiveTolerance) {
        const adaptiveConfidencePercent = Math.round(adaptiveTolerance.tolerance_confidence * 100);
        description += `**Adaptive Estimate:** ${adaptiveTolerance.tolerance_beers} beers (${adaptiveConfidencePercent}% confidence)\nBased on ${adaptiveTolerance.total_sessions} sessions over ${adaptiveTolerance.drinking_days} days\n\n`;
      }

      if (!profile.tolerance_beers && !adaptiveTolerance) {
        description += 'ℹ️ Log some beers and system will learn your tolerance over time!\n\n';
      }

      description += '**Tolerance Levels:**\n';
      description += '• Low: 1-2 beers (lightweight)\n';
      description += '• Medium: 3-4 beers (average)\n';
      description += '• High: 5-7 beers (high tolerance)\n\n';
      description += '💡 Your tolerance updates daily as you log more data!';

      await interaction.reply({
        content: `🍺 **Your Tolerance**\n\n${description}`,
        ephemeral: true
      });
    }

    else if (subcommand === 'log') {
      const { BeerModel } = await import('../database/models.js');
      const profile = await getOrCreateProfile(userId);

      const dateInput = interaction.options.getString('date');
      const backfillInput = interaction.options.getString('backfill');
      const now = new Date();

      let datesToLog = [];
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      if (backfillInput) {
        const days = backfillInput.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d) && d >= 1 && d <= 14);
        if (days.length === 0) {
          return interaction.reply({ content: '❌ Invalid backfill format. Use: "1,2,3" for past 3 days', ephemeral: true });
        }

        for (const day of days) {
          const date = new Date(now.getTime() - day * 24 * 60 * 60 * 1000);
          if (date >= twoWeeksAgo) {
            datesToLog.push(new Date(date.toISOString().split('T')[0]));
          }
        }
      } else if (dateInput) {
        const inputLower = dateInput.toLowerCase();
        let targetDate;

        if (inputLower === 'today' || inputLower === 'now') {
          targetDate = new Date(now.toISOString().split('T')[0]);
        } else if (inputLower === 'yesterday') {
          targetDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          targetDate = new Date(targetDate.toISOString().split('T')[0]);
        } else {
          targetDate = new Date(dateInput);
        }

        if (isNaN(targetDate.getTime())) {
          return interaction.reply({ content: '❌ Invalid date format. Use YYYY-MM-DD, "today", or "yesterday"', ephemeral: true });
        }

        if (targetDate < twoWeeksAgo) {
          return interaction.reply({ content: '❌ Cannot log beers more than 2 weeks in the past', ephemeral: true });
        }

        targetDate = new Date(targetDate.toISOString().split('T')[0]);
        datesToLog.push(targetDate);
      } else {
        datesToLog.push(new Date(now.toISOString().split('T')[0]));
      }

      for (const date of datesToLog) {
        BeerModel.logBeer(userId, guildId, date);
        BeerModel.recordDrinkingSession(userId, guildId, date, 1);
      }

      BeerModel.incrementActivityStreak(userId);

      const dateStr = datesToLog.length === 1
        ? `<t:${Math.floor(datesToLog[0].getTime() / 1000)}:D>`
        : `${datesToLog.length} days`;

      await interaction.reply(`🍺 **Beer Logged!**\n\n+${datesToLog.length} beer(s) for ${dateStr}\n📊 Your tolerance is being updated...`);
    }

    else if (subcommand === 'status') {
      const { BeerModel } = await import('../database/models.js');
      const profile = await getOrCreateProfile(userId);
      const now = new Date();

      const today = new Date(now.toISOString().split('T')[0]);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const todayBeers = BeerModel.getBeerCount(userId, guildId, today, now);
      const weekBeers = BeerModel.getBeerCount(userId, guildId, weekAgo, now);
      const monthBeers = BeerModel.getBeerCount(userId, guildId, monthAgo, now);
      const allTime = BeerModel.getBeerCount(userId, guildId);

      const recentLogs = BeerModel.getRecentBeers(userId, guildId, 10);
      const recentDays = new Set(recentLogs.map(log => log.date.split('T')[0])).size;

      const soberStreak = BeerModel.getSoberStreak(userId, guildId);

      let bacLevel = null;
      let bacAssessment = null;
      let moreToDrunk = null;
      let toleranceInfo = '';

      if (profile && profile.weight) {
        const hoursSinceFirst = Math.min(24, (now.getTime() - new Date(today).getTime()) / (1000 * 60 * 60));
        bacLevel = await calculateBAC(todayBeers, profile.weight, hoursSinceFirst);

        if (bacLevel !== null) {
          const beersTo08 = Math.max(0, Math.ceil((0.08 * profile.weight * WIDMARK_RATIO) / BEER_ALCOHOL_GRAMS));
          moreToDrunk = Math.max(0, beersTo08 - todayBeers);

          const timeRange = todayBeers > 0 ? 'today' : 'recently';
          bacAssessment = await getDrunkAssessment(todayBeers, timeRange);
        }
      }

      const adaptiveTolerance = await calculateAdaptiveTolerance(userId, guildId);

      if (adaptiveTolerance) {
        const confidencePercent = Math.round(adaptiveTolerance.tolerance_confidence * 100);
        const beersRemaining = Math.max(0, Math.floor(adaptiveTolerance.tolerance_beers - todayBeers));
        toleranceInfo = `${adaptiveTolerance.tolerance_beers} beers (${confidencePercent}%)\n~${beersRemaining} to your limit`;
      } else if (profile && profile.tolerance_beers) {
        const confidencePercent = Math.round((profile.tolerance_confidence || 0) * 100);
        const beersRemaining = Math.max(0, Math.floor(profile.tolerance_beers - todayBeers));
        toleranceInfo = `${profile.tolerance_beers} beers (${confidencePercent}%)\n~${beersRemaining} to your limit`;
      } else {
        toleranceInfo = 'Log more beers to estimate';
      }

      const level = getBACLevel(bacLevel);

      const embed = new EmbedBuilder()
        .setTitle('🍺 Your Drinking Stats')
        .setColor(level.color)
        .addFields(
          { name: 'Today', value: `${todayBeers} 🍺`, inline: true },
          { name: 'This Week', value: `${weekBeers} 🍺`, inline: true },
          { name: 'This Month', value: `${monthBeers} 🍺`, inline: true },
          { name: 'All Time', value: `${allTime} 🍺`, inline: true },
          { name: 'Recent Activity', value: `${recentDays} days drinking`, inline: true },
          { name: 'Sober Streak', value: `${soberStreak} days`, inline: true }
        )
        .setTimestamp();

      if (profile) {
        embed.addFields({ name: 'Age', value: `${profile.age}`, inline: true });
      }

      embed.addFields({ name: '📊 Estimated Tolerance', value: toleranceInfo, inline: false });

      if (bacLevel !== null) {
        embed.addFields(
          { name: 'Current BAC Estimate', value: `${bacLevel.toFixed(3)}% ${level.emoji}`, inline: false },
          { name: 'Level', value: `${level.label}`, inline: true }
        );

        if (moreToDrunk > 0) {
          embed.addFields({ name: 'Beers to 0.08% BAC', value: `~${moreToDrunk} more`, inline: true });
        }

        if (bacAssessment) {
          embed.addFields({ name: 'Health Note', value: bacAssessment, inline: false });
        }
      } else {
        embed.addFields({
          name: '💡 Set Height/Weight',
          value: 'Use `/beer setup` with height/weight to get BAC estimates',
          inline: false
        });
      }

      embed.addFields({ name: '💡', value: 'Your tolerance adapts daily based on your drinking patterns!', inline: false });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    else if (subcommand === 'leaderboard') {
      const { BeerModel } = await import('../database/models.js');
      const sortBy = interaction.options.getString('sort') || 'beers';

      const now = new Date();
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      let entries = BeerModel.getWeeklyLeaderboardAll(guildId, weekStart, now);

      for (const entry of entries) {
        entry.sober_streak = BeerModel.getSoberStreak(entry.user_id, guildId);
      }

      if (sortBy === 'bac') {
        entries = entries.filter(e => e.bac_estimate !== null);
      }

      entries.sort((a, b) => {
        if (sortBy === 'beers') return b.beer_count - a.beer_count;
        if (sortBy === 'bac') return (b.bac_estimate || 0) - (a.bac_estimate || 0);
        if (sortBy === 'days') return b.drinking_days - a.drinking_days;
        if (sortBy === 'sober') return b.sober_streak - a.sober_streak;
        return 0;
      });

      entries = entries.slice(0, 10);

      if (entries.length === 0) {
        return interaction.reply('🍺 No beers logged this week yet! Be the first!');
      }

      const medalEmojis = ['🥇', '🥈', '🥉'];
      const rankEmojis = ['🏅', '🎖️', '⭐', '💫', '🌟', '✨', '🎯', '🔥', '💪', '🍻'];

      let description = '';

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const rankEmoji = i < 3 ? medalEmojis[i] : rankEmojis[i - 3] || '🍺';
        const username = await interaction.client.users.fetch(entry.user_id).then(u => u.username).catch(() => 'Unknown');

        let extraInfo = '';
        if (sortBy === 'beers') {
          extraInfo = `${entry.beer_count} 🍺`;
        } else if (sortBy === 'bac') {
          const level = getBACLevel(entry.bac_estimate);
          extraInfo = entry.beer_count > 0 ? `${entry.bac_estimate?.toFixed(3)}% ${level.emoji}` : 'Sober 🧘';
        } else if (sortBy === 'days') {
          extraInfo = `${entry.drinking_days} days`;
        } else if (sortBy === 'sober') {
          extraInfo = `${entry.sober_streak} days 🧘`;
        }

        description += `${rankEmoji} **${username}** — ${extraInfo}\n`;
      }

      const sortLabels = {
        beers: 'Most Beers',
        bac: 'Highest BAC',
        days: 'Most Active Days',
        sober: 'Longest Sober Streak'
      };

      const embed = new EmbedBuilder()
        .setTitle(`🍺 Weekly Leaderboard — ${sortLabels[sortBy]}`)
        .setDescription(description)
        .setColor(0xF1C40F)
        .setFooter({ text: 'Your data is private! Only beer counts and BAC estimates are shown. Tolerance adapts daily!' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  },

  async executeText(message, args) {
    const { BeerModel } = await import('../database/models.js');
    const userId = message.author.id;
    const guildId = message.guildId;
    const content = args.join(' ').toLowerCase();

    if (content.includes('setup') || content.includes('profile')) {
      const ageMatch = content.match(/age[:\s]*(\d+)/i);
      const heightMatch = content.match(/height[:\s]*(\d+)/i);
      const weightMatch = content.match(/weight[:\s]*(\d+)/i);

      if (!ageMatch) {
        return message.reply('Usage: `!beer setup age:25 height:180 weight:75` (height/weight optional)');
      }

      const age = parseInt(ageMatch[1]);
      const height = heightMatch ? parseInt(heightMatch[1]) : null;
      const weight = weightMatch ? parseInt(weightMatch[1]) : null;

      if (age < 16) {
        return message.reply('❌ You must be at least 16 years old to use this feature');
      }

      BeerModel.upsertProfile(userId, age, height, weight);

      const heightText = height ? `${height}cm` : 'not set';
      const weightText = weight ? `${weight}kg` : 'not set';

      return message.reply(`✅ **Profile Updated**\n\nAge: ${age}\nHeight: ${heightText} 🔒\nWeight: ${weightText} 🔒`);
    }

    if (content.includes('log')) {
      const profile = await getOrCreateProfile(userId);
      const now = new Date();

      const numberMatch = content.match(/(\d+)/);
      const count = numberMatch ? Math.min(parseInt(numberMatch[1]), 14) : 1;

      const today = new Date(now.toISOString().split('T')[0]);

      for (let i = 0; i < count; i++) {
        BeerModel.logBeer(userId, guildId, today);
      }

      BeerModel.recordDrinkingSession(userId, guildId, today, 1);
      BeerModel.incrementActivityStreak(userId);

      return message.reply(`🍺 **Beer Logged!**\n\n+${count} beer(s) for today`);
    }

    if (content.includes('status') || content.includes('stats')) {
      const { BeerModel } = await import('../database/models.js');
      const profile = await getOrCreateProfile(userId);
      const now = new Date();

      const today = new Date(now.toISOString().split('T')[0]);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const todayBeers = BeerModel.getBeerCount(userId, guildId, today, now);
      const weekBeers = BeerModel.getBeerCount(userId, guildId, weekAgo, now);
      const monthBeers = BeerModel.getBeerCount(userId, guildId, monthAgo, now);
      const allTime = BeerModel.getBeerCount(userId, guildId);

      let bacText = '';
      if (profile && profile.weight) {
        const hoursSinceFirst = 2;
        const bacLevel = await calculateBAC(todayBeers, profile.weight, hoursSinceFirst);

        if (bacLevel !== null) {
          const level = getBACLevel(bacLevel);
          bacText = `\n📊 BAC Estimate: ${bacLevel.toFixed(3)}% (${level.label}) ${level.emoji}`;
        }
      }

      return message.reply(`🍺 **Your Stats**\n\nToday: ${todayBeers} 🍺\nThis Week: ${weekBeers} 🍺\nThis Month: ${monthBeers} 🍺\nAll Time: ${allTime} 🍺${bacText}`);
    }

    if (content.includes('leaderboard') || content.includes('lb')) {
      const now = new Date();
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const entries = BeerModel.getWeeklyLeaderboardAll(guildId, weekStart, now);

      if (entries.length === 0) {
        return message.reply('🍺 No beers logged this week yet!');
      }

      entries.sort((a, b) => b.beer_count - a.beer_count);
      entries = entries.slice(0, 5);

      const medalEmojis = ['🥇', '🥈', '🥉'];
      let description = '';

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const rankEmoji = i < 3 ? medalEmojis[i] : '🍺';
        const username = await message.client.users.fetch(entry.user_id).then(u => u.username).catch(() => 'Unknown');
        description += `${rankEmoji} **${username}** — ${entry.beer_count} 🍺\n`;
      }

      return message.reply(`🍺 **Weekly Leaderboard**\n\n${description}`);
    }

    message.reply('Usage: `!beer setup`, `!beer log [number]`, `!beer status`, `!beer leaderboard`');
  }
};
