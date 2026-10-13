import type { Personality } from "../shared/types";

/**
 * Local, scripted dialogue used when AI is disabled or not configured.
 * Responses produced here are always labeled "offline" — they are never
 * presented as coming from Claude.
 */

type Rng = () => number;

const FACTS = [
  "Octopuses have three hearts and blue blood. Overachievers.",
  "Honey never spoils — archaeologists have found edible honey in ancient Egyptian tombs.",
  "A group of flamingos is called a 'flamboyance'.",
  "The first computer 'bug' was an actual moth found in a relay in 1947.",
  "Bananas are berries, but strawberries aren't. Botany is wild.",
  "Sea otters hold hands while they sleep so they don't drift apart.",
  "The Eiffel Tower grows about 15 cm taller in summer because the metal expands.",
  "Wombat poop is cube-shaped. Nature has range.",
  "A day on Venus is longer than a year on Venus.",
  "Ctrl+Shift+T reopens the last closed browser tab. You're welcome.",
  "Taking a short break every hour helps your eyes and your focus. Stretch time?",
  "The word 'robot' comes from the Czech 'robota', meaning forced labor.",
];

const GREETINGS: Record<Personality, string[]> = {
  playful: ["Hey hey! 👋 What's up?", "Oh hi! I was just practicing my walk.", "Hello, friend! Need anything?"],
  calm: ["Hello. It's nice to see you.", "Hi there. How's your day going?"],
  concise: ["Hi!", "Hello!"],
};

const IDLE_COMMENTS = [
  "Just stretching my legs. Don't mind me!",
  "Remember to drink some water. 💧",
  "If you need me, double-click me!",
  "Psst — right-click me for options.",
  "Is it snack o'clock yet?",
  "You're doing great, by the way.",
];

const HELP =
  "Here's what I can do:\n" +
  "• Wander around your desktop (toggle it from my right-click menu)\n" +
  "• Chat with you — with a Claude API key I can answer questions, brainstorm, and explain things\n" +
  "• Remember things you approve in Settings → Memory\n" +
  "• Tell you fun facts\n" +
  "Right-click me or use the tray icon for everything else.";

const DEFAULTS = [
  "I'm in offline mode, so I can only do simple chit-chat. Add a Claude API key in Settings → AI and I can really help!",
  "Ooh, good question! I'd need my Claude connection for that one — you can set it up in Settings → AI.",
  "Offline me only knows a few tricks: fun facts, a bit of help, and moral support. 🧡",
];

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng() * items.length) % items.length] as T;
}

export class OfflineBrain {
  constructor(private readonly rng: Rng = Math.random) {}

  fact(): string {
    return `Fun fact: ${pick(FACTS, this.rng)}`;
  }

  help(): string {
    return HELP;
  }

  greeting(personality: Personality): string {
    return pick(GREETINGS[personality], this.rng);
  }

  idleComment(): string {
    return pick(IDLE_COMMENTS, this.rng);
  }

  reply(text: string, personality: Personality, name: string): string {
    const t = text.toLowerCase();
    if (/\b(hi|hello|hey|yo|howdy|good (morning|afternoon|evening))\b/.test(t)) return this.greeting(personality);
    if (/\b(help|what can you do|commands?|features?)\b/.test(t)) return HELP;
    if (/\b(fact|tell me something|bored|fun)\b/.test(t)) return this.fact();
    if (/\b(thanks|thank you|thx|ty)\b/.test(t)) return "Anytime! 🧡";
    if (/\b(your name|who are you)\b/.test(t)) {
      return `I'm ${name}, your desktop buddy! Right now I'm running in offline mode.`;
    }
    if (/\b(joke)\b/.test(t)) return "Why did the developer go broke? Because they used up all their cache. 🥁";
    if (/\b(bye|goodbye|see you|good night)\b/.test(t)) return "See you later! I'll be right here.";
    return pick(DEFAULTS, this.rng);
  }
}
