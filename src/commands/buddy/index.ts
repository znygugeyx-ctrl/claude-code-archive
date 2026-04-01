import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { roll, companionUserId, getCompanion } from '../../buddy/companion.js'
import { renderSprite } from '../../buddy/sprites.js'
import { RARITY_STARS } from '../../buddy/types.js'
import type { Species } from '../../buddy/types.js'

// Name pools per species (5 names each)
const NAMES: Record<Species, string[]> = {
  duck: ['Quackers', 'Waddles', 'Sir Flaps', 'Duchess', 'Puddles'],
  goose: ['Gerald', 'Honksworth', 'Gretchen', 'Baron Honk', 'Goosifer'],
  blob: ['Blobby', 'Gloop', 'Squelch', 'Wiggles', 'Amorphia'],
  cat: ['Mittens', 'Noodle', 'Biscuit', 'Chairman Meow', 'Socks'],
  dragon: ['Ember', 'Scales', 'Cinders', 'Hype', 'Smoldra'],
  octopus: ['Inky', 'Tentacles', 'Splat', 'Cthulette', 'Squishy'],
  owl: ['Hootsworth', 'Blinky', 'Professor Hoot', 'Athena', 'Wiskers'],
  penguin: ['Wadsworth', 'Tux', 'Pebbles', 'Admiral Freeze', 'Flipper'],
  turtle: ['Sheldon', 'Pebble', 'Slowpoke', 'Zenith', 'Mossy'],
  snail: ['Speedy', 'Coil', 'Slimbert', 'Shellton', 'Tracey'],
  ghost: ['Boo', 'Whisper', 'Spooksworth', 'Ethereal', 'Phast'],
  axolotl: ['Axie', 'Frilly', 'Gills', 'Wobble', 'Salamandria'],
  capybara: ['Cappy', 'Chillsworth', 'Rodentia', 'Zen', 'Capitan'],
  cactus: ['Spike', 'Prickles', 'Thornia', 'Pokey', 'Desert'],
  robot: ['Unit-7', 'Bleep', 'Clanky', 'Servo', 'Beepsworth'],
  rabbit: ['Thumper', 'Hopscotch', 'Bun Bun', 'Fluffy', 'Nibbles'],
  mushroom: ['Spore', 'Fungi', 'Cap', 'Mycelium', 'Porcini'],
  chonk: ['Chonksworth', 'Bigsby', 'Large', 'Absolute Unit', 'Thicc'],
}

// Personality pools per species (5 personalities each)
const PERSONALITIES: Record<Species, string[]> = {
  duck: ['cheerful dabbler', 'dramatic quacker', 'philosophical waddler', 'competitive splasher', 'serene floater'],
  goose: ['chaotic neutral', 'relentlessly honking', 'suspiciously calm', 'aggressively friendly', 'majestic menace'],
  blob: ['existentially curious', 'pleasantly amorphous', 'quietly wobbling', 'enthusiastically shapeless', 'deeply squishy'],
  cat: ['condescending genius', 'aloof observer', 'secretly caring', 'perpetually unimpressed', 'mysteriously wise'],
  dragon: ['enthusiastically fiery', 'surprisingly gentle', 'hoard-obsessed', 'dramatically heroic', 'cozy pyromaniac'],
  octopus: ['eight-armed multitasker', 'ink-slinging philosopher', 'color-shifting enigma', 'deep-sea dreamer', 'tentacularly helpful'],
  owl: ['perpetually judging', 'wisely silent', 'dramatically nocturnal', 'academically pedantic', 'mysteriously blinking'],
  penguin: ['formally dressed anarchist', 'cheerfully waddling', 'ice-cold strategist', 'colony-minded team player', 'elegantly sliding'],
  turtle: ['profoundly patient', 'shell-shocked philosopher', 'slow-burn innovator', 'zen master', 'ancient and knowing'],
  snail: ['optimistically slow', 'trail-blazing minimalist', 'shell enthusiast', 'moisture-forward thinker', 'surprisingly fast when motivated'],
  ghost: ['cheerfully haunting', 'existentially confused', 'dramatically transparent', 'warmly spectral', 'nostalgically ethereal'],
  axolotl: ['regeneratively optimistic', 'gilly philosophical', 'permanently smiling', 'aquatically zen', 'feathery and thoughtful'],
  capybara: ['impossibly chill', 'socially magnetic', 'grass-based philosopher', 'universally beloved', 'serenely massive'],
  cactus: ['prickly but caring', 'desert-hardened stoic', 'water-efficient optimist', 'spiny encourager', 'drily humorous'],
  robot: ['efficiently enthusiastic', 'logically emotional', 'debugging-focused', 'protocol-following rebel', 'beeping thoughtfully'],
  rabbit: ['energetically thumping', 'fluffy nihilist', 'hop-to-it pragmatist', 'carrot-motivated achiever', 'ear-wiggling optimist'],
  mushroom: ['spore-spreading visionary', 'mycelium-networked', 'cap-wearing philosopher', 'quietly decomposing ideas', 'fungi-forward thinker'],
  chonk: ['magnificently large', 'gravitationally stable', 'impressively round', 'aggressively cuddly', 'monumentally cozy'],
}

function pickByIndex<T>(arr: T[], index: number): T {
  return arr[Math.abs(index) % arr.length]!
}

export async function buddyCommand(args: string[]): Promise<string> {
  const subcommand = args[0]?.toLowerCase()

  // /buddy pet
  if (subcommand === 'pet') {
    const companion = getCompanion()
    if (!companion) {
      return "You don't have a companion yet! Run /buddy to hatch one."
    }
    return [
      `You pet ${companion.name}... 🐾`,
      '',
      '  ♡  ♡  ♡',
      ` ${companion.name} loves the attention!`,
    ].join('\n')
  }

  // Check if companion already exists
  const existing = getCompanion()

  if (existing) {
    // Show companion card
    const sprite = renderSprite(existing, 0)
    const stars = RARITY_STARS[existing.rarity]
    const statLines = Object.entries(existing.stats).map(
      ([k, v]) => `  ${k.padEnd(10)} ${'█'.repeat(Math.floor((v as number) / 10))}${'░'.repeat(10 - Math.floor((v as number) / 10))} ${v}`,
    )
    return [
      ...sprite,
      '',
      `  ${existing.name}  ${stars}  [${existing.rarity.toUpperCase()}]`,
      `  ${existing.species}  •  ${existing.personality}`,
      `  Hatched: ${new Date(existing.hatchedAt).toLocaleDateString()}`,
      '',
      ...statLines,
      '',
      'Tip: /buddy pet to show some love',
    ].join('\n')
  }

  // Hatch a new companion
  const userId = companionUserId()
  const { bones, inspirationSeed } = roll(userId)

  const speciesNames = NAMES[bones.species]
  const speciesPersonalities = PERSONALITIES[bones.species]
  const name = pickByIndex(speciesNames, inspirationSeed)
  const personality = pickByIndex(speciesPersonalities, inspirationSeed + 1)

  saveGlobalConfig((prev) => ({
    ...prev,
    companion: {
      name,
      personality,
      hatchedAt: Date.now(),
    },
  }))

  const stars = RARITY_STARS[bones.rarity]
  const sprite = renderSprite(bones, 0)

  return [
    '🥚  *crack*  🐣',
    '',
    ...sprite,
    '',
    `  A wild companion has hatched!`,
    `  ${name}  ${stars}  [${bones.rarity.toUpperCase()}]`,
    `  Species: ${bones.species}`,
    `  Personality: ${personality}`,
    '',
    'Run /buddy to see your companion anytime.',
  ].join('\n')
}

export default buddyCommand
